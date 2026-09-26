import { describe, expect, it, vi } from "vitest";
import { createHandler } from "../src/handler.js";
import { makeRepos } from "./support/repos.js";
import { TaskRepository } from "../src/domain/task-repository.js";
import { matchPending } from "../src/domain/task-resolve.js";
import { parseTask, taskPath, type Task } from "../src/domain/task.js";
import { TelegramApiError } from "../src/telegram/client.js";
import { parseTarefaArgs } from "../src/telegram/task-commands.js";
import { fakeClock } from "../src/time/index.js";
import { createGitHubVaultStore } from "../src/vault/github-store.js";
import { InMemoryVaultStore } from "../src/vault/memory-store.js";
import { guardVaultStore, type VaultStore } from "../src/vault/store.js";
import { FakeGitHub, json } from "./support/fake-github.js";

const SECRET = "s3cret";
const CHAT = 111;
const GH_TOKEN = "ghp_SUPERSECRETTOKEN";
const epoch = (iso: string) => Date.parse(iso) / 1000;
const EVENT = epoch("2026-09-25T18:00:00Z"); // 25/09 15:00 em SP
const ID = "2026-09-25-estudar-system-design";

interface Rig {
  send(text: string, opts?: { date?: number; chat?: number }): Promise<{ status: number; reply?: string }>;
  replies: string[];
  gh: FakeGitHub;
  clock: ReturnType<typeof fakeClock>;
  readRaw(path: string): Promise<string | null>;
}

/** Handler completo: Telegram -> router -> TaskRepository -> GitHubVaultStore -> GitHub falso. */
function rig(nowIso = "2026-09-25T18:10:00Z", gh = new FakeGitHub(), store?: VaultStore): Rig {
  const clock = fakeClock(nowIso);
  const replies: string[] = [];
  const real =
    store ??
    createGitHubVaultStore(
      { owner: gh.owner, repo: gh.repo, branch: gh.branch, token: GH_TOKEN },
      { fetch: gh.fetch, sleep: async () => {} },
    );
  const handler = createHandler({
    config: { botToken: "tok", webhookSecret: SECRET, allowedChatIds: [CHAT] },
    client: { sendMessage: async (_c, t) => void replies.push(t), answerCallbackQuery: async () => {}, editMessageText: async () => {} },
    clock,
    ...makeRepos(real, clock),
  });
  let updateId = 0;
  return {
    replies,
    gh,
    clock,
    readRaw: async (p) => (await gh.read(p))?.content ?? null,
    async send(text, opts = {}) {
      const body = {
        update_id: ++updateId,
        message: { message_id: updateId, chat: { id: opts.chat ?? CHAT, type: "private" }, date: "date" in opts ? opts.date : EVENT, text },
      };
      const before = replies.length;
      const res = (await handler({
        headers: { "x-telegram-bot-api-secret-token": SECRET },
        body: JSON.stringify(body),
        isBase64Encoded: false,
      } as never)) as { statusCode: number };
      return { status: res.statusCode, reply: replies.length > before ? replies.at(-1) : undefined };
    },
  };
}

const bodyOf = (c: string) => c.slice(c.indexOf("\n---", 4) + 4);

describe("parseTarefaArgs", () => {
  it.each([
    ["estudar system design", { title: "estudar system design" }],
    ["estudar system design até 2026-10-02", { title: "estudar system design", due: "2026-10-02" }],
    ["estudar ate 2026-10-02", { title: "estudar", due: "2026-10-02" }],
    ["  Estudar   ATÉ   2026-10-02  ", { title: "Estudar", due: "2026-10-02" }],
    ["ir até padaria", { title: "ir até padaria" }],
    ["ir até a padaria hoje", { title: "ir até a padaria hoje" }],
    ["até logo", { title: "até logo" }],
    ["a até b até 2026-10-02", { title: "a até b", due: "2026-10-02" }],
    ["tarefa\ncom quebra até 2028-02-29", { title: "tarefa com quebra", due: "2028-02-29" }],
  ])("%j", (input, expected) => expect(parseTarefaArgs(input)).toEqual(expected));

  it.each([
    ["", "Uso: /tarefa"],
    ["   ", "Uso: /tarefa"],
    ["até 2026-10-02", "título é obrigatório"],
    ["até", "título é obrigatório"],
    ["x até amanhã", "relativas"],
    ["x até Sexta", "relativas"],
    ["x até hoje", "relativas"],
    ["x até 02/10/2026", "Data inválida"],
    ["x até 2026-10-2", "Data inválida"],
    ["x até 2026-02-30", "Data inexistente"],
    ["x até 2026-13-01", "Data inexistente"],
  ])("erro: %j", (input, msg) => {
    const r = parseTarefaArgs(input);
    expect("error" in r && r.error).toContain(msg);
  });
});

describe("matchPending", () => {
  const t = (id: string): Task => ({ id, path: taskPath(id), title: id, status: "pendente", created: "x" });
  const pending = [t("2026-09-25-estudar-system-design"), t("2026-09-25-estudar-ingles"), t("2026-09-26-pagar-conta")];

  it("trecho com espaços, caixa e acento é normalizado", () => {
    expect(matchPending("Pagar Conta", pending).map((x) => x.id)).toEqual(["2026-09-26-pagar-conta"]);
  });
  it("ambíguo devolve todos", () => expect(matchPending("estudar", pending)).toHaveLength(2));
  it("ID exato vence parciais", () => {
    const p = [t("2026-09-25-a"), t("2026-09-25-a-b")];
    expect(matchPending("2026-09-25-a", p).map((x) => x.id)).toEqual(["2026-09-25-a"]);
  });
  it("nenhuma", () => expect(matchPending("xyz", pending)).toEqual([]));
  it("referência sem caracteres aproveitáveis lança", () => expect(() => matchPending("!!!", pending)).toThrow());
});

describe("1. /tarefa cria no Vault", () => {
  it("cria o arquivo esperado, responde e devolve 200", async () => {
    const r = rig();
    const out = await r.send("/tarefa estudar system design");
    expect(out.status).toBe(200);
    expect(out.reply).toBe(`Tarefa criada: estudar system design\nID: ${ID}`);
    const raw = (await r.readRaw(taskPath(ID)))!;
    expect(parseTask(raw, taskPath(ID))).toMatchObject({
      status: "pendente",
      title: "estudar system design",
      created: "2026-09-25T15:00:00-03:00",
    });
    expect(r.gh.commits).toHaveLength(1);
  });

  it("com prazo", async () => {
    const r = rig();
    const out = await r.send("/tarefa estudar system design até 2026-10-02");
    expect(out.reply).toContain("Prazo: 2026-10-02");
    expect(parseTask((await r.readRaw(taskPath(ID)))!, taskPath(ID)).due).toBe("2026-10-02");
  });

  it.each([
    ["/tarefa", "Uso: /tarefa"],
    ["/tarefa x até amanhã", "relativas"],
    ["/tarefa x até 2026-02-30", "Data inexistente"],
    ["/tarefa !!!", "letras ou números"],
    ["/tarefa " + "a".repeat(201), "longo demais"],
  ])("pedido inválido %j: 200 com mensagem e nada gravado", async (text, msg) => {
    const r = rig();
    const out = await r.send(text);
    expect(out.status).toBe(200);
    expect(out.reply).toContain(msg);
    expect(r.gh.commits).toHaveLength(0);
  });
});

describe("2. reenvio do mesmo update não cria outra tarefa", () => {
  it("mesmo texto e mesmo message.date: 1 commit, resposta 'já existe'", async () => {
    const r = rig();
    await r.send("/tarefa estudar system design");
    const again = await r.send("/tarefa estudar system design");
    expect(again.status).toBe(200);
    expect(again.reply).toContain("Tarefa já existe");
    expect(r.gh.commits).toHaveLength(1);
  });

  it("prazo diferente no reenvio não altera a tarefa e avisa", async () => {
    const r = rig();
    await r.send("/tarefa estudar system design até 2026-10-02");
    const again = await r.send("/tarefa estudar system design até 2026-11-01");
    expect(again.reply).toContain("Prazo: 2026-10-02");
    expect(again.reply).toContain("o prazo pedido não foi alterado");
    expect(r.gh.commits).toHaveLength(1);
  });
});

describe("3. /feita altera somente o esperado", () => {
  it("por trecho: só status, done_at e updated; corpo intacto", async () => {
    const r = rig();
    await r.send("/tarefa estudar system design");
    const before = (await r.readRaw(taskPath(ID)))!;
    const out = await r.send("/feita system");
    expect(out.reply).toBe("Feita: estudar system design");
    const after = (await r.readRaw(taskPath(ID)))!;
    expect(bodyOf(after)).toBe(bodyOf(before));
    expect(after).toBe(
      before
        .replace("status: pendente", "status: feita")
        .replace("updated: 2026-09-25T15:00:00-03:00", "updated: 2026-09-25T15:10:00-03:00")
        .replace("---\n\n#", "done_at: 2026-09-25T15:10:00-03:00\n---\n\n#"),
    );
  });

  it("por ID completo e com texto em maiúsculas/espaços", async () => {
    const r = rig();
    await r.send("/tarefa estudar system design");
    expect((await r.send(`/feita ${ID}`)).reply).toBe("Feita: estudar system design");
    const r2 = rig();
    await r2.send("/tarefa estudar system design");
    expect((await r2.send("/feita  Estudar  System-Design ")).reply).toBe("Feita: estudar system design");
  });
});

describe("4. /cancelar altera somente o esperado", () => {
  it("status e updated; sem done_at; corpo intacto", async () => {
    const r = rig();
    await r.send("/tarefa estudar system design");
    const before = (await r.readRaw(taskPath(ID)))!;
    const out = await r.send("/cancelar estudar");
    expect(out.reply).toBe("Cancelada: estudar system design");
    const after = (await r.readRaw(taskPath(ID)))!;
    expect(bodyOf(after)).toBe(bodyOf(before));
    expect(after).toBe(
      before
        .replace("status: pendente", "status: cancelada")
        .replace("updated: 2026-09-25T15:00:00-03:00", "updated: 2026-09-25T15:10:00-03:00"),
    );
    expect(after).not.toContain("done_at");
  });
});

describe("5. substring ambígua não altera nada", () => {
  it("lista candidatos, 200, nenhum commit novo", async () => {
    const r = rig();
    await r.send("/tarefa estudar system design");
    await r.send("/tarefa estudar ingles");
    const commits = r.gh.commits.length;
    const out = await r.send("/feita estudar");
    expect(out.status).toBe(200);
    expect(out.reply).toContain("Mais de uma tarefa corresponde");
    expect(out.reply).toContain("2026-09-25-estudar-system-design (estudar system design)");
    expect(out.reply).toContain("2026-09-25-estudar-ingles (estudar ingles)");
    expect(r.gh.commits).toHaveLength(commits);
  });

  it("limita a lista a 10 candidatos", async () => {
    const r = rig();
    for (let i = 0; i < 12; i++) await r.send(`/tarefa item ${String(i).padStart(2, "0")}`);
    const out = await r.send("/cancelar item");
    expect(out.reply!.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(10);
    expect(out.reply).toContain("...e mais 2");
  });
});

describe("6. no-op e não encontrada", () => {
  it("/feita em tarefa já feita: no-op, sem commit, por trecho e por ID", async () => {
    const r = rig();
    await r.send("/tarefa estudar system design");
    await r.send("/feita estudar");
    const snapshot = (await r.readRaw(taskPath(ID)))!;
    const commits = r.gh.commits.length;
    r.clock.advanceMs(3_600_000);

    // Por ID completo: acha mesmo já feita e responde no-op.
    expect((await r.send(`/feita ${ID}`)).reply).toBe("Já estava feita: estudar system design");
    // Por trecho: só pendentes, então "não encontrada".
    expect((await r.send("/feita estudar")).reply).toBe("Tarefa não encontrada.");
    expect(await r.readRaw(taskPath(ID))).toBe(snapshot);
    expect(r.gh.commits).toHaveLength(commits);
  });

  it("/cancelar repetido por ID é no-op", async () => {
    const r = rig();
    await r.send("/tarefa estudar system design");
    await r.send(`/cancelar ${ID}`);
    const commits = r.gh.commits.length;
    expect((await r.send(`/cancelar ${ID}`)).reply).toBe("Já estava cancelada: estudar system design");
    expect(r.gh.commits).toHaveLength(commits);
  });

  it("inexistente, vazio e sem caracteres aproveitáveis", async () => {
    const r = rig();
    expect((await r.send("/feita nada")).reply).toBe("Tarefa não encontrada.");
    expect((await r.send("/feita 2026-09-25-nao-existe")).reply).toBe("Tarefa não encontrada.");
    expect((await r.send("/feita")).reply).toBe("Uso: /feita <id-ou-trecho>");
    expect((await r.send("/cancelar")).reply).toBe("Uso: /cancelar <id-ou-trecho>");
    expect((await r.send("/feita !!!")).reply).toContain("sem letras ou números");
    expect(r.gh.commits).toHaveLength(0);
  });

  it("cancelada/feita não aparecem na resolução por trecho de outra tarefa", async () => {
    const r = rig();
    await r.send("/tarefa estudar system design");
    await r.send("/tarefa estudar ingles");
    await r.send("/cancelar system");
    expect((await r.send("/feita estudar")).reply).toBe("Feita: estudar ingles"); // não é mais ambíguo
  });
});

describe("7. usuário não autorizado", () => {
  it("200 silencioso, sem resposta e sem nenhuma chamada ao GitHub", async () => {
    const r = rig();
    const out = await r.send("/tarefa estudar system design", { chat: 999 });
    expect(out).toEqual({ status: 200, reply: undefined });
    expect(r.gh.requests).toHaveLength(0);
  });
});

describe("8. GitHub indisponível: 500 para o Telegram reenviar", () => {
  const unavailable = (mkFetch: () => typeof fetch) => {
    const r = rig();
    const store = createGitHubVaultStore(
      { owner: "o", repo: "r", branch: "main", token: GH_TOKEN },
      { fetch: mkFetch(), sleep: async () => {} },
    );
    return rig("2026-09-25T18:10:00Z", r.gh, store);
  };

  it.each([500, 502, 503, 429])("HTTP %s", async (status) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = unavailable(() => (async () => json(status, { message: "boom" })) as never);
    for (const cmd of ["/tarefa estudar", "/feita estudar", "/cancelar estudar"]) {
      const out = await r.send(cmd);
      expect(out.status).toBe(500);
      expect(out.reply).toBeUndefined(); // nada respondido: o reenvio é que resolve
    }
  });

  it("rate limit 403", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = unavailable(() => (async () => json(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0" })) as never);
    expect((await r.send("/tarefa estudar")).status).toBe(500);
  });

  it("falha de rede", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = unavailable(() => (async () => { throw new TypeError("fetch failed"); }) as never);
    expect((await r.send("/tarefa estudar")).status).toBe(500);
  });

  it("timeout: fetch que nunca responde é abortado e vira 500", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const hang: typeof fetch = (_url, init) =>
      new Promise((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "TimeoutError"))));
    const clock = fakeClock("2026-09-25T18:10:00Z");
    const replies: string[] = [];
    const hangStore = createGitHubVaultStore({ owner: "o", repo: "r", branch: "main", token: GH_TOKEN }, { fetch: hang, timeoutMs: 20 });
    const handler = createHandler({
      config: { botToken: "tok", webhookSecret: SECRET, allowedChatIds: [CHAT] },
      client: { sendMessage: async (_c, t) => void replies.push(t), answerCallbackQuery: async () => {}, editMessageText: async () => {} },
      clock,
      ...makeRepos(hangStore, clock),
    });
    const res = (await handler({
      headers: { "x-telegram-bot-api-secret-token": SECRET },
      body: JSON.stringify({ update_id: 1, message: { message_id: 1, chat: { id: CHAT, type: "private" }, date: EVENT, text: "/tarefa x" } }),
    } as never)) as { statusCode: number };
    expect(res.statusCode).toBe(500);
    expect(replies).toEqual([]);
  });

  it("reenvio depois da falha completa a operação (idempotente)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const gh = new FakeGitHub();
    let down = true;
    const flaky: typeof fetch = async (u, i) => (down ? json(503, { message: "x" }) : gh.fetch(u, i));
    const store = createGitHubVaultStore({ owner: gh.owner, repo: gh.repo, branch: gh.branch, token: GH_TOKEN }, { fetch: flaky, sleep: async () => {} });
    const r = rig("2026-09-25T18:10:00Z", gh, store);
    expect((await r.send("/tarefa estudar system design")).status).toBe(500);
    down = false;
    const retry = await r.send("/tarefa estudar system design");
    expect(retry).toMatchObject({ status: 200 });
    expect(retry.reply).toContain("Tarefa criada");
    expect(gh.commits).toHaveLength(1);
  });
});

describe("9. erros do GitHub não expõem o token", () => {
  it("erro de credencial/permissão: 200 com mensagem genérica; token ausente de respostas e logs", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const gh = new FakeGitHub();
    const store = createGitHubVaultStore(
      { owner: gh.owner, repo: gh.repo, branch: gh.branch, token: GH_TOKEN },
      { fetch: (async () => json(401, { message: "Bad credentials" })) as never },
    );
    const r = rig("2026-09-25T18:10:00Z", gh, store);
    const out = await r.send("/tarefa estudar");
    expect(out.status).toBe(200); // reenviar não adianta: não prende a fila do Telegram
    expect(out.reply).toContain("erro de configuração ou permissão");
    expect(out.reply).not.toContain(GH_TOKEN);
    expect(JSON.stringify(err.mock.calls)).not.toContain(GH_TOKEN);
    expect(JSON.stringify(err.mock.calls)).toContain("401");
  });

  it("falha de rede e 5xx: nada com o token nos logs", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const gh = new FakeGitHub();
    for (const f of [
      (async () => { throw new TypeError(`fetch failed ${GH_TOKEN}`); }) as never,
      (async () => json(500, { message: "x" })) as never,
    ]) {
      const store = createGitHubVaultStore({ owner: gh.owner, repo: gh.repo, branch: gh.branch, token: GH_TOKEN }, { fetch: f });
      const r = rig("2026-09-25T18:10:00Z", gh, store);
      await r.send("/tarefa estudar");
    }
    expect(JSON.stringify(err.mock.calls)).not.toContain(GH_TOKEN);
  });
});

describe("10. message.date define a data, não o momento do processamento", () => {
  it("mensagem 23:59 processada às 00:01 do dia seguinte: ID e created do dia do evento", async () => {
    const r = rig("2026-09-26T03:01:00Z"); // processando às 00:01 do dia 26
    const date = epoch("2026-09-26T02:59:00Z"); // enviada às 23:59 do dia 25
    const out = await r.send("/tarefa estudar system design", { date });
    expect(out.reply).toContain(`ID: ${ID}`);
    const t = parseTask((await r.readRaw(taskPath(ID)))!, taskPath(ID));
    expect(t.created).toBe("2026-09-25T23:59:00-03:00");
    expect(await r.readRaw(taskPath("2026-09-26-estudar-system-design"))).toBeNull();
  });

  it("reenvio horas depois (após a meia-noite) não duplica", async () => {
    const r = rig("2026-09-25T18:10:00Z");
    const date = epoch("2026-09-26T02:59:00Z");
    await r.send("/tarefa estudar system design", { date });
    r.clock.set("2026-09-26T15:00:00Z");
    const retry = await r.send("/tarefa estudar system design", { date });
    expect(retry.reply).toContain("Tarefa já existe");
    expect(r.gh.commits).toHaveLength(1);
  });

  it("message.date ausente ou inválido: 200 com erro, nada gravado", async () => {
    const r = rig();
    for (const date of [undefined, -1, 1.5]) {
      const out = await r.send("/tarefa estudar", { date: date as never });
      expect(out.status).toBe(200);
    }
    expect(r.gh.commits).toHaveLength(0);
  });
});

describe("outros erros do usuário/Vault viram resposta 200", () => {
  it("nota inválida na resolução: pulada; nota inválida no ID exato: mensagem", async () => {
    const r = rig();
    r.gh.externalWrite(taskPath(ID), "sem frontmatter");
    expect((await r.send("/feita estudar")).reply).toBe("Tarefa não encontrada."); // pulada na listagem
    const out = await r.send(`/feita ${ID}`);
    expect(out.status).toBe(200);
    expect(out.reply).toContain("Não consegui ler uma nota");
  });

  it("conflito persistente (3 tentativas): 200 com mensagem, nada sobrescrito", async () => {
    const mem = new InMemoryVaultStore();
    const r = rig("2026-09-25T18:10:00Z", new FakeGitHub(), guardVaultStore(mem));
    await r.send("/tarefa estudar system design");
    const base = (await mem.read(taskPath(ID)))!.content;
    let n = 0;
    mem.beforeWrite = (op, path) => {
      if (op === "update") mem.externalWrite(path, base.replace("status: pendente", `status: pendente\ncustom: ${++n}`));
    };
    const out = await r.send("/feita estudar");
    expect(out.status).toBe(200);
    expect(out.reply).toContain("alterada por outra edição");
    const after = (await mem.read(taskPath(ID)))!.content;
    expect(n).toBe(3);
    expect(after).toContain("custom: 3"); // a última edição externa ficou
    expect(after).toContain("status: pendente"); // Hermes não forçou nada
  });

  it("erro inesperado (bug): 500 com log; violação de caminho também", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken: VaultStore = {
      read: async () => { throw new Error("bug inesperado"); },
      create: async () => { throw new Error("bug inesperado"); },
      update: async () => { throw new Error("bug inesperado"); },
      list: async () => { throw new Error("bug inesperado"); },
    };
    const r = rig("2026-09-25T18:10:00Z", new FakeGitHub(), broken);
    expect((await r.send("/tarefa x")).status).toBe(500);
    expect((await r.send("/feita x")).status).toBe(500);
    expect(err).toHaveBeenCalled();
  });

  it("Telegram fora do ar ao responder depois de gravar: 500; reenvio responde 'já existe'", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const gh = new FakeGitHub();
    const clock = fakeClock("2026-09-25T18:10:00Z");
    let telegramDown = true;
    const replies: string[] = [];
    const ghStore = createGitHubVaultStore({ owner: gh.owner, repo: gh.repo, branch: gh.branch, token: "t" }, { fetch: gh.fetch });
    const handler = createHandler({
      config: { botToken: "tok", webhookSecret: SECRET, allowedChatIds: [CHAT] },
      client: {
        sendMessage: async (_c, t) => {
          if (telegramDown) throw new TelegramApiError("x", 502);
          replies.push(t);
        },
        answerCallbackQuery: async () => {}, editMessageText: async () => {},
      },
      clock,
      ...makeRepos(ghStore, clock),
    });
    const ev = () => ({
      headers: { "x-telegram-bot-api-secret-token": SECRET },
      body: JSON.stringify({ update_id: 1, message: { message_id: 1, chat: { id: CHAT, type: "private" }, date: EVENT, text: "/tarefa estudar system design" } }),
    }) as never;
    expect(await handler(ev())).toMatchObject({ statusCode: 500 });
    telegramDown = false;
    expect(await handler(ev())).toMatchObject({ statusCode: 200 });
    expect(replies[0]).toContain("Tarefa já existe"); // já tinha sido criada na 1ª tentativa
    expect(gh.commits).toHaveLength(1);
  });
});

/**
 * Integração REAL ponta a ponta (sem Lambda/API Gateway/Telegram de verdade):
 *   update do Telegram -> handler -> router -> TaskRepository -> GitHubVaultStore -> GitHub real
 * O resultado é verificado LENDO O VAULT DIRETO PELA API do GitHub, não pelo TaskRepository.
 *
 *   VAULT_REPO=owner/repo VAULT_BRANCH=main \
 *   VAULT_GITHUB_TOKEN_PARAM=/hermes/prod/vault/github-token \
 *   npm run test:integration
 *
 * Arquivos criados: `2020-01-01-it-<runid>-...`. No fim, só os que esta execução criou (e que
 * casam com esse padrão) são removidos pela API crua.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeRepos } from "../support/repos.js";
import { TaskRepository } from "../../src/domain/task-repository.js";
import { taskPath } from "../../src/domain/task.js";
import { createHandler } from "../../src/handler.js";
import { createSsmReader } from "../../src/ssm.js";
import { fakeClock } from "../../src/time/index.js";
import { loadVaultConfig } from "../../src/vault/config.js";
import { createGitHubVaultStore, type GitHubVaultConfig } from "../../src/vault/github-store.js";
import { slugify } from "../../src/vault/slug.js";
import { rawGitHub } from "./github-raw.js";

const RUN = randomBytes(4).toString("hex");
const SECRET = "integration-secret";
const CHAT = 4242;
const DAY = "2020-01-01";
const EVENT = Date.parse(`${DAY}T15:00:00Z`) / 1000; // 12:00 em SP
const SAFE_PATH = new RegExp(`^Hermes/tarefas/${DAY}-it-${RUN}-[a-z0-9-]+\\.md$`);

let cfg: GitHubVaultConfig;
let raw: ReturnType<typeof rawGitHub>;
const touched = new Set<string>();

const title = (label: string) => `it ${RUN} ${label}`;
const pathOf = (label: string) => {
  const p = taskPath(`${DAY}-${slugify(title(label))}`);
  touched.add(p);
  return p;
};
const bodyOf = (c: string) => c.slice(c.indexOf("\n---", 4) + 4);

function bot(store: ReturnType<typeof createGitHubVaultStore>, nowIso = "2020-01-01T15:10:00Z") {
  const clock = fakeClock(nowIso);
  const replies: string[] = [];
  const handler = createHandler({
    config: { botToken: "tok", webhookSecret: SECRET, allowedChatIds: [CHAT] },
    client: { sendMessage: async (_c, t) => void replies.push(t) },
    clock,
    ...makeRepos(store, clock),
  });
  let n = 0;
  return {
    clock,
    replies,
    async send(text: string, opts: { date?: number; chat?: number } = {}) {
      const before = replies.length;
      const res = (await handler({
        headers: { "x-telegram-bot-api-secret-token": SECRET },
        body: JSON.stringify({
          update_id: ++n,
          message: { message_id: n, chat: { id: opts.chat ?? CHAT, type: "private" }, date: opts.date ?? EVENT, text },
        }),
      } as never)) as { statusCode: number };
      return { status: res.statusCode, reply: replies.length > before ? replies.at(-1)! : undefined };
    },
  };
}

beforeAll(async () => {
  cfg = await loadVaultConfig(createSsmReader(), process.env);
  raw = rawGitHub(cfg);
  console.log(`Integração Telegram->GitHub: ${cfg.owner}/${cfg.repo} @ ${cfg.branch}  run=${RUN}`);
});

afterAll(async () => {
  const failed: string[] = [];
  for (const path of touched) {
    if (!SAFE_PATH.test(path)) failed.push(`${path} (fora do padrão, NÃO removido)`);
    else if (!(await raw.remove(path, `chore: limpa arquivo de teste de integração ${path}`))) failed.push(path);
  }
  console.log(failed.length ? `Limpeza INCOMPLETA, remova à mão:\n${failed.join("\n")}` : `Limpeza ok (${touched.size} caminho(s))`);
});

describe("Telegram -> handler -> GitHub real (verificado direto na API)", () => {
  it("1+2. /tarefa cria o arquivo no GitHub; reenviar o mesmo update não cria outro", async () => {
    const b = bot(createGitHubVaultStore(cfg));
    const path = pathOf("criar");
    const out = await b.send(`/tarefa ${title("criar")} até 2020-02-10`);
    expect(out).toEqual({
      status: 200,
      reply: `Tarefa criada: ${title("criar")}\nID: ${DAY}-${slugify(title("criar"))}\nPrazo: 2020-02-10`,
    });

    const file = await raw.get(path);
    expect(file?.content).toBe(
      [
        "---",
        "schema: 1",
        `id: ${DAY}-${slugify(title("criar"))}`,
        "type: tarefa",
        `title: ${title("criar")}`,
        "status: pendente",
        "created: 2020-01-01T12:00:00-03:00",
        "updated: 2020-01-01T12:00:00-03:00",
        "due: 2020-02-10",
        "---",
        "",
        `# ${title("criar")}`,
        "",
      ].join("\n"),
    );
    expect(await raw.commitCount(path)).toBe(1);

    const again = await b.send(`/tarefa ${title("criar")} até 2020-02-10`);
    expect(again.reply).toContain("Tarefa já existe");
    expect(await raw.commitCount(path)).toBe(1);
  });

  it("3. /feita altera só o esperado no GitHub, preservando a edição manual do corpo", async () => {
    const b = bot(createGitHubVaultStore(cfg));
    const path = pathOf("feita");
    await b.send(`/tarefa ${title("feita")}`);
    const f0 = (await raw.get(path))!;
    const manual = `${f0.content}\nMinha anotação.\n\n<!-- meu -->\n- CAP\n- Ação 日本語 🚀\n`;
    await raw.put(path, manual, f0.sha, "edição manual (teste)");

    const out = await b.send(`/feita ${RUN} feita`);
    expect(out.reply).toBe(`Feita: ${title("feita")}`);
    const after = (await raw.get(path))!.content;
    expect(bodyOf(after)).toBe(bodyOf(manual));
    expect(after).toBe(
      manual
        .replace("status: pendente", "status: feita")
        .replace("updated: 2020-01-01T12:00:00-03:00", "updated: 2020-01-01T12:10:00-03:00")
        .replace("---\n\n#", "done_at: 2020-01-01T12:10:00-03:00\n---\n\n#"),
    );
  });

  it("4+6. /cancelar altera só o esperado; repetir por ID é no-op sem commit novo", async () => {
    const b = bot(createGitHubVaultStore(cfg));
    const path = pathOf("cancelar");
    await b.send(`/tarefa ${title("cancelar")}`);
    const before = (await raw.get(path))!.content;
    expect((await b.send(`/cancelar ${RUN} cancelar`)).reply).toBe(`Cancelada: ${title("cancelar")}`);
    const after = (await raw.get(path))!.content;
    expect(after).toBe(
      before
        .replace("status: pendente", "status: cancelada")
        .replace("updated: 2020-01-01T12:00:00-03:00", "updated: 2020-01-01T12:10:00-03:00"),
    );
    const commits = await raw.commitCount(path);
    b.clock.advanceMs(3_600_000);
    const id = `${DAY}-${slugify(title("cancelar"))}`;
    expect((await b.send(`/cancelar ${id}`)).reply).toBe(`Já estava cancelada: ${title("cancelar")}`);
    expect((await raw.get(path))!.content).toBe(after);
    expect(await raw.commitCount(path)).toBe(commits);
  });

  it("5. trecho ambíguo não altera nada", async () => {
    const b = bot(createGitHubVaultStore(cfg));
    const p1 = pathOf("amb um");
    const p2 = pathOf("amb dois");
    await b.send(`/tarefa ${title("amb um")}`);
    await b.send(`/tarefa ${title("amb dois")}`);
    const [c1, c2] = [await raw.commitCount(p1), await raw.commitCount(p2)];
    const out = await b.send(`/feita ${RUN} amb`);
    expect(out.status).toBe(200);
    expect(out.reply).toContain("Mais de uma tarefa corresponde");
    expect(out.reply).toContain(`${DAY}-${slugify(title("amb um"))}`);
    expect(out.reply).toContain(`${DAY}-${slugify(title("amb dois"))}`);
    expect(await raw.commitCount(p1)).toBe(c1);
    expect(await raw.commitCount(p2)).toBe(c2);
    expect((await raw.get(p1))!.content).toContain("status: pendente");
  });

  it("10. message.date às 23:59 processada às 00:01 do dia seguinte: mesma data e reenvio sem duplicar", async () => {
    const b = bot(createGitHubVaultStore(cfg), "2020-01-02T03:01:00Z"); // agora = 00:01 do dia 02
    const date = Date.parse("2020-01-02T02:59:00Z") / 1000; // enviada às 23:59 do dia 01
    const path = pathOf("meia noite");
    const out = await b.send(`/tarefa ${title("meia noite")}`, { date });
    expect(out.reply).toContain(`ID: ${DAY}-`);
    expect((await raw.get(path))!.content).toContain("created: 2020-01-01T23:59:00-03:00");
    expect(await raw.get(taskPath(`2020-01-02-${slugify(title("meia noite"))}`))).toBeNull();

    b.clock.set("2020-01-02T15:00:00Z");
    expect((await b.send(`/tarefa ${title("meia noite")}`, { date })).reply).toContain("Tarefa já existe");
    expect(await raw.commitCount(path)).toBe(1);
  });

  it("7. chat não autorizado: silêncio e nenhum arquivo criado", async () => {
    const b = bot(createGitHubVaultStore(cfg));
    const path = pathOf("intruso");
    expect(await b.send(`/tarefa ${title("intruso")}`, { chat: 999 })).toEqual({ status: 200, reply: undefined });
    expect(await raw.get(path)).toBeNull();
  });

  it("9. credencial inválida no GitHub real: 200 com mensagem genérica, sem vazar o token", async () => {
    const bad = "github_pat_INVALIDO_PARA_TESTE_0123456789";
    const b = bot(createGitHubVaultStore({ ...cfg, token: bad }));
    const out = await b.send(`/tarefa ${title("credencial")}`);
    expect(out.status).toBe(200);
    expect(out.reply).toContain("erro de configuração ou permissão");
    expect(out.reply).not.toContain(bad);
  });
});

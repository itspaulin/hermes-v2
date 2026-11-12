import { describe, expect, it, vi } from "vitest";
import { createHandler } from "../src/handler.js";
import { createTelegramClient, TelegramApiError, type TelegramClient } from "../src/telegram/client.js";
import { loadTelegramConfig, telegramParamNamesFromEnv } from "../src/telegram/config.js";
import { createSsmReader, type ParameterReader } from "../src/ssm.js";
import { makeRepos } from "./support/repos.js";
import { parseCommand, routeMessage } from "../src/telegram/router.js";
import { TaskRepository } from "../src/domain/task-repository.js";
import { InMemoryVaultStore } from "../src/vault/memory-store.js";
import { guardVaultStore } from "../src/vault/store.js";
import { fakeClock } from "../src/time/index.js";

const SECRET = "s3cret";
const ALLOWED = 111;
const clock = fakeClock("2026-09-25T17:30:00Z"); // 14:30 em SP

function setup(sendMessage: TelegramClient["sendMessage"] = async () => {}) {
  const send = vi.fn(sendMessage);
  const store = guardVaultStore(new InMemoryVaultStore());
  const handler = createHandler({
    config: { botToken: "tok", webhookSecret: SECRET, allowedChatIds: [ALLOWED] },
    client: { sendMessage: send, answerCallbackQuery: async () => {}, editMessageText: async () => {} },
    clock,
    ...makeRepos(store, clock),
  });
  return { send, handler };
}

function event(over: { secret?: string | null; body?: unknown; raw?: string; b64?: boolean } = {}) {
  const headers: Record<string, string> = {};
  if (over.secret !== null) headers["x-telegram-bot-api-secret-token"] = over.secret ?? SECRET;
  let body = over.raw ?? JSON.stringify(over.body);
  if (over.b64) body = Buffer.from(body).toString("base64");
  return { headers, body, isBase64Encoded: !!over.b64 } as never;
}

const msg = (text?: string, chatId = ALLOWED) => ({
  update_id: 1,
  message: { message_id: 1, chat: { id: chatId, type: "private" }, ...(text !== undefined && { text }) },
});

describe("secret_token", () => {
  it("correto: processa", async () => {
    const { handler, send } = setup();
    expect(await handler(event({ body: msg("/ping") }))).toMatchObject({ statusCode: 200 });
    expect(send).toHaveBeenCalledOnce();
  });

  it.each([["errado", "nope"], ["ausente", null], ["prefixo", "s3cre"]])("%s: 401 e nada enviado", async (_n, secret) => {
    const { handler, send } = setup();
    expect(await handler(event({ secret, body: msg("/ping") }))).toMatchObject({ statusCode: 401 });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("allowlist de chat_id", () => {
  it("autorizado responde", async () => {
    const { handler, send } = setup();
    await handler(event({ body: msg("/start") }));
    expect(send).toHaveBeenCalledWith(ALLOWED, expect.stringContaining("Conexão: /ping"));
  });

  it("não autorizado: 200 silencioso, sem resposta", async () => {
    const { handler, send } = setup();
    expect(await handler(event({ body: msg("/ping", 999) }))).toMatchObject({ statusCode: 200 });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("comandos", () => {
  const store = guardVaultStore(new InMemoryVaultStore());
  const deps = { clock, ...makeRepos(store, clock) };
  const route = (text: string) => routeMessage(text, undefined, deps);

  it("/start", async () =>
    expect(await route("/start")).toBe(
      [
        "Hermes online.",
        "",
        "Tarefas: /tarefa <título> [até AAAA-MM-DD], /feita, /cancelar, /hoje, /semana",
        "Metas: /meta <título> [até AAAA-MM-DD], /metas, /metafeita, /metacancelar",
        "Respostas: /checkin, /metrica, /revisao",
        "Lembretes: peça na conversa (\"toda terça às 11h me lembra de...\"), /lembretes, /apagarlembrete",
        "Conexão: /ping",
      ].join("\n"),
    ));

  it("/ping devolve hora de SP", async () => {
    expect(await route("/ping")).toBe("pong 2026-09-25T14:30:00-03:00");
  });

  it("aceita @bot, argumentos e maiúsculas", () => {
    expect(parseCommand("/Ping@hermes_bot")).toBe("ping");
    expect(parseCommand("/ping extra")).toBe("ping");
    expect(parseCommand("  /start")).toBe("start");
  });

  it("comando desconhecido", async () => {
    expect(await route("/foo")).toContain("Comando desconhecido: /foo");
    expect(await route("/foo")).toContain("/tarefa, /feita, /cancelar, /hoje, /semana, /meta, /metas, /metafeita, /metacancelar, /checkin, /metrica, /revisao, /lembretes, /apagarlembrete, /ping");
  });

  it("várias linhas /tarefa na mesma mensagem criam uma tarefa por linha, sem pergunta de meta", async () => {
    const repos = makeRepos(guardVaultStore(new InMemoryVaultStore()), clock);
    await repos.metas.create({ title: "Meta ativa", eventEpochSeconds: 1_790_000_000 });
    const out = await routeMessage("/tarefa Ideia de 2 apps\n/tarefa Identidade da Somisfy até 2026-11-08\n\n/tarefa Ideias de prospecção", 1_790_000_000, { clock, ...repos });
    expect(typeof out).toBe("string");
    const { tasks } = await repos.tasks.listPending();
    expect(tasks.map((t) => t.title).sort()).toEqual(["Ideia de 2 apps", "Ideias de prospecção", "Identidade da Somisfy"]);
    expect(tasks.find((t) => t.title === "Identidade da Somisfy")!.due).toBe("2026-11-08");
  });

  it("linhas com texto solto no meio continuam sendo um comando só", async () => {
    const repos = makeRepos(guardVaultStore(new InMemoryVaultStore()), clock);
    await routeMessage("/tarefa Comprar pão\ne leite", 1_790_000_000, { clock, ...repos });
    expect((await repos.tasks.listPending()).tasks.map((t) => t.title)).toEqual(["Comprar pão e leite"]);
  });

  it("mensagem sem comando", async () => {
    expect(await route("oi")).toContain("Envie um comando");
    expect(parseCommand("olá /ping")).toBeNull();
    expect(parseCommand("/")).toBeNull();
  });
});

describe("payload", () => {
  it.each([
    ["sem body", event({ raw: undefined as never })],
    ["JSON inválido", event({ raw: "{nope" })],
    ["sem update_id", event({ body: { message: {} } })],
    ["JSON não-objeto", event({ raw: "42" })],
  ])("%s: 400", async (_n, ev) => {
    const { handler, send } = setup();
    expect(await handler(ev)).toMatchObject({ statusCode: 400 });
    expect(send).not.toHaveBeenCalled();
  });

  it("body em base64", async () => {
    const { handler, send } = setup();
    await handler(event({ body: msg("/ping"), b64: true }));
    expect(send).toHaveBeenCalledOnce();
  });

  it("update sem texto ou sem message: 200 sem resposta", async () => {
    const { handler, send } = setup();
    expect(await handler(event({ body: msg(undefined) }))).toMatchObject({ statusCode: 200 });
    expect(await handler(event({ body: { update_id: 2, edited_message: {} } }))).toMatchObject({ statusCode: 200 });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("erros da API do Telegram", () => {
  it("5xx/rede: 500 para o Telegram reenviar", async () => {
    for (const err of [new TelegramApiError("x", 502), new TelegramApiError("x"), new TelegramApiError("x", 429)]) {
      const { handler } = setup(async () => { throw err; });
      expect(await handler(event({ body: msg("/ping") }))).toMatchObject({ statusCode: 500 });
    }
  });

  it("4xx (ex.: bot bloqueado): 200, sem loop de reenvio", async () => {
    const { handler } = setup(async () => { throw new TelegramApiError("x", 403); });
    expect(await handler(event({ body: msg("/ping") }))).toMatchObject({ statusCode: 200 });
  });

  it("erro inesperado ao responder: 500 (Telegram reenvia)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { handler } = setup(async () => { throw new Error("bug"); });
    expect(await handler(event({ body: msg("/ping") }))).toMatchObject({ statusCode: 500 });
  });
});

describe("createTelegramClient", () => {
  it("POST sendMessage com chat_id e text", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 200 }));
    await createTelegramClient("TOKEN", f as never).sendMessage(5, "oi");
    expect(f).toHaveBeenCalledWith(
      "https://api.telegram.org/botTOKEN/sendMessage",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ chat_id: 5, text: "oi" }) }),
    );
  });

  it("HTTP não-ok vira TelegramApiError com status, sem vazar token", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 403 }));
    const err = await createTelegramClient("TOKEN", f as never).sendMessage(5, "oi").catch((e) => e);
    expect(err).toBeInstanceOf(TelegramApiError);
    expect(err.status).toBe(403);
    expect(err.retryable).toBe(false);
    expect(err.message).not.toContain("TOKEN");
  });

  it("falha de rede: retryable e sem vazar token", async () => {
    const f = vi.fn(async () => { throw new TypeError("fetch failed https://api.telegram.org/botTOKEN/x"); });
    const err = await createTelegramClient("TOKEN", f as never).sendMessage(5, "oi").catch((e) => e);
    expect(err.retryable).toBe(true);
    expect(err.message).not.toContain("TOKEN");
  });
});

describe("config via SSM", () => {
  const names = { botToken: "/p/bot-token", webhookSecret: "/p/webhook-secret", allowedChatIds: "/p/allowed-chat-ids" };
  const values: Record<string, string> = {
    "/p/bot-token": "123:SUPER-TOKEN",
    "/p/webhook-secret": "SUPER-SECRET",
    "/p/allowed-chat-ids": "1, 2,-3",
  };
  const reader = (v: Record<string, string> = values): ParameterReader => ({
    get: vi.fn(async (n: string) => {
      const x = v[n];
      if (x === undefined) throw new Error(`Parâmetro SSM vazio ou ausente: ${n}`);
      return x;
    }),
  });

  it("lê os três parâmetros e converte chat ids", async () => {
    expect(await loadTelegramConfig(reader(), names)).toEqual({
      botToken: "123:SUPER-TOKEN",
      webhookSecret: "SUPER-SECRET",
      allowedChatIds: [1, 2, -3],
    });
  });

  it("busca em paralelo: os 3 gets começam antes de qualquer um terminar", async () => {
    let started = 0;
    let maxInFlight = 0;
    const r: ParameterReader = {
      async get(n) {
        started++;
        maxInFlight = Math.max(maxInFlight, started);
        await Promise.resolve();
        started--;
        return values[n]!;
      },
    };
    await loadTelegramConfig(r, names);
    expect(maxInFlight).toBe(3);
  });

  it("parâmetro ausente: erro cita o nome, não valores", async () => {
    const { "/p/webhook-secret": _omit, ...rest } = values;
    const err = await loadTelegramConfig(reader(rest), names).catch((e) => e);
    expect(err.message).toContain("/p/webhook-secret");
    expect(err.message).not.toContain("SUPER");
  });

  it("chat ids inválidos: erro não vaza nenhum valor do SSM", async () => {
    for (const bad of ["abc", " , "]) {
      const err = await loadTelegramConfig(reader({ ...values, "/p/allowed-chat-ids": bad }), names).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).not.toContain("SUPER");
      expect(err.message).not.toContain(bad.trim() || "\u0000");
    }
  });

  it("nomes vêm de env vars; falta uma: erro cita a variável", () => {
    const env = {
      TELEGRAM_BOT_TOKEN_PARAM: "/p/bot-token",
      TELEGRAM_WEBHOOK_SECRET_PARAM: "/p/webhook-secret",
      TELEGRAM_ALLOWED_CHAT_IDS_PARAM: "/p/allowed-chat-ids",
    };
    expect(telegramParamNamesFromEnv(env)).toEqual(names);
    expect(() => telegramParamNamesFromEnv({ ...env, TELEGRAM_BOT_TOKEN_PARAM: undefined })).toThrow("TELEGRAM_BOT_TOKEN_PARAM");
  });
});

describe("createSsmReader", () => {
  it("pede WithDecryption e devolve o valor", async () => {
    const send = vi.fn(async (_cmd: unknown) => ({ Parameter: { Value: "v" } }));
    const v = await createSsmReader({ send } as never).get("/p/x");
    expect(v).toBe("v");
    const cmd = send.mock.calls[0]![0] as { input: unknown };
    expect(cmd.input).toEqual({ Name: "/p/x", WithDecryption: true });
  });

  it("erro do SDK: cita o nome do parâmetro e o tipo do erro (ParameterNotFound), não a mensagem opaca", async () => {
    const send = vi.fn(async (_cmd: unknown) => {
      throw Object.assign(new Error("UnknownError"), { name: "ParameterNotFound" });
    });
    const err = await createSsmReader({ send } as never).get("/p/x").catch((e) => e);
    expect(err.message).toBe("Falha ao ler o parâmetro SSM /p/x: ParameterNotFound");
  });

  it("valor vazio: erro só com o nome", async () => {
    const send = vi.fn(async () => ({ Parameter: { Value: "" } }));
    await expect(createSsmReader({ send } as never).get("/p/x")).rejects.toThrow("/p/x");
  });
});

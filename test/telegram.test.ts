import { describe, expect, it, vi } from "vitest";
import { createHandler } from "../src/handler.js";
import { createTelegramClient, TelegramApiError, type TelegramClient } from "../src/telegram/client.js";
import { loadTelegramConfig } from "../src/telegram/config.js";
import { parseCommand, routeText } from "../src/telegram/router.js";
import { fakeClock } from "../src/time/index.js";

const SECRET = "s3cret";
const ALLOWED = 111;
const clock = fakeClock("2026-09-25T17:30:00Z"); // 14:30 em SP

function setup(sendMessage: TelegramClient["sendMessage"] = async () => {}) {
  const send = vi.fn(sendMessage);
  const handler = createHandler({
    config: { botToken: "tok", webhookSecret: SECRET, allowedChatIds: [ALLOWED] },
    client: { sendMessage: send },
    clock,
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
    expect(send).toHaveBeenCalledWith(ALLOWED, expect.stringContaining("online"));
  });

  it("não autorizado: 200 silencioso, sem resposta", async () => {
    const { handler, send } = setup();
    expect(await handler(event({ body: msg("/ping", 999) }))).toMatchObject({ statusCode: 200 });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("comandos", () => {
  it("/start", () => expect(routeText("/start", clock)).toContain("Hermes v2 online"));

  it("/ping devolve hora de SP", () => {
    expect(routeText("/ping", clock)).toBe("pong 2026-09-25T14:30:00-03:00");
  });

  it("aceita @bot, argumentos e maiúsculas", () => {
    expect(parseCommand("/Ping@hermes_bot")).toBe("ping");
    expect(parseCommand("/ping extra")).toBe("ping");
    expect(parseCommand("  /start")).toBe("start");
  });

  it("comando desconhecido", () => {
    expect(routeText("/foo", clock)).toContain("Comando desconhecido: /foo");
  });

  it("mensagem sem comando", () => {
    expect(routeText("oi", clock)).toContain("Envie um comando");
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

  it("erro inesperado propaga", async () => {
    const { handler } = setup(async () => { throw new Error("bug"); });
    await expect(handler(event({ body: msg("/ping") }))).rejects.toThrow("bug");
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

describe("loadTelegramConfig", () => {
  const env = { TELEGRAM_BOT_TOKEN: "t", TELEGRAM_WEBHOOK_SECRET: "s", TELEGRAM_ALLOWED_CHAT_IDS: "1, 2,-3" };

  it("lê e converte chat ids", () => {
    expect(loadTelegramConfig(env)).toEqual({ botToken: "t", webhookSecret: "s", allowedChatIds: [1, 2, -3] });
  });

  it.each(["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_ALLOWED_CHAT_IDS"])("falta %s", (k) => {
    expect(() => loadTelegramConfig({ ...env, [k]: undefined })).toThrow(k);
  });

  it("chat id inválido ou lista vazia", () => {
    expect(() => loadTelegramConfig({ ...env, TELEGRAM_ALLOWED_CHAT_IDS: "abc" })).toThrow("inválido");
    expect(() => loadTelegramConfig({ ...env, TELEGRAM_ALLOWED_CHAT_IDS: " , " })).toThrow("vazio");
  });
});

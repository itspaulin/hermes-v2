import { describe, expect, it, vi } from "vitest";
import {
  deleteWebhook,
  findChatIds,
  formatWebhookInfo,
  getWebhookInfo,
  setWebhook,
  validateSecret,
  validateWebhookUrl,
} from "../scripts/telegram-admin-lib.js";

const TOKEN = "123456:SUPER-SECRET-BOT-TOKEN";
const SECRET = "a".repeat(64);
const URL_OK = "https://abc123.execute-api.sa-east-1.amazonaws.com/telegram/webhook";

const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });
const fail = (status: number, description: string) =>
  new Response(JSON.stringify({ ok: false, description }), { status });

/** fetch que registra chamadas e responde por método da API do Telegram. */
function fakeApi(handlers: Record<string, (body: Record<string, unknown>) => Response>) {
  const calls: { method: string; body: Record<string, unknown>; url: string }[] = [];
  const f = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = url.split("/").pop()!;
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ method, body, url });
    const h = handlers[method];
    if (!h) throw new Error(`método não roteirizado: ${method}`);
    return h(body);
  });
  return { f: f as unknown as typeof fetch, calls };
}

describe("validateWebhookUrl", () => {
  it("aceita https com /telegram/webhook", () => expect(validateWebhookUrl(URL_OK)).toBe(URL_OK));

  it.each([
    ["http", "http://x.com/telegram/webhook"],
    ["caminho errado", "https://x.com/outro"],
    ["raiz", "https://x.com/"],
    ["credenciais", "https://u:p@x.com/telegram/webhook"],
    ["query", "https://x.com/telegram/webhook?a=1"],
    ["fragmento", "https://x.com/telegram/webhook#x"],
    ["lixo", "não é url"],
    ["vazio", ""],
  ])("recusa %s", (_n, u) => expect(() => validateWebhookUrl(u)).toThrow());
});

describe("validateSecret", () => {
  it.each(["openssl-hex", "a".repeat(256), "A_b-9"])("aceita %s", (s) => expect(validateSecret(s)).toBe(s));
  it.each(["", "com espaço", "com\nnewline", "ação", "a".repeat(257), "a+b", "a=b"])("recusa %j", (s) =>
    expect(() => validateSecret(s)).toThrow("webhook-secret inválido"),
  );
});

describe("setWebhook", () => {
  const info = { url: URL_OK, pending_update_count: 0, allowed_updates: ["message", "callback_query"] };

  it("envia url, secret_token e allowed_updates=[message, callback_query]; NÃO usa drop_pending_updates", async () => {
    const { f, calls } = fakeApi({ setWebhook: () => ok(true), getWebhookInfo: () => ok(info) });
    const r = await setWebhook({ token: TOKEN, secret: SECRET, url: URL_OK }, f);
    expect(calls.map((c) => c.method)).toEqual(["setWebhook", "getWebhookInfo"]);
    expect(calls[0]!.body).toEqual({ url: URL_OK, secret_token: SECRET, allowed_updates: ["message", "callback_query"] });
    expect(calls[0]!.body).not.toHaveProperty("drop_pending_updates");
    expect(r).toMatchObject({ url: URL_OK, pendingUpdateCount: 0, allowedUpdates: ["message", "callback_query"] });
  });

  it("URL ou secret inválidos falham antes de qualquer chamada", async () => {
    const { f, calls } = fakeApi({});
    await expect(setWebhook({ token: TOKEN, secret: SECRET, url: "http://x/telegram/webhook" }, f)).rejects.toThrow();
    await expect(setWebhook({ token: TOKEN, secret: "com espaço", url: URL_OK }, f)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("detecta URL registrada diferente da pedida", async () => {
    const { f } = fakeApi({ setWebhook: () => ok(true), getWebhookInfo: () => ok({ ...info, url: "https://outra/telegram/webhook" }) });
    await expect(setWebhook({ token: TOKEN, secret: SECRET, url: URL_OK }, f)).rejects.toThrow("URL diferente");
  });

  it("erro do Telegram: mensagem sem o token, mesmo se a descrição o ecoar", async () => {
    const { f } = fakeApi({ setWebhook: () => fail(401, `Unauthorized bot${TOKEN}`) });
    const err = await setWebhook({ token: TOKEN, secret: SECRET, url: URL_OK }, f).catch((e) => e);
    expect(err.message).toContain("Telegram setWebhook falhou");
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).toContain("***");
  });

  it("falha de rede: mensagem sem o token (a URL da requisição o contém)", async () => {
    const f = (async () => { throw new TypeError(`fetch failed https://api.telegram.org/bot${TOKEN}/setWebhook`); }) as unknown as typeof fetch;
    const err = await setWebhook({ token: TOKEN, secret: SECRET, url: URL_OK }, f).catch((e) => e);
    expect(err.message).toContain("falha de rede");
    expect(err.message).not.toContain(TOKEN);
  });

  it("resposta não-JSON vira erro com HTTP status, sem token", async () => {
    const f = (async () => new Response("<html>", { status: 502 })) as unknown as typeof fetch;
    const err = await getWebhookInfo(TOKEN, f).catch((e) => e);
    expect(err.message).toContain("HTTP 502");
    expect(err.message).not.toContain(TOKEN);
  });
});

describe("deleteWebhook", () => {
  it("pede explicitamente para preservar as pendentes", async () => {
    const { f, calls } = fakeApi({ deleteWebhook: () => ok(true) });
    await deleteWebhook(TOKEN, f);
    expect(calls[0]!.body).toEqual({ drop_pending_updates: false });
  });
});

describe("findChatIds", () => {
  const upd = (id: number, extra = {}) => ({ update_id: id, message: { chat: { id: 111, type: "private", first_name: "Paulo", ...extra } } });

  it("lista chats únicos sem consumir updates (sem offset)", async () => {
    const { f, calls } = fakeApi({
      getUpdates: () => ok([upd(1), upd(2), { update_id: 3, message: { chat: { id: 222, type: "group", title: "Grupo" } } }, { update_id: 4 }]),
    });
    expect(await findChatIds(TOKEN, f)).toEqual([
      { id: 111, type: "private", name: "Paulo" },
      { id: 222, type: "group", name: "Grupo" },
    ]);
    expect(calls[0]!.body).not.toHaveProperty("offset");
  });

  it("vazio", async () => {
    expect(await findChatIds(TOKEN, fakeApi({ getUpdates: () => ok([]) }).f)).toEqual([]);
  });

  it("webhook ativo (409): explica o que fazer", async () => {
    const { f } = fakeApi({ getUpdates: () => fail(409, "Conflict: can't use getUpdates method while webhook is active") });
    const err = await findChatIds(TOKEN, f).catch((e) => e);
    expect(err.message).toContain("delete-webhook");
    expect(err.message).not.toContain(TOKEN);
  });
});

describe("formatWebhookInfo", () => {
  const now = Date.parse("2026-09-25T18:00:00Z");

  it("sem erro", () => {
    expect(formatWebhookInfo({ url: URL_OK, pendingUpdateCount: 0, allowedUpdates: ["message"] }, now)).toEqual([
      `URL: ${URL_OK}`,
      "Pending updates: 0",
      "Last error: nenhum",
      "Allowed updates: message",
    ]);
  });

  it("com erro recente", () => {
    const lines = formatWebhookInfo(
      { url: URL_OK, pendingUpdateCount: 3, lastErrorDate: now / 1000 - 300, lastErrorMessage: "Wrong response from the webhook: 500 Internal Server Error" },
      now,
    );
    expect(lines[1]).toBe("Pending updates: 3");
    expect(lines[2]).toContain("Wrong response from the webhook: 500");
    expect(lines[2]).toContain("há 5 min");
  });

  it("sem webhook", () => {
    expect(formatWebhookInfo({ url: "", pendingUpdateCount: 0 }, now)[0]).toBe("URL: (nenhum webhook)");
  });

  it("nunca contém o token (a função nem o recebe)", () => {
    expect(JSON.stringify(formatWebhookInfo({ url: URL_OK, pendingUpdateCount: 0 }, now))).not.toContain(TOKEN);
  });
});

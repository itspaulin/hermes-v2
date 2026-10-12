import { describe, expect, it, vi } from "vitest";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { createRenatoWebhookHandler } from "../src/lambda.js";
import { fixedClock } from "../src/clock.js";
import { createTelegramHandler, type CaptureNoteCommand } from "../src/handler.js";

function event(payload: unknown, overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: "2.0",
    routeKey: "POST /renato/webhook",
    rawPath: "/renato/webhook",
    rawQueryString: "",
    headers: { "x-telegram-bot-api-secret-token": "test-secret" },
    requestContext: {
      accountId: "test",
      apiId: "test",
      domainName: "example.test",
      domainPrefix: "example",
      http: { method: "POST", path: "/renato/webhook", protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "test" },
      requestId: "test",
      routeKey: "POST /renato/webhook",
      stage: "$default",
      time: "12/Oct/2026:12:00:00 +0000",
      timeEpoch: 1791806400000,
    },
    isBase64Encoded: false,
    body: JSON.stringify(payload),
    ...overrides,
  };
}

const update = {
  update_id: 10,
  message: { message_id: 42, date: 1768491000, chat: { id: 777 }, text: "ideia: app de receitas" },
};

function setup(allowedChatIds = new Set([777])) {
  const capture = vi.fn((_command: CaptureNoteCommand) => undefined);
  const handleUpdate = createTelegramHandler({ clock: fixedClock("2026-01-15T15:30:00.000Z"), capture });
  const sendMessage = vi.fn(async () => undefined);
  const handler = createRenatoWebhookHandler({
    webhookSecret: "test-secret",
    allowedChatIds,
    handleUpdate,
    sendMessage,
  });
  return { handler, capture, sendMessage };
}

describe("createRenatoWebhookHandler", () => {
  it("valida o secret antes de processar o payload", async () => {
    const { handler, capture } = setup();
    const result = await handler(event(update, { headers: {} }));
    expect(result.statusCode).toBe(401);
    expect(capture).not.toHaveBeenCalled();
  });

  it("captura e responde a uma mensagem autorizada", async () => {
    const { handler, capture, sendMessage } = setup();
    const result = await handler(event(update));
    expect(result.statusCode).toBe(200);
    expect(capture).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(777, expect.stringContaining("telegram-777-42"));
  });

  it("ignora chats não autorizados", async () => {
    const { handler, capture, sendMessage } = setup(new Set([123]));
    expect((await handler(event(update))).statusCode).toBe(200);
    expect(capture).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("rejeita JSON malformado", async () => {
    const { handler, capture } = setup();
    expect((await handler(event(null, { body: "{" }))).statusCode).toBe(400);
    expect(capture).not.toHaveBeenCalled();
  });

  it("retorna 500 para retry quando persistência falha", async () => {
    const capture = vi.fn(() => Promise.reject(new Error("offline")));
    const handleUpdate = createTelegramHandler({ clock: fixedClock("2026-01-15T15:30:00.000Z"), capture });
    const handler = createRenatoWebhookHandler({
      webhookSecret: "test-secret",
      allowedChatIds: new Set([777]),
      handleUpdate,
      sendMessage: vi.fn(async () => undefined),
    });
    expect((await handler(event(update))).statusCode).toBe(500);
  });

  it("retorna 500 quando o Telegram não aceita a confirmação", async () => {
    const { handler } = setup();
    const failed = createRenatoWebhookHandler({
      webhookSecret: "test-secret",
      allowedChatIds: new Set([777]),
      handleUpdate: createTelegramHandler({ clock: fixedClock("2026-01-15T15:30:00.000Z"), capture: vi.fn() }),
      sendMessage: vi.fn(() => Promise.reject(new Error("offline"))),
    });
    expect((await failed(event(update))).statusCode).toBe(500);
    expect((await handler(event({ update_id: 11 }))).statusCode).toBe(200);
  });

  it("não atende método ou caminho diferente", async () => {
    const { handler, capture } = setup();
    expect((await handler(event(update, { rawPath: "/other" }))).statusCode).toBe(404);
    expect((await handler(event(update, { requestContext: { ...event(update).requestContext, http: { ...event(update).requestContext.http, method: "GET" } } }))).statusCode).toBe(404);
    expect(capture).not.toHaveBeenCalled();
  });
});

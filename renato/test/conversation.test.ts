import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { createRenatoWebhookHandler } from "../src/lambda.js";
import { createTelegramHandler, type CaptureNoteCommand } from "../src/handler.js";
import { fixedClock } from "../src/clock.js";
import { AI_UNAVAILABLE_TEXT, createRenatoAi, createRenatoConversation, explicitCapture, SYSTEM_PROMPT } from "../src/conversation.js";
import type { Converse } from "../../shared/ai/bedrock.js";
import type { AiConfig } from "../../shared/ai/types.js";

const config: AiConfig = { modelId: "m", region: "us-east-1", maxHistoryMessages: 4, maxInputChars: 500, maxOutputTokens: 100, timeoutMs: 1000 };

function event(text: string): APIGatewayProxyEventV2 {
  return {
    version: "2.0", routeKey: "POST /renato/webhook", rawPath: "/renato/webhook", rawQueryString: "",
    headers: { "x-telegram-bot-api-secret-token": "s" },
    requestContext: { accountId: "t", apiId: "t", domainName: "e", domainPrefix: "e", http: { method: "POST", path: "/renato/webhook", protocol: "HTTP/1.1", sourceIp: "1", userAgent: "t" }, requestId: "t", routeKey: "k", stage: "$default", time: "t", timeEpoch: 1 },
    isBase64Encoded: false,
    body: JSON.stringify({ update_id: 1, message: { message_id: 42, date: 1768491000, chat: { id: 777 }, text } }),
  };
}

function setup(converse: Converse, capture: (c: CaptureNoteCommand) => void | Promise<void> = () => undefined) {
  const cap = vi.fn(capture);
  const sendMessage = vi.fn(async (_chat: number, _text: string) => undefined);
  const handler = createRenatoWebhookHandler({
    webhookSecret: "s",
    allowedChatIds: new Set([777]),
    handleUpdate: createTelegramHandler({ clock: fixedClock("2026-01-15T15:30:00.000Z"), capture: cap }),
    sendMessage,
    conversation: createRenatoConversation(createRenatoAi(config, converse)),
  });
  return { handler, cap, sendMessage, converse };
}
const json = (o: unknown): Converse => vi.fn(async () => ({ text: JSON.stringify(o) }));

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("Renato: conversa natural", () => {
  it.each(["Oi, Renato!", "Bom dia", "Quero pensar em uma ideia de projeto."])("%s não cria nota", async (text) => {
    const { handler, cap, sendMessage } = setup(json({ type: "reply", message: "Olá! Vamos conversar." }));
    expect((await handler(event(text))).statusCode).toBe(200);
    expect(cap).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(777, "Olá! Vamos conversar.");
  });

  it("pedido explícito reconhecido grava a mensagem original e confirma com o ID real", async () => {
    const { handler, cap, sendMessage } = setup(json({ type: "action", action: "capture_note", input: {} }));
    await handler(event("Guarde isso: quero estudar System Design."));
    expect(cap).toHaveBeenCalledOnce();
    expect(cap.mock.calls[0]![0].note.originalContent).toBe("Guarde isso: quero estudar System Design.");
    expect(sendMessage).toHaveBeenCalledWith(777, "Anotado no Renato. ID: telegram-777-42");
  });

  it("falha de persistência: 500, sem confirmação e sem ID", async () => {
    const { handler, sendMessage } = setup(json({ type: "action", action: "capture_note", input: {} }), () => Promise.reject(new Error("offline")));
    expect((await handler(event("anote isso: x"))).statusCode).toBe(500);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("/anotar grava o texto sem o comando e sem chamar o modelo", async () => {
    const { handler, cap, sendMessage, converse } = setup(json({ type: "reply", message: "x" }));
    await handler(event("/anotar estudar System Design"));
    expect(cap.mock.calls[0]![0].note.originalContent).toBe("estudar System Design");
    expect(sendMessage).toHaveBeenCalledWith(777, expect.stringContaining("telegram-777-42"));
    expect(converse).not.toHaveBeenCalled();
  });

  it("formato antigo com categoria (ideia: ...) continua capturando sem o modelo", async () => {
    const { handler, cap, converse } = setup(json({ type: "reply", message: "x" }));
    await handler(event("ideia: app de receitas #cozinha"));
    expect(cap.mock.calls[0]![0].note.category).toBe("ideia");
    expect(converse).not.toHaveBeenCalled();
  });

  it("/anotar vazio e comandos desconhecidos não criam nota", async () => {
    const { handler, cap, sendMessage } = setup(json({ type: "reply", message: "x" }));
    await handler(event("/anotar"));
    await handler(event("/start"));
    expect(cap).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("modelo indisponível ou saída inválida: avisa e NÃO captura", async () => {
    for (const converse of [vi.fn(async () => Promise.reject(Object.assign(new Error("x"), { name: "ThrottlingException" }))), vi.fn(async () => ({ text: "lixo" })), json({ type: "action", action: "delete_note", input: {} })]) {
      const { handler, cap, sendMessage } = setup(converse);
      expect((await handler(event("me ajuda a organizar meus estudos"))).statusCode).toBe(200);
      expect(cap).not.toHaveBeenCalled();
      expect(sendMessage).toHaveBeenCalledWith(777, AI_UNAVAILABLE_TEXT);
    }
  });

  it("sem conversation (IA desligada) mantém a captura de qualquer texto", async () => {
    const cap = vi.fn();
    const handler = createRenatoWebhookHandler({
      webhookSecret: "s", allowedChatIds: new Set([777]),
      handleUpdate: createTelegramHandler({ clock: fixedClock("2026-01-15T15:30:00.000Z"), capture: cap }),
      sendMessage: vi.fn(async () => undefined),
    });
    await handler(event("Oi, Renato!"));
    expect(cap).toHaveBeenCalledOnce();
  });

  it("chat não autorizado nunca chega ao modelo", async () => {
    const { handler, converse, sendMessage } = setup(json({ type: "reply", message: "x" }));
    const e = event("oi");
    e.body = JSON.stringify({ update_id: 1, message: { message_id: 1, date: 1, chat: { id: 5 }, text: "oi" } });
    expect((await handler(e)).statusCode).toBe(200);
    expect(converse).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("o prompt do Renato não fala do Hermes nem oferece ações do Hermes", () => {
    expect(SYSTEM_PROMPT).not.toMatch(/Hermes|create_task|show_today/);
  });
});

describe("explicitCapture", () => {
  it.each([
    ["/anotar ideia legal", "ideia legal"],
    ["ideia: app", "ideia: app"],
    ["algo #estudo", "algo #estudo"],
    ["/anotar", null],
    ["Oi", null],
    ["/start", null],
    ["Guarde isso: x", null],
  ])("%s", (input, expected) => expect(explicitCapture(input)).toBe(expected));
});

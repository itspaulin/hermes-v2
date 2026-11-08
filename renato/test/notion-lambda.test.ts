import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { NotionApiError, NotionUnavailable } from "../../shared/notion/errors.js";
import { createRenatoWebhookHandler, NOTION_FAILURE_TEXT, NOTION_HELP_TEXT } from "../src/lambda.js";
import type { TurnInput } from "../src/notion/assistant.js";

type Turn = (turn: TurnInput) => Promise<string>;
type Send = (chatId: number, text: string) => Promise<void>;
const turnFn = (impl: Turn) => vi.fn<Turn>(impl);

function event(text: string | undefined, chatId = 777): APIGatewayProxyEventV2 {
  return {
    version: "2.0", routeKey: "POST /renato/webhook", rawPath: "/renato/webhook", rawQueryString: "",
    headers: { "x-telegram-bot-api-secret-token": "s" },
    requestContext: { accountId: "t", apiId: "t", domainName: "e", domainPrefix: "e", http: { method: "POST", path: "/renato/webhook", protocol: "HTTP/1.1", sourceIp: "1", userAgent: "t" }, requestId: "t", routeKey: "k", stage: "$default", time: "t", timeEpoch: 1 },
    isBase64Encoded: false,
    body: JSON.stringify({ update_id: 1, message: { message_id: 42, date: 1768491000, chat: { id: chatId }, ...(text !== undefined && { text }) } }),
  };
}

function setup(over: { assistant?: ReturnType<typeof turnFn> | null; send?: ReturnType<typeof vi.fn<Send>> } = {}) {
  const capture = turnFn(async () => "capturado");
  const assistant = over.assistant === null ? undefined : (over.assistant ?? turnFn(async () => "resposta do assistente"));
  const sendMessage = over.send ?? vi.fn<Send>(async () => undefined);
  const handleUpdate = vi.fn();
  const handler = createRenatoWebhookHandler({
    webhookSecret: "s",
    allowedChatIds: new Set([777]),
    handleUpdate,
    sendMessage,
    notion: { capture, ...(assistant && { assistant }) },
  });
  return { handler, capture, assistant, sendMessage, handleUpdate };
}

beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

describe("Renato no modo Notion", () => {
  it("texto comum vai ao assistente com os dados da mensagem, e a resposta volta ao chat", async () => {
    const { handler, assistant, sendMessage, handleUpdate } = setup();
    const res = await handler(event("li sobre CAP theorem"));
    expect(res.statusCode).toBe(200);
    expect(assistant).toHaveBeenCalledWith({ text: "li sobre CAP theorem", chatId: 777, messageId: 42, epochSeconds: 1768491000 });
    expect(sendMessage).toHaveBeenCalledWith(777, "resposta do assistente");
    expect(handleUpdate).not.toHaveBeenCalled(); // nada vai para o Vault
  });

  it("/anotar guarda o texto exato, sem passar pelo modelo (inclusive com @bot)", async () => {
    const { handler, capture, assistant, sendMessage } = setup();
    await handler(event("/anotar texto exato\ncom duas linhas"));
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({ text: "texto exato\ncom duas linhas", chatId: 777, messageId: 42 }));
    await handler(event("/Anotar@renato_bot outro"));
    expect(capture).toHaveBeenLastCalledWith(expect.objectContaining({ text: "outro" }));
    expect(assistant).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(777, "capturado");
  });

  it("/anotar sem texto mostra o uso; outros comandos mostram a ajuda", async () => {
    const { handler, capture, assistant, sendMessage } = setup();
    await handler(event("/anotar"));
    expect(sendMessage).toHaveBeenLastCalledWith(777, "Uso: /anotar <texto>");
    await handler(event("/start"));
    expect(sendMessage).toHaveBeenLastCalledWith(777, NOTION_HELP_TEXT);
    expect(capture).not.toHaveBeenCalled();
    expect(assistant).not.toHaveBeenCalled();
  });

  it("sem IA (sem assistente), todo texto vira nota literal na Caixa de entrada", async () => {
    const { handler, capture } = setup({ assistant: null });
    await handler(event("qualquer coisa"));
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({ text: "qualquer coisa" }));
  });

  it("mensagem sem texto é ignorada; chat não autorizado nunca chega ao assistente", async () => {
    const { handler, assistant, sendMessage } = setup();
    expect((await handler(event(undefined))).statusCode).toBe(200);
    expect((await handler(event("oi", 999))).statusCode).toBe(200);
    expect(assistant).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("erro de configuração do Notion responde 200 com aviso (reenviar não adianta)", async () => {
    const { handler, sendMessage } = setup({ assistant: turnFn(async () => Promise.reject(new NotionApiError(404, "object_not_found", "x"))) });
    const res = await handler(event("oi"));
    expect(res.statusCode).toBe(200);
    expect(sendMessage).toHaveBeenCalledWith(777, NOTION_FAILURE_TEXT);
  });

  it("Notion indisponível ou erro inesperado responde 500 (o Telegram reenvia) e não responde ao usuário", async () => {
    for (const err of [new NotionUnavailable("fora"), new Error("bug")]) {
      const { handler, sendMessage } = setup({ assistant: turnFn(async () => Promise.reject(err)) });
      expect((await handler(event("oi"))).statusCode).toBe(500);
      expect(sendMessage).not.toHaveBeenCalled();
    }
  });

  it("falha ao enviar a resposta ao Telegram responde 500", async () => {
    const { handler } = setup({ send: vi.fn<Send>(async () => Promise.reject(new Error("telegram fora"))) });
    expect((await handler(event("oi"))).statusCode).toBe(500);
  });
});

describe("/tema e /notas no webhook", () => {
  it("chamam os comandos (com @bot e com o texto da mensagem respondida) sem passar pelo modelo", async () => {
    const tema = vi.fn(async () => "tema ok");
    const notas = vi.fn(async () => "notas ok");
    const assistant = turnFn(async () => "assistente");
    const sendMessage = vi.fn<Send>(async () => undefined);
    const handler = createRenatoWebhookHandler({
      webhookSecret: "s",
      allowedChatIds: new Set([777]),
      handleUpdate: vi.fn(),
      sendMessage,
      notion: { capture: turnFn(async () => "c"), assistant, commands: { tema, notas } },
    });
    const withReply = (text: string): APIGatewayProxyEventV2 => {
      const e = event(text);
      const body = JSON.parse(e.body!);
      body.message.reply_to_message = { text: "Anotei: X\nhttps://www.notion.so/X-41263ec9e8d281b2b5fde9169681b892" };
      return { ...e, body: JSON.stringify(body) };
    };

    await handler(withReply("/tema System Design"));
    expect(tema).toHaveBeenCalledWith(expect.objectContaining({ chatId: 777 }), "System Design", expect.stringContaining("notion.so"));
    await handler(event("/Notas@renato_bot cap"));
    expect(notas).toHaveBeenCalledWith("cap");
    await handler(event("/notas"));
    expect(notas).toHaveBeenLastCalledWith("");
    expect(sendMessage).toHaveBeenCalledWith(777, "tema ok");
    expect(sendMessage).toHaveBeenCalledWith(777, "notas ok");
    expect(assistant).not.toHaveBeenCalled();
  });
});

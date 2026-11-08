import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import type { Converse } from "../../shared/ai/bedrock.js";
import { NotionApiError, NotionUnavailable } from "../../shared/notion/errors.js";
import type { AiConfig } from "../../shared/ai/types.js";
import { FakeNotion } from "../../test/support/fake-notion.js";
import { createNotionAi, createNotionAssistant, type TurnImage, type TurnInput } from "../src/notion/assistant.js";
import { createImageCapture } from "../src/notion/capture.js";
import { IMAGE_ERRORS, IMAGE_UNSUPPORTED_TEXT, createRenatoWebhookHandler } from "../src/lambda.js";
import { NotasRepository } from "../src/notion/notas.js";
import { TemaRepository } from "../src/notion/temas.js";

const config: AiConfig = { modelId: "m", region: "us-east-1", apiKeyParam: "/p", maxHistoryMessages: 4, maxInputChars: 500, maxOutputTokens: 100, timeoutMs: 1000 };
const EPOCH = Date.parse("2026-11-07T21:23:00Z") / 1000;
const T0 = "2026-11-07T18:23:00-03:00";
const image: TurnImage = { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), format: "png", contentType: "image/png", filename: "imagem.png" };
const content = { topicos: [{ titulo: "Camadas", pontos: ["cliente chama a API"] }], conceitos: [], lacunas: [], transcricao: "Cliente -> API -> Banco" };
const action = (name: string, input: unknown) => ({ type: "action", action: name, input });
const json = (o: unknown): Converse => vi.fn(async () => ({ text: JSON.stringify(o) }));

let notion: FakeNotion;
let temas: TemaRepository;
let notas: NotasRepository;
const notasRows = () => notion.pages.filter((p) => p.database === "db-notas");

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  notion = new FakeNotion();
  temas = new TemaRepository(notion, "db-temas");
  notas = new NotasRepository(notion, "db-notas", temas);
});
afterEach(() => vi.restoreAllMocks());

const upload = (n: FakeNotion) => (f: string, t: string, b: Uint8Array) => n.upload(f, t, b);
const turn = (over: Partial<TurnInput> = {}): TurnInput => ({ text: "arquitetura do projeto", image, chatId: 7, messageId: 50, epochSeconds: EPOCH, ...over });

describe("assistente com imagem", () => {
  it("manda a imagem ao modelo, sobe para o Notion e cria a nota com Origem=imagem, imagem logo após o resumo e transcrição do modelo (com a legenda)", async () => {
    const converse = vi.fn(async () => ({ text: JSON.stringify(action("save_note", { titulo: "Arquitetura", resumo: "Camadas.", tipo: "diagrama", conteudo: content })) }));
    const run = createNotionAssistant({ ai: createNotionAi(config, converse), temas, notas, upload: upload(notion) });
    const reply = await run(turn());

    const req = (converse.mock.calls[0] as unknown as [{ messages: { text: string; images?: { format: string }[] }[] }])[0];
    expect(req.messages.at(-1)).toMatchObject({ text: "arquitetura do projeto", images: [{ format: "png" }] });
    expect(notion.uploads).toHaveLength(1);
    expect(notion.uploads[0]).toMatchObject({ filename: "imagem.png", contentType: "image/png" });

    const page = notasRows()[0]!;
    expect(page.properties.Origem.select.name).toBe("imagem");
    const kinds = page.children!.map((b: any) => b.type);
    expect(kinds.slice(0, 2)).toEqual(["paragraph", "image"]);
    expect(page.children![1]).toEqual({ type: "image", image: { type: "file_upload", file_upload: { id: notion.uploads[0]!.id } } });
    const body = JSON.stringify(page.children);
    expect(body).toContain("Transcrição da imagem (feita pelo Renato, pode ter erros)");
    expect(body).toContain("Legenda: arquitetura do projeto");
    expect(body).toContain("Cliente -> API -> Banco");
    expect(reply).toContain("Anotei: Arquitetura");
  });

  it("imagem sem legenda: o modelo recebe um texto no lugar, e a transcrição é só a do modelo", async () => {
    const converse = vi.fn(async () => ({ text: JSON.stringify(action("save_note", { titulo: "X", resumo: "r", tipo: "resumo", conteudo: content })) }));
    await createNotionAssistant({ ai: createNotionAi(config, converse), temas, notas, upload: upload(notion) })(turn({ text: "" }));
    const req = (converse.mock.calls[0] as unknown as [{ messages: { text: string }[] }])[0];
    expect(req.messages.at(-1)!.text).toBe("(imagem enviada sem legenda)");
    expect(JSON.stringify(notasRows()[0]!.children)).not.toContain("Legenda:");
  });

  it("o Notion recusar o arquivo não perde a nota: sai sem imagem, com aviso; Notion fora do ar propaga (retry)", async () => {
    const make = () => createNotionAssistant({ ai: createNotionAi(config, json(action("save_note", { titulo: "X", resumo: "r", tipo: "resumo", conteudo: content }))), temas, notas, upload: upload(notion) });
    notion.failWith = (m) => (m === "UPLOAD" ? new NotionApiError(400, "validation_error", "arquivo grande") : undefined);
    const reply = await make()(turn());
    expect(reply).toContain("Não consegui anexar a imagem");
    expect(JSON.stringify(notasRows()[0]!.children)).not.toContain('"type":"image"');

    notion.failWith = (m) => (m === "UPLOAD" ? new NotionUnavailable("fora") : undefined);
    await expect(make()(turn({ messageId: 51 }))).rejects.toBeInstanceOf(NotionUnavailable);
    expect(notasRows()).toHaveLength(1);
  });

  it("reenvio do Telegram da mesma imagem não sobe o arquivo de novo nem duplica a nota", async () => {
    const run = createNotionAssistant({ ai: createNotionAi(config, json(action("save_note", { titulo: "X", resumo: "r", tipo: "resumo", conteudo: content }))), temas, notas, upload: upload(notion) });
    await run(turn());
    expect(await run(turn())).toContain("Essa nota já existia");
    expect(notion.uploads).toHaveLength(1);
    expect(notasRows()).toHaveLength(1);
  });

  it("append_to_note com imagem acrescenta o complemento com a imagem, sem mexer no resto", async () => {
    const inbox = await temas.inbox(T0);
    await notas.create({ id: "n-1", title: "Arquitetura", summary: "r", tipo: "diagrama", origem: "texto", temaPageId: inbox.pageId, createdAt: T0, blocks: [{ type: "paragraph", paragraph: { rich_text: [] } }] });
    const run = createNotionAssistant({ ai: createNotionAi(config, json(action("append_to_note", { id: "n-1", conteudo: content }))), temas, notas, upload: upload(notion) });
    expect(await run(turn({ text: "adiciona essa imagem" }))).toContain('Acrescentei na nota "Arquitetura"');
    const children = notasRows()[0]!.children as { type: string }[];
    expect(children[0]).toEqual({ type: "paragraph", paragraph: { rich_text: [] } });
    expect(children.map((b) => b.type)).toContain("image");
    expect(notasRows()).toHaveLength(1);
  });

  it("o histórico guarda a mensagem marcada como imagem", async () => {
    const append = vi.fn(async () => {});
    const history = { load: vi.fn(async () => []), append };
    const run = createNotionAssistant({ ai: createNotionAi(config, json({ type: "reply", message: "Bonito." })), temas, notas, upload: upload(notion), history });
    await run(turn({ text: "olha isso" }));
    expect(append).toHaveBeenCalledWith(7, [{ role: "user", text: "[imagem] olha isso" }, { role: "assistant", text: "Bonito." }]);
  });
});

describe("captura de imagem sem modelo (/guardar)", () => {
  it("guarda a imagem na Caixa de entrada com a legenda; título da legenda ou 'Imagem DD/MM/AAAA'", async () => {
    const capture = createImageCapture({ temas, notas, upload: upload(notion) });
    expect(await capture(turn({ text: "diagrama do checkout\ndetalhe" }))).toContain("Guardei a imagem na Caixa de entrada: diagrama do checkout");
    expect(await capture(turn({ text: "", messageId: 51 }))).toContain("Imagem 07/11/2026");
    const first = notasRows()[0]!;
    expect(first.properties.Origem.select.name).toBe("imagem");
    expect((first.children as { type: string }[])[0]!.type).toBe("image");
    expect(JSON.stringify(first.children)).toContain("detalhe");
    expect(await capture(turn({ text: "diagrama do checkout\ndetalhe" }))).toContain("já existia");
    expect(notasRows()).toHaveLength(2);
  });
  it("sem imagem não faz nada", async () => {
    expect(await createImageCapture({ temas, notas, upload: upload(notion) })(turn({ image: undefined as never }))).toBe("Não recebi nenhuma imagem.");
  });
});

function photoEvent(caption?: string, extra: Record<string, unknown> = {}): APIGatewayProxyEventV2 {
  return {
    version: "2.0", routeKey: "k", rawPath: "/renato/webhook", rawQueryString: "",
    headers: { "x-telegram-bot-api-secret-token": "s" },
    requestContext: { accountId: "t", apiId: "t", domainName: "e", domainPrefix: "e", http: { method: "POST", path: "/renato/webhook", protocol: "HTTP/1.1", sourceIp: "1", userAgent: "t" }, requestId: "t", routeKey: "k", stage: "$default", time: "t", timeEpoch: 1 },
    isBase64Encoded: false,
    body: JSON.stringify({ update_id: 1, message: { message_id: 42, date: 1768491000, chat: { id: 777 }, photo: [{ file_id: "f1", file_size: 100 }], ...(caption !== undefined && { caption }), ...extra } }),
  };
}

describe("webhook com imagem", () => {
  const dl = { ok: true as const, bytes: image.bytes, format: "png" as const, contentType: "image/png", filename: "imagem.png" };
  function setup(over: { download?: ReturnType<typeof vi.fn>; assistant?: ReturnType<typeof vi.fn> | null; noImage?: boolean } = {}) {
    const downloadImage = over.download ?? vi.fn(async () => dl);
    const captureImage = vi.fn(async (_t: TurnInput) => "guardada");
    const assistant = over.assistant === null ? undefined : (over.assistant ?? vi.fn(async (_t: TurnInput) => "assistente"));
    const sendMessage = vi.fn(async () => undefined);
    const handler = createRenatoWebhookHandler({
      webhookSecret: "s", allowedChatIds: new Set([777]), handleUpdate: vi.fn(), sendMessage,
      notion: { capture: vi.fn(async () => "c"), ...(assistant && { assistant: assistant as never }), ...(over.noImage ? {} : { downloadImage: downloadImage as never, captureImage }) },
    });
    return { handler, downloadImage, captureImage, assistant, sendMessage };
  }

  it("foto com legenda vai ao assistente com a imagem baixada e a legenda como texto", async () => {
    const { handler, downloadImage, assistant, sendMessage } = setup();
    expect((await handler(photoEvent("arquitetura"))).statusCode).toBe(200);
    expect(downloadImage).toHaveBeenCalledWith("f1");
    expect(assistant).toHaveBeenCalledWith(expect.objectContaining({ text: "arquitetura", chatId: 777, messageId: 42, image: expect.objectContaining({ format: "png", filename: "imagem.png" }) }));
    expect(sendMessage).toHaveBeenCalledWith(777, "assistente");
  });

  it("/guardar na legenda guarda sem modelo (texto = o resto da legenda); sem IA, toda imagem é guardada", async () => {
    const a = setup();
    await a.handler(photoEvent("/guardar meu diagrama"));
    expect(a.captureImage).toHaveBeenCalledWith(expect.objectContaining({ text: "meu diagrama" }));
    expect(a.assistant).not.toHaveBeenCalled();
    const b = setup({ assistant: null });
    await b.handler(photoEvent("qualquer"));
    expect(b.captureImage).toHaveBeenCalledWith(expect.objectContaining({ text: "qualquer" }));
  });

  it("arquivo enviado como documento de imagem também vale; documento que não é imagem é ignorado", async () => {
    const a = setup();
    const doc = photoEvent(undefined, { photo: undefined, document: { file_id: "d1", mime_type: "image/png" } });
    await a.handler(doc);
    expect(a.downloadImage).toHaveBeenCalledWith("d1");
    const b = setup();
    expect((await b.handler(photoEvent(undefined, { photo: undefined, document: { file_id: "d2", mime_type: "application/pdf" } }))).statusCode).toBe(200);
    expect(b.downloadImage).not.toHaveBeenCalled();
    expect(b.sendMessage).not.toHaveBeenCalled();
  });

  it("imagem grande, que não é imagem ou indisponível: avisa o usuário e não chama o assistente", async () => {
    for (const reason of ["too_big", "not_image", "unavailable"] as const) {
      const s = setup({ download: vi.fn(async () => ({ ok: false as const, reason })) });
      await s.handler(photoEvent("x"));
      expect(s.sendMessage).toHaveBeenCalledWith(777, IMAGE_ERRORS[reason]);
      expect(s.assistant).not.toHaveBeenCalled();
    }
  });

  it("sem suporte a imagem configurado, avisa; falha de rede no download responde 500", async () => {
    const s = setup({ noImage: true });
    await s.handler(photoEvent("x"));
    expect(s.sendMessage).toHaveBeenCalledWith(777, IMAGE_UNSUPPORTED_TEXT);
    const f = setup({ download: vi.fn(async () => Promise.reject(new Error("rede"))) });
    expect((await f.handler(photoEvent("x"))).statusCode).toBe(500);
    expect(f.sendMessage).not.toHaveBeenCalled();
  });
});

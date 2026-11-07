import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAiConfig } from "../shared/ai/config.js";
import { parseDecision } from "../shared/ai/decision.js";
import { createAiService } from "../shared/ai/service.js";
import type { Converse } from "../shared/ai/bedrock.js";
import type { AiConfig } from "../shared/ai/types.js";

const config: AiConfig = { modelId: "model-x", region: "us-east-1", apiKeyParam: "/p/key", maxHistoryMessages: 2, maxInputChars: 50, maxOutputTokens: 77, timeoutMs: 1000 };
type Acts = { ping: { n: number } };
const schemas = { ping: (i: unknown) => (typeof (i as { n?: unknown })?.n === "number" ? { n: (i as { n: number }).n } : null) };

function service(converse: Converse, cfg = config) {
  return createAiService<Acts>({ assistant: "hermes", systemPrompt: "SYS-HERMES", schemas, config: cfg, converse });
}
const say = (text: string) => vi.fn<Converse>(async () => ({ text }));

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("parseDecision", () => {
  it("aceita reply, clarify e JSON em bloco de código", () => {
    expect(parseDecision('{"type":"reply","message":" oi "}', schemas)).toEqual({ type: "reply", message: "oi" });
    expect(parseDecision('```json\n{"type":"clarify","message":"qual?"}\n```', schemas)).toEqual({ type: "clarify", message: "qual?" });
  });
  it("aceita ação da allowlist com input válido", () => {
    expect(parseDecision('{"type":"action","action":"ping","input":{"n":1}}', schemas)).toEqual({ type: "action", action: "ping", input: { n: 1 } });
  });
  it.each([
    "",
    "oi, tudo bem?",
    "[]",
    '{"type":"reply"}',
    '{"type":"reply","message":""}',
    '{"type":"outro","message":"x"}',
    '{"type":"action","action":"delete_all","input":{}}',
    '{"type":"action","action":"constructor","input":{}}',
    '{"type":"action","action":"toString","input":{}}',
    '{"type":"action","action":"ping","input":{"n":"1"}}',
    '{"type":"action","action":"ping"}',
    '{"type":"action","input":{"n":1}}',
  ])("rejeita saída fora do contrato: %s", (raw) => {
    expect(parseDecision(raw, schemas)).toBeNull();
  });
});

describe("createAiService", () => {
  it("monta o pedido com modelo, prompt, contexto e limite de saída configurados", async () => {
    const converse = say('{"type":"reply","message":"oi"}');
    const r = await service(converse).decide({ message: "  olá ", context: "Data: X" });
    expect(r).toEqual({ ok: true, decision: { type: "reply", message: "oi" } });
    const [req, signal] = converse.mock.calls[0]!;
    expect(req).toMatchObject({ modelId: "model-x", maxTokens: 77, system: "SYS-HERMES\n\nData: X", messages: [{ role: "user", text: "olá" }] });
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("limita o histórico e mantém a alternância começando pelo usuário", async () => {
    const converse = say('{"type":"reply","message":"ok"}');
    await service(converse).decide({
      message: "agora",
      history: [
        { role: "user", text: "a" },
        { role: "assistant", text: "b" },
        { role: "user", text: "c" },
        { role: "assistant", text: "d" },
      ],
    });
    // maxHistoryMessages = 2: só "c","d"; mais a mensagem atual
    expect(converse.mock.calls[0]![0].messages.map((m: { text: string }) => m.text)).toEqual(["c", "d", "agora"]);
  });

  it("descarta histórico que terminaria em dois turnos de usuário seguidos", async () => {
    const converse = say('{"type":"reply","message":"ok"}');
    await service(converse).decide({ message: "agora", history: [{ role: "assistant", text: "x" }, { role: "user", text: "y" }] });
    expect(converse.mock.calls[0]![0].messages).toEqual([{ role: "user", text: "agora" }]);
  });

  it("não chama o modelo se a entrada passa do limite ou é vazia", async () => {
    const converse = vi.fn<Converse>();
    expect(await service(converse).decide({ message: "x".repeat(51) })).toEqual({ ok: false, reason: "input_too_long" });
    expect(await service(converse).decide({ message: "   " })).toMatchObject({ ok: false });
    expect(converse).not.toHaveBeenCalled();
  });

  it.each([
    ["ThrottlingException", "throttled"],
    ["TimeoutError", "timeout"],
    ["AbortError", "timeout"],
    ["ValidationException", "error"],
  ])("erro %s vira %s e não lança", async (name, reason) => {
    const err = Object.assign(new Error("segredo-na-mensagem"), { name });
    expect(await service(async () => Promise.reject(err)).decide({ message: "oi" })).toEqual({ ok: false, reason });
  });

  it("resposta vazia ou malformada vira invalid_output", async () => {
    expect(await service(say("")).decide({ message: "oi" })).toEqual({ ok: false, reason: "invalid_output" });
    expect(await service(say("não sou json")).decide({ message: "oi" })).toEqual({ ok: false, reason: "invalid_output" });
  });

  it("não registra conteúdo da conversa nem da resposta nos logs", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => void logs.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a) => void logs.push(a.join(" ")));
    await service(say('{"type":"reply","message":"RESPOSTA-SECRETA"}')).decide({ message: "MENSAGEM-SECRETA" });
    await service(async () => Promise.reject(Object.assign(new Error("MENSAGEM-SECRETA"), { name: "X" }))).decide({ message: "MENSAGEM-SECRETA" });
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join("\n")).not.toMatch(/SECRET/);
  });
});

describe("loadAiConfig", () => {
  it("fica desligada por padrão e sem modelo/região", () => {
    expect(loadAiConfig({})).toBeNull();
    expect(loadAiConfig({ AI_ENABLED: "false", BEDROCK_MODEL_ID: "m", AWS_REGION: "r" })).toBeNull();
    expect(loadAiConfig({ AI_ENABLED: "true", AWS_REGION: "r" })).toBeNull();
    expect(loadAiConfig({ AI_ENABLED: "true", BEDROCK_MODEL_ID: "m", AWS_REGION: "r" })).toBeNull(); // sem BEDROCK_API_KEY_PARAM
    expect(loadAiConfig({ AI_ENABLED: "true", BEDROCK_MODEL_ID: "m", BEDROCK_API_KEY_PARAM: "/p/key" })).toBeNull();
  });
  it("liga com defaults, região do Bedrock sobrepondo a da Lambda, e limita valores", () => {
    const c = loadAiConfig({ AI_ENABLED: "TRUE", BEDROCK_MODEL_ID: "m", BEDROCK_API_KEY_PARAM: "/p/key", AWS_REGION: "sa-east-1", BEDROCK_REGION: "us-east-1", AI_MAX_OUTPUT_TOKENS: "999999", AI_MAX_INPUT_CHARS: "abc" });
    expect(c).toMatchObject({ modelId: "m", region: "us-east-1", apiKeyParam: "/p/key", maxOutputTokens: 1000, maxInputChars: 1000, maxHistoryMessages: 6 });
  });
});

describe("explainRejection: motivo da recusa, sem conteúdo", () => {
  const schemas = { go: (i: unknown) => (typeof i === "object" && i !== null ? ({} as Record<string, never>) : null) };
  it.each([
    ["bla bla", "json_invalid"],
    ['{"type":"outro"}', "type_unknown"],
    ['{"type":"reply"}', "message_invalid"],
    ['{"type":"action","action":"apagar_tudo","input":{}}', "action_not_allowed"],
    ['{"type":"action","action":"go","input":5}', "input_invalid"],
  ])("%s -> %s", async (raw, expected) => {
    const { explainRejection } = await import("../shared/ai/decision.js");
    expect(explainRejection(raw, schemas)).toBe(expected);
  });
});

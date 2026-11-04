import { afterEach, describe, expect, it, vi } from "vitest";
import { createBedrockConverse, loadConverse } from "../shared/ai/bedrock.js";

const req = { modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0", system: "SYS", messages: [{ role: "user" as const, text: "oi" }], maxTokens: 50, temperature: 0.5 };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

afterEach(() => vi.restoreAllMocks());

describe("createBedrockConverse", () => {
  it("chama a Converse API com bearer token e devolve texto e tokens", async () => {
    const fetchMock = vi.fn(async () =>
      json(200, { output: { message: { content: [{ text: "olá, " }, { text: "tudo bem?" }] } }, usage: { inputTokens: 10, outputTokens: 4 } }),
    );
    const converse = createBedrockConverse({ apiKey: "KEY", region: "us-east-1", fetch: fetchMock as unknown as typeof fetch });
    const out = await converse(req, AbortSignal.timeout(1000));
    expect(out).toEqual({ text: "olá, tudo bem?", inputTokens: 10, outputTokens: 4 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://bedrock-runtime.us-east-1.amazonaws.com/model/us.anthropic.claude-haiku-4-5-20251001-v1%3A0/converse");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer KEY");
    expect(JSON.parse(init.body as string)).toEqual({
      system: [{ text: "SYS" }],
      messages: [{ role: "user", content: [{ text: "oi" }] }],
      inferenceConfig: { maxTokens: 50, temperature: 0.5 },
    });
  });

  it("429 vira ThrottlingException e o erro não carrega o corpo da resposta", async () => {
    const fetchMock = vi.fn(async () => json(429, { message: "ECO-SECRETO" }));
    const converse = createBedrockConverse({ apiKey: "KEY", region: "us-east-1", fetch: fetchMock as unknown as typeof fetch });
    const err = await converse(req, AbortSignal.timeout(1000)).catch((e: Error) => e);
    expect((err as Error).name).toBe("ThrottlingException");
    expect((err as Error).message).not.toMatch(/SECRETO/);
  });

  it("usa o __type do corpo quando existe", async () => {
    const fetchMock = vi.fn(async () => json(400, { __type: "com.amazon#ServiceQuotaExceededException" }));
    const converse = createBedrockConverse({ apiKey: "KEY", region: "us-east-1", fetch: fetchMock as unknown as typeof fetch });
    const err = await converse(req, AbortSignal.timeout(1000)).catch((e: Error) => e);
    expect((err as Error).name).toBe("ServiceQuotaExceededException");
  });
});

describe("loadConverse", () => {
  it("lê a key do parâmetro informado", async () => {
    const read = vi.fn(async () => "KEY");
    expect(await loadConverse({ apiKeyParam: "/p/key", region: "us-east-1" }, read)).toBeTypeOf("function");
    expect(read).toHaveBeenCalledWith("/p/key");
  });

  it("falha ao ler a key desliga a IA sem lançar e sem logar o valor", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a) => void logs.push(a.join(" ")));
    expect(await loadConverse({ apiKeyParam: "/p/key", region: "us-east-1" }, async () => Promise.reject(new Error("Falha ao ler o parâmetro SSM /p/key: ParameterNotFound")))).toBeUndefined();
    expect(await loadConverse({ apiKeyParam: "/p/key", region: "us-east-1" }, async () => "  ")).toBeUndefined();
    expect(logs.length).toBe(2);
  });
});

/** Imagem anexada a uma mensagem do usuário. Formatos aceitos pelo Converse: png, jpeg, gif, webp. */
export interface ConverseImage {
  format: "png" | "jpeg" | "gif" | "webp";
  bytes: Uint8Array;
}

export interface ConverseRequest {
  modelId: string;
  system: string;
  messages: { role: "user" | "assistant"; text: string; images?: ConverseImage[] }[];
  maxTokens: number;
  temperature: number;
}

export interface ConverseResponse {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
}

/** Fronteira com o Bedrock: o serviço só conhece esta função, os testes injetam uma falsa. */
export type Converse = (request: ConverseRequest, signal: AbortSignal) => Promise<ConverseResponse>;

interface ConverseBody {
  output?: { message?: { content?: { text?: string }[] } };
  usage?: { inputTokens?: number; outputTokens?: number };
}

/** Erro com `name` no formato que o serviço já classifica (ThrottlingException, ServiceQuotaExceededException…). */
function httpError(status: number, bodyText: string): Error {
  let type = "";
  try {
    const parsed = JSON.parse(bodyText) as { __type?: unknown };
    if (typeof parsed.__type === "string") type = parsed.__type.split("#").pop() ?? "";
  } catch {
    // corpo não-JSON: segue só com o status
  }
  const err = new Error(`Bedrock respondeu ${status}`);
  err.name = type || (status === 429 ? "ThrottlingException" : `BedrockHttp${status}`);
  return err;
}

/**
 * Converse API via API key do Bedrock (bearer token), sem SDK nem perfil IAM. Sem retry: o timeout do
 * serviço é curto e o usuário pode reenviar. O corpo do erro nunca é logado (pode ecoar o pedido).
 */
export function createBedrockConverse(options: { apiKey: string; region: string; fetch?: typeof fetch }): Converse {
  const doFetch = options.fetch ?? fetch;
  const base = `https://bedrock-runtime.${options.region}.amazonaws.com`;
  return async (req, signal) => {
    const response = await doFetch(`${base}/model/${encodeURIComponent(req.modelId)}/converse`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.apiKey}` },
      body: JSON.stringify({
        system: [{ text: req.system }],
        messages: req.messages.map((m) => ({
          role: m.role,
          content: [
            ...(m.images ?? []).map((img) => ({ image: { format: img.format, source: { bytes: Buffer.from(img.bytes).toString("base64") } } })),
            { text: m.text },
          ],
        })),
        inferenceConfig: { maxTokens: req.maxTokens, temperature: req.temperature },
      }),
      signal,
    });
    if (!response.ok) throw httpError(response.status, await response.text().catch(() => ""));
    const out = (await response.json()) as ConverseBody;
    const text = (out.output?.message?.content ?? []).map((c) => c.text ?? "").join("");
    return {
      text,
      ...(out.usage?.inputTokens !== undefined && { inputTokens: out.usage.inputTokens }),
      ...(out.usage?.outputTokens !== undefined && { outputTokens: out.usage.outputTokens }),
    };
  };
}

/**
 * Lê a API key (SSM) e monta o Converse. Falha ao ler a key desliga a IA em vez de derrubar o bot:
 * comandos e capturas seguem funcionando.
 */
export async function loadConverse(
  config: { apiKeyParam: string; region: string },
  readParameter: (name: string) => Promise<string>,
): Promise<Converse | undefined> {
  try {
    const apiKey = (await readParameter(config.apiKeyParam)).trim();
    if (apiKey === "") throw new Error("vazio");
    return createBedrockConverse({ apiKey, region: config.region });
  } catch (err) {
    const name = typeof err === "object" && err !== null && "message" in err ? String((err as { message: unknown }).message) : "erro";
    console.error(`[ai] sem API key do Bedrock (${config.apiKeyParam}); camada de IA desligada: ${name}`);
    return undefined;
  }
}

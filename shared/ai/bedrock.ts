import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";

export interface ConverseRequest {
  modelId: string;
  system: string;
  messages: { role: "user" | "assistant"; text: string }[];
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

/** maxAttempts 2 = no máximo 1 retry do SDK, e só em falhas transitórias (throttling, 5xx). */
export function createBedrockConverse(region: string, client = new BedrockRuntimeClient({ region, maxAttempts: 2 })): Converse {
  return async (req, signal) => {
    const out = await client.send(
      new ConverseCommand({
        modelId: req.modelId,
        system: [{ text: req.system }],
        messages: req.messages.map((m) => ({ role: m.role, content: [{ text: m.text }] })),
        inferenceConfig: { maxTokens: req.maxTokens, temperature: req.temperature },
      }),
      { abortSignal: signal },
    );
    const text = (out.output?.message?.content ?? []).map((c) => c.text ?? "").join("");
    return {
      text,
      ...(out.usage?.inputTokens !== undefined && { inputTokens: out.usage.inputTokens }),
      ...(out.usage?.outputTokens !== undefined && { outputTokens: out.usage.outputTokens }),
    };
  };
}

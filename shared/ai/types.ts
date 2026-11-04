export type AssistantId = "hermes" | "renato";

/** Turno anterior da conversa. Só texto; o chamador decide de onde vem (nenhum armazenamento aqui). */
export interface ConversationTurn {
  role: "user" | "assistant";
  text: string;
}

export type AiFailureReason =
  | "disabled"
  | "input_too_long"
  | "throttled"
  | "timeout"
  | "invalid_output"
  | "error";

export type AiResult<D> = { ok: true; decision: D } | { ok: false; reason: AiFailureReason };

export interface AiConfig {
  modelId: string;
  /** Região do Bedrock Runtime. Pode diferir da região da Lambda (o Haiku 4.5 roda em us-east-1). */
  region: string;
  /** Nome do parâmetro SSM SecureString com a API key (bearer) do Bedrock. */
  apiKeyParam: string;
  maxHistoryMessages: number;
  maxInputChars: number;
  maxOutputTokens: number;
  timeoutMs: number;
}

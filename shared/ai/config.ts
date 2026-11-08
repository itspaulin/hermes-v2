import type { AiConfig } from "./types.js";

type Env = Record<string, string | undefined>;

const DEFAULTS = { maxHistoryMessages: 6, maxInputChars: 1000, maxOutputTokens: 400, timeoutMs: 8000 } as const;

function positiveInt(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, max) : fallback;
}

/**
 * Configuração da camada conversacional, ou null se desligada. Desligada por padrão: só liga com
 * AI_ENABLED=true, BEDROCK_MODEL_ID e BEDROCK_API_KEY_PARAM (nome do parâmetro SSM com a API key do Bedrock)
 * preenchidos (config incompleta nunca derruba o bot).
 * A região vem de BEDROCK_REGION; sem ela, de AWS_REGION (a da Lambda).
 */
export function loadAiConfig(env: Env): AiConfig | null {
  if (env.AI_ENABLED?.trim().toLowerCase() !== "true") return null;
  const modelId = env.BEDROCK_MODEL_ID?.trim();
  const region = env.BEDROCK_REGION?.trim() || env.AWS_REGION?.trim();
  const apiKeyParam = env.BEDROCK_API_KEY_PARAM?.trim();
  if (!modelId || !region || !apiKeyParam) {
    console.error("[ai] AI_ENABLED=true mas falta BEDROCK_MODEL_ID, BEDROCK_API_KEY_PARAM ou região; camada de IA desligada");
    return null;
  }
  return {
    modelId,
    region,
    apiKeyParam,
    maxHistoryMessages: positiveInt(env.AI_MAX_HISTORY_MESSAGES, DEFAULTS.maxHistoryMessages, 20),
    maxInputChars: positiveInt(env.AI_MAX_INPUT_CHARS, DEFAULTS.maxInputChars, 10000),
    maxOutputTokens: positiveInt(env.AI_MAX_OUTPUT_TOKENS, DEFAULTS.maxOutputTokens, 4000),
    timeoutMs: positiveInt(env.AI_TIMEOUT_MS, DEFAULTS.timeoutMs, 25000),
  };
}

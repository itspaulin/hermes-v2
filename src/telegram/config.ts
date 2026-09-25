import type { ParameterReader } from "../ssm.js";
import type { TelegramConfig } from "./types.js";

/** Nomes (não valores) dos parâmetros SSM. A Lambda recebe só isto via env vars. */
export interface TelegramParamNames {
  botToken: string;
  webhookSecret: string;
  allowedChatIds: string;
}

export function telegramParamNamesFromEnv(
  env: Record<string, string | undefined>,
): TelegramParamNames {
  const need = (k: string): string => {
    const v = env[k]?.trim();
    if (!v) throw new Error(`Variável ausente: ${k}`);
    return v;
  };
  return {
    botToken: need("TELEGRAM_BOT_TOKEN_PARAM"),
    webhookSecret: need("TELEGRAM_WEBHOOK_SECRET_PARAM"),
    allowedChatIds: need("TELEGRAM_ALLOWED_CHAT_IDS_PARAM"),
  };
}

/**
 * Busca os três parâmetros em paralelo. O resultado é cacheado pelo chamador
 * (handler) só como otimização de cold start; nada aqui guarda estado.
 * Mensagens de erro nunca incluem valores lidos.
 */
export async function loadTelegramConfig(
  ssm: ParameterReader,
  names: TelegramParamNames,
): Promise<TelegramConfig> {
  const [botToken, webhookSecret, chatIds] = await Promise.all([
    ssm.get(names.botToken),
    ssm.get(names.webhookSecret),
    ssm.get(names.allowedChatIds),
  ]);
  return { botToken, webhookSecret, allowedChatIds: parseChatIds(chatIds) };
}

export function parseChatIds(raw: string): number[] {
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) throw new Error("allowed-chat-ids vazio");
  return parts.map((s) => {
    if (!/^-?\d+$/.test(s)) throw new Error("allowed-chat-ids contém valor não numérico");
    return Number(s);
  });
}

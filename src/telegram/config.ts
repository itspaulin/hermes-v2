import type { TelegramConfig } from "./types.js";

/**
 * Lê a config do Telegram de variáveis de ambiente.
 * Fase atual: env vars. Depois os valores virão do SSM Parameter Store (SecureString).
 */
export function loadTelegramConfig(env: Record<string, string | undefined>): TelegramConfig {
  const botToken = required(env, "TELEGRAM_BOT_TOKEN");
  const webhookSecret = required(env, "TELEGRAM_WEBHOOK_SECRET");
  const allowedChatIds = required(env, "TELEGRAM_ALLOWED_CHAT_IDS")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      if (!/^-?\d+$/.test(s)) throw new Error(`TELEGRAM_ALLOWED_CHAT_IDS inválido: "${s}"`);
      return Number(s);
    });
  if (allowedChatIds.length === 0) throw new Error("TELEGRAM_ALLOWED_CHAT_IDS vazio");
  return { botToken, webhookSecret, allowedChatIds };
}

function required(env: Record<string, string | undefined>, name: string): string {
  const v = env[name]?.trim();
  if (!v) throw new Error(`Variável ausente: ${name}`);
  return v;
}

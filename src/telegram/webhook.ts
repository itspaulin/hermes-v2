import { timingSafeEqual } from "node:crypto";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import type { Clock } from "../time/index.js";
import { TelegramApiError, type TelegramClient } from "./client.js";
import { routeText } from "./router.js";
import type { TelegramConfig, TelegramUpdate } from "./types.js";

export interface WebhookDeps {
  config: TelegramConfig;
  client: TelegramClient;
  clock: Clock;
}

const SECRET_HEADER = "x-telegram-bot-api-secret-token";

const reply = (statusCode: number, body = ""): APIGatewayProxyResultV2 => ({ statusCode, body });

function secretMatches(received: string | undefined, expected: string): boolean {
  if (received === undefined) return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseUpdate(event: APIGatewayProxyEventV2): TelegramUpdate | null {
  if (!event.body) return null;
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  try {
    const u: unknown = JSON.parse(raw);
    if (typeof u !== "object" || u === null) return null;
    if (typeof (u as { update_id?: unknown }).update_id !== "number") return null;
    return u as TelegramUpdate;
  } catch {
    return null;
  }
}

/**
 * Códigos de retorno (o Telegram reenvia o update em qualquer não-2xx):
 * - 401 secret ausente/errado
 * - 400 payload inválido
 * - 200 ignorado (chat não autorizado, update sem texto) ou respondido
 * - 500 falha transitória ao responder (queremos o reenvio)
 */
export async function handleWebhook(
  event: APIGatewayProxyEventV2,
  { config, client, clock }: WebhookDeps,
): Promise<APIGatewayProxyResultV2> {
  if (!secretMatches(event.headers?.[SECRET_HEADER], config.webhookSecret)) {
    return reply(401);
  }

  const update = parseUpdate(event);
  if (!update) return reply(400);

  const message = update.message;
  if (!message || typeof message.text !== "string") return reply(200);

  // Chat não autorizado: ignora em silêncio, sem revelar que o bot existe.
  if (!config.allowedChatIds.includes(message.chat.id)) return reply(200);

  try {
    await client.sendMessage(message.chat.id, routeText(message.text, clock));
  } catch (err) {
    if (err instanceof TelegramApiError) {
      console.error(`[telegram] ${err.message}`);
      return err.retryable ? reply(500) : reply(200);
    }
    throw err;
  }
  return reply(200);
}

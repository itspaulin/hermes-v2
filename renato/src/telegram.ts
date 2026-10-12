// Payloads mínimos do Telegram e validação. Sem rede, sem token, sem SDK.

export interface TelegramChat {
  id: number;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  chat: TelegramChat;
  /** Ausente em mensagens de mídia, stickers etc. */
  text?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export type ParsedUpdate =
  | { kind: "message"; updateId: number; message: TelegramMessage }
  /** Update válido, mas de um tipo que o Renato não trata (edited_message, callback_query...). */
  | { kind: "unsupported"; updateId: number }
  | { kind: "invalid"; errors: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/** Valida um payload já parseado (JSON.parse feito pelo chamador). Nunca lança. */
export function parseTelegramUpdate(payload: unknown): ParsedUpdate {
  if (!isRecord(payload)) return { kind: "invalid", errors: ["payload não é um objeto"] };
  const updateId = payload.update_id;
  if (!isInt(updateId)) return { kind: "invalid", errors: ["update_id inválido"] };

  const raw = payload.message;
  if (raw === undefined) return { kind: "unsupported", updateId };
  if (!isRecord(raw)) return { kind: "invalid", errors: ["message inválida"] };

  const errors: string[] = [];
  const chat = raw.chat;
  if (!isInt(raw.message_id)) errors.push("message.message_id inválido");
  if (!isInt(raw.date)) errors.push("message.date inválido");
  if (!isRecord(chat) || !isInt(chat.id)) errors.push("message.chat.id inválido");
  if (raw.text !== undefined && typeof raw.text !== "string") errors.push("message.text inválido");
  if (errors.length > 0 || !isRecord(chat)) return { kind: "invalid", errors };

  const message: TelegramMessage = {
    message_id: raw.message_id as number,
    date: raw.date as number,
    chat: { id: chat.id as number },
  };
  if (typeof raw.text === "string") message.text = raw.text;
  return { kind: "message", updateId, message };
}

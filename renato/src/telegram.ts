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
  /** Legenda de uma foto ou arquivo. */
  caption?: string;
  /** Tamanhos de uma foto enviada como foto (o Telegram comprime). */
  photo?: { file_id: string; file_size?: number; width?: number; height?: number }[];
  /** Arquivo enviado como arquivo (sem compressão). */
  document?: { file_id: string; mime_type?: string; file_name?: string; file_size?: number };
  /** Mensagem à qual esta responde (só o texto interessa: o link da nota que o Renato enviou). */
  reply_to_message?: { text?: string };
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
  if (typeof raw.caption === "string") message.caption = raw.caption;
  if (Array.isArray(raw.photo)) {
    const sizes = raw.photo.filter((p): p is Record<string, unknown> => isRecord(p) && typeof p.file_id === "string");
    if (sizes.length > 0) {
      message.photo = sizes.map((p) => ({
        file_id: p.file_id as string,
        ...(isInt(p.file_size) && { file_size: p.file_size }),
        ...(isInt(p.width) && { width: p.width }),
        ...(isInt(p.height) && { height: p.height }),
      }));
    }
  }
  if (isRecord(raw.document) && typeof raw.document.file_id === "string") {
    const d = raw.document;
    message.document = {
      file_id: d.file_id as string,
      ...(typeof d.mime_type === "string" && { mime_type: d.mime_type }),
      ...(typeof d.file_name === "string" && { file_name: d.file_name }),
      ...(isInt(d.file_size) && { file_size: d.file_size }),
    };
  }
  if (isRecord(raw.reply_to_message) && typeof raw.reply_to_message.text === "string") {
    message.reply_to_message = { text: raw.reply_to_message.text };
  }
  return { kind: "message", updateId, message };
}

/** O arquivo de imagem de uma mensagem: a maior foto, ou um documento com mime de imagem. Null se não há imagem. */
export function pickImage(message: TelegramMessage): { fileId: string; fileSize?: number } | null {
  if (message.photo && message.photo.length > 0) {
    const best = [...message.photo].sort((a, b) => (b.file_size ?? (b.width ?? 0) * (b.height ?? 0)) - (a.file_size ?? (a.width ?? 0) * (a.height ?? 0)))[0]!;
    return { fileId: best.file_id, ...(best.file_size !== undefined && { fileSize: best.file_size }) };
  }
  if (message.document && message.document.mime_type?.startsWith("image/")) {
    return { fileId: message.document.file_id, ...(message.document.file_size !== undefined && { fileSize: message.document.file_size }) };
  }
  return null;
}

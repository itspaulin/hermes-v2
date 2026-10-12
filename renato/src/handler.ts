import { type Clock } from "./clock.js";
import { captureNote } from "./note.js";
import { parseTelegramUpdate } from "./telegram.js";
import { type Note } from "./types.js";

/** Comando entregue ao domínio. O Renato não sabe quem o consome (Vault, fila, etc.). */
export interface CaptureNoteCommand {
  type: "capture_note";
  note: Note;
}

export interface TelegramHandlerDeps {
  clock: Clock;
  /** Recebe o comando de captura. Pode lançar/rejeitar; o handler converte em 500. */
  capture(command: CaptureNoteCommand): void | Promise<void>;
}

export type IgnoreReason = "unsupported_update" | "no_text";

export type HandlerBody =
  | { status: "accepted"; noteId: string }
  | { status: "ignored"; reason: IgnoreReason }
  | { status: "invalid"; errors: string[] }
  | { status: "error"; reason: "capture_failed" };

export interface HttpResponse {
  statusCode: 200 | 400 | 500;
  body: HandlerBody;
}

/**
 * Handler HTTP puro: recebe o payload já parseado e devolve uma resposta
 * previsível. Não responde ao Telegram e nunca lança.
 * - 200 accepted/ignored: o Telegram não deve reenviar;
 * - 400 invalid: payload malformado;
 * - 500 error: falha de dependência; o Telegram pode reenviar o update.
 */
export function createTelegramHandler(deps: TelegramHandlerDeps) {
  return async function handle(payload: unknown): Promise<HttpResponse> {
    const parsed = parseTelegramUpdate(payload);
    if (parsed.kind === "invalid") {
      return { statusCode: 400, body: { status: "invalid", errors: parsed.errors } };
    }
    if (parsed.kind === "unsupported") {
      return { statusCode: 200, body: { status: "ignored", reason: "unsupported_update" } };
    }

    const { message } = parsed;
    if (message.text === undefined || message.text.trim() === "") {
      return { statusCode: 200, body: { status: "ignored", reason: "no_text" } };
    }

    try {
      // Id determinístico: reentregas do mesmo update geram a mesma nota.
      const note = captureNote(
        {
          id: `telegram-${message.chat.id}-${message.message_id}`,
          content: message.text,
          source: { kind: "telegram", messageId: String(message.message_id) },
        },
        deps.clock,
      );
      await deps.capture({ type: "capture_note", note });
      return { statusCode: 200, body: { status: "accepted", noteId: note.id } };
    } catch {
      return { statusCode: 500, body: { status: "error", reason: "capture_failed" } };
    }
  };
}

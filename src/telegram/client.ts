/** Cliente do Telegram isolado: o resto do código só conhece esta interface. */
export interface InlineButton {
  text: string;
  /** Até 64 bytes (limite do Telegram). */
  data: string;
}
/** Linhas de botões. */
export type InlineKeyboard = InlineButton[][];

export interface TelegramClient {
  sendMessage(chatId: number, text: string, keyboard?: InlineKeyboard): Promise<void>;
  /** Fecha o "carregando" do botão; `text` aparece como aviso rápido. */
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
  /** Troca o texto de uma mensagem do bot. Sem teclado: os botões somem. */
  editMessageText(chatId: number, messageId: number, text: string): Promise<void>;
}

export class TelegramApiError extends Error {
  constructor(
    message: string,
    /** Status HTTP da API; undefined = falha de rede. */
    readonly status?: number,
  ) {
    super(message);
    this.name = "TelegramApiError";
  }

  /** Vale reenviar o update? Falhas transitórias sim; erros 4xx (exceto 429) não. */
  get retryable(): boolean {
    return this.status === undefined || this.status === 429 || this.status >= 500;
  }
}

export function createTelegramClient(
  botToken: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 10_000,
): TelegramClient {
  async function call(method: string, body: Record<string, unknown>): Promise<void> {
    let res: Response;
    try {
      res = await fetchImpl(`https://api.telegram.org/bot${botToken}/${method}`, {
        method: "POST",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      // Mensagem sem detalhes do erro original: a URL contém o token.
      throw new TelegramApiError("Falha de rede ou timeout ao chamar a API do Telegram");
    }
    if (!res.ok) {
      throw new TelegramApiError(`Telegram ${method} falhou: HTTP ${res.status}`, res.status);
    }
  }

  return {
    sendMessage: (chatId, text, keyboard) =>
      call("sendMessage", {
        chat_id: chatId,
        text,
        ...(keyboard && {
          reply_markup: { inline_keyboard: keyboard.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) },
        }),
      }),
    answerCallbackQuery: (callbackQueryId, text) =>
      call("answerCallbackQuery", { callback_query_id: callbackQueryId, ...(text !== undefined && { text }) }),
    editMessageText: (chatId, messageId, text) =>
      call("editMessageText", { chat_id: chatId, message_id: messageId, text }),
  };
}

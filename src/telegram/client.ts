/** Cliente do Telegram isolado: o resto do código só conhece esta interface. */
export interface TelegramClient {
  sendMessage(chatId: number, text: string): Promise<void>;
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
): TelegramClient {
  return {
    async sendMessage(chatId, text) {
      let res: Response;
      try {
        res = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text }),
        });
      } catch {
        // Mensagem sem detalhes do erro original: a URL contém o token.
        throw new TelegramApiError("Falha de rede ao chamar a API do Telegram");
      }
      if (!res.ok) {
        throw new TelegramApiError(`Telegram sendMessage falhou: HTTP ${res.status}`, res.status);
      }
    },
  };
}

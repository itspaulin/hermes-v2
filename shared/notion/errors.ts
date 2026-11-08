/** Erros tipados do Notion. Só NotionUnavailable deve virar 500 no webhook (o Telegram reenvia). */

/** Falha transitória (5xx, rate limit esgotado, rede, timeout). Seguro reenviar: criar é idempotente. */
export class NotionUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotionUnavailable";
  }
}

/**
 * Resposta NÃO transitória da API do Notion (token inválido, banco não compartilhado com a integração,
 * propriedade ausente ou com tipo errado). Reenviar não adianta. A mensagem nunca traz o token.
 */
export class NotionApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(`Notion API ${status} ${code}: ${message}`);
    this.name = "NotionApiError";
  }
}

/** Subconjunto mínimo do Update do Telegram usado pelo Hermes. */
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramMessage {
  message_id: number;
  chat: { id: number; type: string };
  /** Instante do EVENTO (epoch seconds). Define a data das tarefas; nunca o relógio da Lambda. */
  date?: number;
  text?: string;
}

export interface TelegramConfig {
  botToken: string;
  webhookSecret: string;
  allowedChatIds: readonly number[];
}

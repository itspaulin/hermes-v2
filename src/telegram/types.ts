/** Subconjunto mínimo do Update do Telegram usado pelo Hermes. */
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

/** Toque num botão do inline keyboard. `message` é a mensagem do bot que tem o botão. */
export interface TelegramCallbackQuery {
  id: string;
  from: { id: number };
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: { id: number; is_bot?: boolean };
  /** Instante do EVENTO (epoch seconds). Define a data das tarefas; nunca o relógio da Lambda. */
  date?: number;
  text?: string;
  /** A mensagem à qual esta responde (o "reply" do Telegram). */
  reply_to_message?: TelegramMessage;
}

export interface TelegramConfig {
  botToken: string;
  webhookSecret: string;
  allowedChatIds: readonly number[];
}

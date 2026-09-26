import { secondsSince, type Clock } from "../time/index.js";
import {
  bindTag,
  closedQuestionText,
  decodeChoice,
  EXPIRED_QUESTION,
  INVALID_OPTION,
  parseQuestion,
  parseTextChoice,
  QUESTION_TTL_SECONDS,
  UNAVAILABLE_META,
  type ParsedQuestion,
} from "./meta-question.js";
import type { Reply } from "./reply.js";
import { confirmChoice, type FlowDeps } from "./task-flow.js";
import type { TelegramCallbackQuery, TelegramMessage } from "./types.js";

export interface AnswerDeps extends FlowDeps {
  clock: Clock;
}

/** A pergunta em `message`, se for uma mensagem DO BOT no formato certo (a mensagem de um usuário nunca vale). */
function questionOf(message: TelegramMessage | undefined): ParsedQuestion | null {
  if (!message || message.from?.is_bot !== true || typeof message.text !== "string") return null;
  return parseQuestion(message.text);
}

const isExpired = (clock: Clock, message: TelegramMessage): boolean => {
  if (message.date === undefined || message.date <= 0) return true; // sem data confiável: não aceita
  return secondsSince(clock, message.date) > QUESTION_TTL_SECONDS;
};

/**
 * Resposta por TEXTO ("1", "não", "nenhuma") a uma pergunta de meta, dada como reply do Telegram.
 * Null se `replyTo` não é uma pergunta do Hermes: aí a mensagem é tratada como qualquer outra.
 */
export async function answerByText(text: string, replyTo: TelegramMessage, deps: AnswerDeps): Promise<Reply | null> {
  const q = questionOf(replyTo);
  if (!q) return null;
  const messageId = replyTo.message_id;
  const close = (note: string) => ({ messageId, text: closedQuestionText(q.task, note) });

  if (isExpired(deps.clock, replyTo)) return { text: EXPIRED_QUESTION, closes: close("Pergunta expirada.") };

  const n = parseTextChoice(text, q.options.length);
  if (n === null) return { text: INVALID_OPTION };

  const result = await confirmChoice(q, n, replyTo.date!, deps);
  switch (result.kind) {
    case "invalid":
      return { text: result.text };
    case "created":
      return { text: result.text, closes: close("Pergunta respondida.") };
    case "unavailable":
      return { ...result.retry, closes: close("Pergunta substituída por uma lista atualizada.") };
  }
}

/** O que fazer no Telegram depois de um toque num botão. */
export interface CallbackOutcome {
  /** Aviso rápido sobre o botão (answerCallbackQuery). */
  toast?: string;
  /** Reescreve a pergunta (os botões somem). */
  closes?: { messageId: number; text: string };
  /** Mensagem nova (ex.: a lista atualizada de metas). */
  send?: Reply;
}

/**
 * Toque num botão. Valida: mensagem é do bot e é uma pergunta bem formada; o botão pertence à
 * tarefa DESSA mensagem (tag); a pergunta não expirou; a opção existe; e, no Vault, a meta
 * ainda existe e está ativa. O chat é validado pelo webhook (allowlist).
 */
export async function answerByCallback(cq: TelegramCallbackQuery, deps: AnswerDeps): Promise<CallbackOutcome> {
  const message = cq.message;
  const choice = decodeChoice(cq.data);
  const q = questionOf(message);
  if (!message || !choice || !q || choice.tag !== bindTag(q.task.id)) return { toast: "Botão inválido." };

  const messageId = message.message_id;
  const close = (note: string) => ({ messageId, text: closedQuestionText(q.task, note) });

  if (isExpired(deps.clock, message)) return { toast: EXPIRED_QUESTION, closes: close("Pergunta expirada.") };

  const result = await confirmChoice(q, choice.n, message.date!, deps);
  switch (result.kind) {
    case "invalid":
      return { toast: INVALID_OPTION };
    case "created":
      return { toast: result.text.split("\n")[0]!, closes: { messageId, text: result.text } };
    case "unavailable":
      return { toast: UNAVAILABLE_META, closes: close("Pergunta substituída por uma lista atualizada."), send: result.retry };
  }
}

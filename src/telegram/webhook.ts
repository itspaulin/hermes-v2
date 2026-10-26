import { timingSafeEqual } from "node:crypto";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import type { Clock } from "../time/index.js";
import { TelegramApiError, type TelegramClient } from "./client.js";
import { AnswerValidationError } from "../domain/answer.js";
import { CheckinNotFound, type CheckinRepository } from "../domain/checkin-repository.js";
import { ReviewNotFound, type ReviewRepository } from "../domain/review-repository.js";
import { MetaNotFound, MetaValidationError, type MetaRepository } from "../domain/meta-repository.js";
import { TaskNotFound, TaskValidationError, type TaskRepository } from "../domain/task-repository.js";
import { VaultApiError, VaultConflict, VaultInvalidNote, VaultUnavailable } from "../vault/errors.js";
import { answerByCallback, type CallbackOutcome } from "./meta-answer.js";
import { asReply, type Reply } from "./reply.js";
import type { HermesConversation } from "../ai/hermes.js";
import { routeMessage } from "./router.js";
import type { TelegramCallbackQuery, TelegramConfig, TelegramUpdate } from "./types.js";

export interface WebhookDeps {
  config: TelegramConfig;
  client: TelegramClient;
  clock: Clock;
  tasks: TaskRepository;
  metas: MetaRepository;
  checkins: CheckinRepository;
  reviews: ReviewRepository;
  converse?: HermesConversation;
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
 * - 200 ignorado (chat não autorizado, update sem texto) ou respondido, inclusive erros
 *   causados pelo pedido do usuário (comando inválido, tarefa inexistente, nota inválida...)
 * - 500 falha operacional transitória (Vault/GitHub indisponível, timeout, rate limit, Telegram
 *   fora do ar) ou erro inesperado: queremos o reenvio (tudo é idempotente)
 */
export async function handleWebhook(
  event: APIGatewayProxyEventV2,
  { config, client, clock, tasks, metas, checkins, reviews, converse }: WebhookDeps,
): Promise<APIGatewayProxyResultV2> {
  if (!secretMatches(event.headers?.[SECRET_HEADER], config.webhookSecret)) {
    return reply(401);
  }

  const update = parseUpdate(event);
  if (!update) return reply(400);

  const deps = { clock, tasks, metas, checkins, reviews };
  const routeDeps = converse ? { ...deps, converse } : deps;
  if (update.callback_query) return handleCallback(update.callback_query, config, client, deps);

  const message = update.message;
  if (!message || typeof message.text !== "string") return reply(200);

  // Chat não autorizado: ignora em silêncio, sem revelar que o bot existe.
  if (!config.allowedChatIds.includes(message.chat.id)) return reply(200);

  let result: Reply;
  try {
    result = asReply(await routeMessage(message.text, message.date, routeDeps, message.reply_to_message));
  } catch (err) {
    const outcome = describeError(err);
    if (outcome.kind === "retry") return reply(500);
    result = { text: outcome.text };
  }

  try {
    await send(client, message.chat.id, result);
  } catch (err) {
    if (err instanceof TelegramApiError) {
      console.error(`[telegram] ${err.message}`);
      return err.retryable ? reply(500) : reply(200);
    }
    console.error("[hermes] erro inesperado ao responder", err);
    return reply(500);
  }
  // Já respondeu: reescrever a pergunta antiga é só arrumação (some com os botões). Nunca pede reenvio.
  if (result.closes) await bestEffort(() => client.editMessageText(message.chat.id, result.closes!.messageId, result.closes!.text));
  return reply(200);
}

const send = (client: TelegramClient, chatId: number, r: Reply): Promise<void> =>
  r.keyboard ? client.sendMessage(chatId, r.text, r.keyboard) : client.sendMessage(chatId, r.text);

/** Erro do Telegram em arrumação (botão velho, mensagem sem mudança...): só registra. */
async function bestEffort(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(`[telegram] ${err instanceof Error ? err.message : "erro ao arrumar mensagem"}`);
  }
}

/**
 * Toque num botão (callback_query). Mesmas regras de código de retorno da mensagem: pedido inválido
 * responde 200 com aviso; falha transitória responde 500 (o toque é reenviado e criar é idempotente).
 */
async function handleCallback(
  cq: TelegramCallbackQuery,
  config: TelegramConfig,
  client: TelegramClient,
  deps: Omit<WebhookDeps, "config" | "client">,
): Promise<APIGatewayProxyResultV2> {
  const message = cq.message;
  // Sem mensagem, ou de chat não autorizado: ignora em silêncio.
  if (!message || !config.allowedChatIds.includes(message.chat.id)) return reply(200);

  let outcome: CallbackOutcome;
  try {
    outcome = await answerByCallback(cq, deps);
  } catch (err) {
    const described = describeError(err);
    if (described.kind === "retry") return reply(500);
    outcome = { toast: described.text };
  }

  try {
    await client.answerCallbackQuery(cq.id, outcome.toast);
    if (outcome.send) await send(client, message.chat.id, outcome.send);
  } catch (err) {
    if (err instanceof TelegramApiError) {
      console.error(`[telegram] ${err.message}`);
      // 4xx (ex.: "query is too old"): reenviar não adianta.
      if (err.retryable) return reply(500);
    } else {
      console.error("[hermes] erro inesperado ao responder o botão", err);
      return reply(500);
    }
  }
  if (outcome.closes) await bestEffort(() => client.editMessageText(message.chat.id, outcome.closes!.messageId, outcome.closes!.text));
  return reply(200);
}

/**
 * Classifica um erro do processamento do comando: responder ao usuário (200) ou pedir
 * reenvio ao Telegram (500). Mensagens nunca incluem token nem detalhes internos da API.
 */
function describeError(err: unknown): { kind: "reply"; text: string } | { kind: "retry" } {
  if (err instanceof TaskValidationError) return { kind: "reply", text: err.message };
  if (err instanceof AnswerValidationError) return { kind: "reply", text: err.message };
  if (err instanceof CheckinNotFound) return { kind: "reply", text: "Check-in não encontrado." };
  if (err instanceof ReviewNotFound) return { kind: "reply", text: "Revisão não encontrada." };
  if (err instanceof MetaValidationError) return { kind: "reply", text: err.message };
  if (err instanceof MetaNotFound) return { kind: "reply", text: "Meta não encontrada." };
  if (err instanceof TaskNotFound) return { kind: "reply", text: "Tarefa não encontrada." };
  if (err instanceof VaultInvalidNote) return { kind: "reply", text: `Não consegui ler uma nota: ${err.message}` };
  if (err instanceof VaultConflict) {
    return { kind: "reply", text: "A nota foi alterada por outra edição ao mesmo tempo. Tente de novo em instantes." };
  }
  if (err instanceof VaultApiError) {
    // Token/permissão/repo/branch: reenviar não adianta e prenderia a fila do Telegram.
    console.error(`[vault] ${err.message}`);
    return { kind: "reply", text: "Não consegui acessar o Vault (erro de configuração ou permissão). Veja os logs." };
  }
  if (err instanceof VaultUnavailable) {
    console.error(`[vault] ${err.message}`);
    return { kind: "retry" };
  }
  console.error("[hermes] erro inesperado", err);
  return { kind: "retry" };
}

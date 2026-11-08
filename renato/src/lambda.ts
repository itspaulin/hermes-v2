import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { timingSafeEqual } from "node:crypto";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { loadConverse } from "../../shared/ai/bedrock.js";
import { loadAiConfig } from "../../shared/ai/config.js";
import { createTelegramHandler, type HttpResponse } from "./handler.js";
import { createRenatoAi, createRenatoConversation, explicitCapture, HELP_TEXT, CAPTURE_COMMAND, type RenatoConversation } from "./conversation.js";
import { parseTelegramUpdate } from "./telegram.js";
import { NotionApiError, NotionUnavailable } from "../../shared/notion/errors.js";
import { createNotionAi, createNotionAssistant, type NotionAssistant, type TurnInput } from "./notion/assistant.js";
import { createVerbatimCapture } from "./notion/capture.js";
import { loadRenatoNotion } from "./notion/config.js";
import { systemClock } from "./clock.js";
import { GitHubNoteRepository, type HttpClient } from "./github-repository.js";
import type { NoteRepository } from "./repository.js";

const SECRET_HEADER = "x-telegram-bot-api-secret-token";

export interface RenatoWebhookDeps {
  webhookSecret: string;
  allowedChatIds: ReadonlySet<number>;
  handleUpdate(payload: unknown): Promise<HttpResponse>;
  sendMessage(chatId: number, text: string): Promise<void>;
  /**
   * Conversa natural. Ausente = IA desligada: todo texto é capturado como nota (comportamento original).
   * Presente: só captura pedido explícito (`/anotar`, marcador de categoria ou pedido reconhecido pelo modelo).
   */
  conversation?: RenatoConversation;
  /**
   * Modo Notion (notas organizadas em temas). Presente: todo texto vai ao `assistant` (ou, sem IA, à captura
   * literal); `/anotar <texto>` é sempre captura literal. Ausente: comportamento do Vault acima.
   */
  notion?: { assistant?: NotionAssistant; capture: (turn: TurnInput) => Promise<string> };
}

export const NOTION_HELP_TEXT = `Converse comigo normalmente: mande o que estudou e eu organizo no Notion, ou pergunte o que você já tem. Para guardar um texto exato, envie ${CAPTURE_COMMAND} <texto>.`;
export const NOTION_FAILURE_TEXT = "Não consegui acessar o Notion (erro de configuração ou permissão). Veja os logs.";
const ANOTAR_RE = /^\/anotar(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/i;

const response = (statusCode: number, body = ""): APIGatewayProxyStructuredResultV2 => ({
  statusCode,
  headers: { "content-type": "text/plain; charset=utf-8" },
  body,
});

function secretMatches(received: string | undefined, expected: string): boolean {
  if (received === undefined) return false;
  const actual = Buffer.from(received);
  const target = Buffer.from(expected);
  return actual.length === target.length && timingSafeEqual(actual, target);
}

function parseBody(event: APIGatewayProxyEventV2): unknown | null {
  if (!event.body) return null;
  const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function chatIdFrom(payload: unknown): number | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const message = (payload as { message?: unknown }).message;
  if (typeof message !== "object" || message === null || Array.isArray(message)) return undefined;
  const chat = (message as { chat?: unknown }).chat;
  if (typeof chat !== "object" || chat === null || Array.isArray(chat)) return undefined;
  const id = (chat as { id?: unknown }).id;
  return typeof id === "number" && Number.isSafeInteger(id) ? id : undefined;
}

/** Cópia do update com outro texto na mensagem (ex.: sem o prefixo "/anotar"). */
function withText(payload: unknown, text: string): unknown {
  const update = payload as { message: Record<string, unknown> };
  return { ...update, message: { ...update.message, text } };
}

async function replyOnly(deps: RenatoWebhookDeps, chatId: number, text: string): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    await deps.sendMessage(chatId, text);
  } catch {
    return response(500);
  }
  return response(200, "ok");
}

/** HTTP boundary, independently testable without AWS, Telegram or GitHub credentials. */
export function createRenatoWebhookHandler(deps: RenatoWebhookDeps) {
  return async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
    const method = event.requestContext.http.method;
    const path = event.rawPath;
    if (method !== "POST" || path !== "/renato/webhook") return response(404);

    const headers = event.headers ?? {};
    const secret = headers[SECRET_HEADER] ?? headers[SECRET_HEADER.toUpperCase()];
    if (!secretMatches(secret, deps.webhookSecret)) return response(401);

    const payload = parseBody(event);
    if (payload === null) return response(400);

    const chatId = chatIdFrom(payload);
    if (chatId !== undefined && !deps.allowedChatIds.has(chatId)) return response(200);

    if (deps.notion) {
      const parsed = parseTelegramUpdate(payload);
      if (parsed.kind === "invalid") return response(400);
      const { message } = parsed.kind === "message" ? parsed : { message: undefined };
      const raw = message?.text?.trim() ?? "";
      if (message === undefined || raw === "") return response(200, "ignored");
      const turn: TurnInput = { text: message.text!, chatId: message.chat.id, messageId: message.message_id, epochSeconds: message.date };
      try {
        const anotar = ANOTAR_RE.exec(raw);
        let reply: string;
        if (anotar) {
          const body = anotar[1]?.trim() ?? "";
          reply = body === "" ? `Uso: ${CAPTURE_COMMAND} <texto>` : await deps.notion.capture({ ...turn, text: body });
        } else if (raw.startsWith("/")) {
          reply = NOTION_HELP_TEXT;
        } else {
          reply = await (deps.notion.assistant ?? deps.notion.capture)(turn);
        }
        return await replyOnly(deps, message.chat.id, reply);
      } catch (error) {
        if (error instanceof NotionApiError) {
          console.error(`[notion] ${error.message}`);
          return replyOnly(deps, message.chat.id, NOTION_FAILURE_TEXT);
        }
        // Falha transitória ou inesperada: o Telegram reenvia; criar é idempotente pelo ID da mensagem.
        console.error(`[renato] erro ao processar (${error instanceof NotionUnavailable ? "notion indisponível" : error instanceof Error ? error.name : "erro"})`);
        return response(500);
      }
    }

    let capturePayload: unknown = payload;
    if (deps.conversation) {
      const parsed = parseTelegramUpdate(payload);
      const text = parsed.kind === "message" ? parsed.message.text : undefined;
      if (parsed.kind === "message" && text !== undefined && text.trim() !== "") {
        const explicit = explicitCapture(text);
        if (explicit !== null) {
          capturePayload = withText(payload, explicit);
        } else {
          const say = (reply: string) => replyOnly(deps, parsed.message.chat.id, reply);
          if (text.trim().toLowerCase().split(/[\s@]/)[0] === CAPTURE_COMMAND) return say(`Uso: ${CAPTURE_COMMAND} <texto>`);
          if (text.trim().startsWith("/")) return say(HELP_TEXT);
          const turn = await deps.conversation(text);
          if (turn.kind === "say") return say(turn.text);
          // Pedido de captura reconhecido pelo modelo: grava a mensagem original, sem reescrita.
        }
      }
    }

    const result = await deps.handleUpdate(capturePayload);
    if (result.statusCode !== 200 || result.body.status !== "accepted") {
      return response(result.statusCode);
    }

    if (chatId === undefined) return response(500);
    try {
      await deps.sendMessage(chatId, `Anotado no Renato. ID: ${result.body.noteId}`);
    } catch {
      // Telegram pode reenviar. O callback de captura é idempotente por update/message id.
      return response(500);
    }
    return response(200, "ok");
  };
}

interface RuntimeConfig {
  botToken: string;
  webhookSecret: string;
  allowedChatIds: ReadonlySet<number>;
  vaultOwner: string;
  vaultRepo: string;
  vaultBranch: string;
  vaultDirectory: string;
  vaultToken: string;
}

function requiredEnv(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Variável ausente: ${name}`);
  return value;
}

function parseAllowedChatIds(raw: string): ReadonlySet<number> {
  const values = raw.split(",").map((part) => part.trim()).filter(Boolean);
  const ids = values.map(Number);
  if (ids.length === 0 || ids.some((id) => !Number.isSafeInteger(id))) {
    throw new Error("RENATO_ALLOWED_CHAT_IDS inválido; informe IDs numéricos separados por vírgula");
  }
  return new Set(ids);
}

async function readParameter(client: SSMClient, name: string): Promise<string> {
  try {
    const result = await client.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    const value = result.Parameter?.Value;
    if (!value) throw new Error("valor ausente");
    return value;
  } catch (error) {
    const nameOfError = typeof error === "object" && error !== null && "name" in error
      ? String((error as { name: unknown }).name)
      : "erro desconhecido";
    throw new Error(`Falha ao ler parâmetro SSM ${name}: ${nameOfError}`);
  }
}

async function loadConfig(env: Record<string, string | undefined>, ssm: SSMClient): Promise<RuntimeConfig> {
  const botTokenParam = requiredEnv(env, "RENATO_TELEGRAM_BOT_TOKEN_PARAM");
  const secretParam = requiredEnv(env, "RENATO_TELEGRAM_WEBHOOK_SECRET_PARAM");
  const allowedChatIdsParam = requiredEnv(env, "RENATO_TELEGRAM_ALLOWED_CHAT_IDS_PARAM");
  const vaultTokenParam = requiredEnv(env, "RENATO_VAULT_GITHUB_TOKEN_PARAM");
  const repoParts = requiredEnv(env, "RENATO_VAULT_REPO").split("/");
  if (repoParts.length !== 2 || repoParts.some((part) => !part)) {
    throw new Error("RENATO_VAULT_REPO deve estar no formato owner/repo");
  }

  const [botToken, webhookSecret, allowedRaw, vaultToken] = await Promise.all([
    readParameter(ssm, botTokenParam),
    readParameter(ssm, secretParam),
    readParameter(ssm, allowedChatIdsParam),
    readParameter(ssm, vaultTokenParam),
  ]);
  return {
    botToken,
    webhookSecret,
    allowedChatIds: parseAllowedChatIds(allowedRaw),
    vaultOwner: repoParts[0]!,
    vaultRepo: repoParts[1]!,
    vaultBranch: requiredEnv(env, "RENATO_VAULT_BRANCH"),
    vaultDirectory: env.RENATO_VAULT_DIRECTORY?.trim() || "Renato/Notas",
    vaultToken,
  };
}

async function sendTelegramMessage(botToken: string, chatId: number, text: string): Promise<void> {
  let result: Response;
  try {
    result = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // A URL contém o token; nunca propague/logue o erro original do fetch.
    throw new Error("Falha de rede ao responder pelo Telegram");
  }
  if (!result.ok) throw new Error(`Telegram sendMessage respondeu HTTP ${result.status}`);
  const body = await result.json() as { ok?: unknown };
  if (body.ok !== true) throw new Error("Telegram recusou sendMessage");
}

function createRepository(config: RuntimeConfig): NoteRepository {
  const http = fetch as unknown as HttpClient;
  return new GitHubNoteRepository({
    owner: config.vaultOwner,
    repo: config.vaultRepo,
    branch: config.vaultBranch,
    directory: config.vaultDirectory,
    token: config.vaultToken,
  }, http);
}

async function buildProductionHandler() {
  const ssm = new SSMClient({});
  const config = await loadConfig(process.env, ssm);
  const notionRepos = await loadRenatoNotion(process.env, (name) => readParameter(ssm, name));
  const repository = createRepository(config);
  const telegramHandler = createTelegramHandler({
    clock: systemClock,
    capture: async ({ note }) => {
      const existing = await repository.get(note.id);
      if (existing) {
        if (existing.originalContent !== note.originalContent) {
          throw new Error("O mesmo ID de mensagem já existe com conteúdo diferente");
        }
        return;
      }
      await repository.create(note);
    },
  });
  // IA opcional: desligada (padrão) ou mal configurada, o Renato mantém a captura original.
  const aiConfig = loadAiConfig(process.env);
  const bedrock = aiConfig ? await loadConverse(aiConfig, (name) => readParameter(ssm, name)) : undefined;
  const conversation = aiConfig && bedrock ? createRenatoConversation(createRenatoAi(aiConfig, bedrock)) : undefined;
  const notion = notionRepos && {
    capture: createVerbatimCapture(notionRepos),
    ...(aiConfig && bedrock && { assistant: createNotionAssistant({ ai: createNotionAi(aiConfig, bedrock), ...notionRepos }) }),
  };
  return createRenatoWebhookHandler({
    ...(conversation && { conversation }),
    ...(notion && { notion }),
    webhookSecret: config.webhookSecret,
    allowedChatIds: config.allowedChatIds,
    handleUpdate: telegramHandler,
    sendMessage: (chatId, text) => sendTelegramMessage(config.botToken, chatId, text),
  });
}

let cachedHandler: ReturnType<typeof createRenatoWebhookHandler> | undefined;

/** SAM/Lambda entrypoint. Secrets/config are read only at invocation time, never at module import. */
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  cachedHandler ??= await buildProductionHandler();
  return cachedHandler(event);
}

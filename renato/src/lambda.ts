import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { timingSafeEqual } from "node:crypto";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { createTelegramHandler, type HttpResponse } from "./handler.js";
import { systemClock } from "./clock.js";
import { GitHubNoteRepository, type HttpClient } from "./github-repository.js";
import type { NoteRepository } from "./repository.js";

const SECRET_HEADER = "x-telegram-bot-api-secret-token";

export interface RenatoWebhookDeps {
  webhookSecret: string;
  allowedChatIds: ReadonlySet<number>;
  handleUpdate(payload: unknown): Promise<HttpResponse>;
  sendMessage(chatId: number, text: string): Promise<void>;
}

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

    const result = await deps.handleUpdate(payload);
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
  return createRenatoWebhookHandler({
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

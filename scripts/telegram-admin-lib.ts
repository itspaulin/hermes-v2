/**
 * Operações administrativas do bot no Telegram (setWebhook, getWebhookInfo, deleteWebhook,
 * descoberta de chat_id). Toda chamada recebe o token por parâmetro e NUNCA o imprime:
 * mensagens de erro são montadas sem a URL da requisição (que contém o token) e ainda
 * passam por uma máscara.
 */
export interface WebhookInfo {
  url: string;
  pendingUpdateCount: number;
  lastErrorDate?: number;
  lastErrorMessage?: string;
  allowedUpdates?: string[];
}

export interface ChatSeen {
  id: number;
  type: string;
  name: string;
}

export const WEBHOOK_PATH = "/telegram/webhook";
const SECRET_RE = /^[A-Za-z0-9_-]{1,256}$/;

function mask(text: string, token: string): string {
  return token === "" ? text : text.split(token).join("***");
}

async function call(
  token: string,
  method: string,
  fetchImpl: typeof fetch,
  body?: Record<string, unknown>,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
  } catch {
    throw new Error(`Telegram ${method}: falha de rede ou timeout`);
  }
  let json: { ok?: boolean; result?: unknown; description?: string } = {};
  try {
    json = (await res.json()) as typeof json;
  } catch {
    /* corpo não é JSON */
  }
  if (!res.ok || json.ok !== true) {
    const why = mask(String(json.description ?? `HTTP ${res.status}`), token);
    throw new Error(`Telegram ${method} falhou: ${why}`);
  }
  return json.result;
}

/** A URL do webhook precisa ser HTTPS, sem credenciais, e apontar para /telegram/webhook. */
export function validateWebhookUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("URL inválida");
  }
  if (u.protocol !== "https:") throw new Error("A URL do webhook precisa ser https");
  if (u.username || u.password) throw new Error("A URL não pode conter credenciais");
  if (u.search || u.hash) throw new Error("A URL não deve ter query nem fragmento");
  if (u.pathname !== WEBHOOK_PATH) throw new Error(`O caminho da URL deve ser ${WEBHOOK_PATH}`);
  return u.toString();
}

/** secret_token do Telegram: 1 a 256 caracteres de A-Z a-z 0-9 _ -. */
export function validateSecret(secret: string): string {
  if (!SECRET_RE.test(secret)) {
    throw new Error("webhook-secret inválido: use 1-256 caracteres de A-Z a-z 0-9 _ - (ex.: openssl rand -hex 32)");
  }
  return secret;
}

function toInfo(r: unknown): WebhookInfo {
  const i = r as {
    url?: string;
    pending_update_count?: number;
    last_error_date?: number;
    last_error_message?: string;
    allowed_updates?: string[];
  };
  return {
    url: i.url ?? "",
    pendingUpdateCount: i.pending_update_count ?? 0,
    lastErrorDate: i.last_error_date,
    lastErrorMessage: i.last_error_message,
    allowedUpdates: i.allowed_updates,
  };
}

export async function getWebhookInfo(token: string, fetchImpl: typeof fetch = fetch): Promise<WebhookInfo> {
  return toInfo(await call(token, "getWebhookInfo", fetchImpl));
}

/**
 * Registra o webhook: mensagens e toques em botões (callback_query), com secret_token. NÃO usa drop_pending_updates:
 * atualizações pendentes durante a configuração não são descartadas em silêncio.
 */
export async function setWebhook(
  args: { token: string; secret: string; url: string },
  fetchImpl: typeof fetch = fetch,
): Promise<WebhookInfo> {
  const url = validateWebhookUrl(args.url);
  const secret = validateSecret(args.secret);
  await call(args.token, "setWebhook", fetchImpl, {
    url,
    secret_token: secret,
    allowed_updates: ["message", "callback_query"],
  });
  const info = await getWebhookInfo(args.token, fetchImpl);
  if (info.url !== url) throw new Error("O Telegram registrou uma URL diferente da pedida");
  return info;
}

/** Remove o webhook (rollback), sem descartar atualizações pendentes. */
export async function deleteWebhook(token: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  await call(token, "deleteWebhook", fetchImpl, { drop_pending_updates: false });
}

/**
 * Lê as atualizações pendentes (getUpdates, sem offset: não as consome) e devolve os chats
 * que escreveram para o bot. Só funciona ANTES de ativar o webhook.
 */
export async function findChatIds(token: string, fetchImpl: typeof fetch = fetch): Promise<ChatSeen[]> {
  let result: unknown;
  try {
    result = await call(token, "getUpdates", fetchImpl, { allowed_updates: ["message"], timeout: 0 });
  } catch (err) {
    if (/webhook is active|Conflict/i.test((err as Error).message)) {
      throw new Error(`${(err as Error).message}\nHá um webhook ativo. Rode "delete-webhook" antes, ou use o chat_id que você já tem.`);
    }
    throw err;
  }
  const seen = new Map<number, ChatSeen>();
  for (const u of result as { message?: { chat?: { id?: number; type?: string; first_name?: string; title?: string; username?: string } } }[]) {
    const c = u.message?.chat;
    if (typeof c?.id !== "number" || seen.has(c.id)) continue;
    seen.set(c.id, { id: c.id, type: c.type ?? "?", name: c.first_name ?? c.title ?? c.username ?? "" });
  }
  return [...seen.values()];
}

export function formatWebhookInfo(info: WebhookInfo, nowMs: number): string[] {
  const lines = [`URL: ${info.url || "(nenhum webhook)"}`, `Pending updates: ${info.pendingUpdateCount}`];
  if (info.lastErrorMessage) {
    const when = info.lastErrorDate ? new Date(info.lastErrorDate * 1000).toISOString() : "?";
    const agoMin = info.lastErrorDate ? Math.round((nowMs - info.lastErrorDate * 1000) / 60_000) : undefined;
    lines.push(`Last error: ${info.lastErrorMessage} (${when}${agoMin !== undefined ? `, há ${agoMin} min` : ""})`);
  } else {
    lines.push("Last error: nenhum");
  }
  if (info.allowedUpdates) lines.push(`Allowed updates: ${info.allowedUpdates.join(", ") || "(todos)"}`);
  return lines;
}

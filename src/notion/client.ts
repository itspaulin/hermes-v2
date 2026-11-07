import { NotionApiError, NotionUnavailable } from "./errors.js";

/** Cliente mínimo da API do Notion. Interface pequena para poder trocar por um falso nos testes. */
export interface NotionClient {
  request(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<any>;
}

export const NOTION_VERSION = "2022-06-28";
const BASE = "https://api.notion.com";
const TIMEOUT_MS = 8000;
const MAX_RETRIES = 2;
const MAX_WAIT_MS = 2000;

export interface NotionClientOptions {
  token: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Chamadas ao Notion por `fetch`. 429 (limite de ~3 req/s) espera `Retry-After` (no máximo 2 s) e
 * tenta de novo até 2 vezes. 5xx, timeout e rede viram NotionUnavailable; 4xx viram NotionApiError.
 * Mensagens de erro nunca incluem o token nem o corpo enviado.
 */
export function createNotionClient({ token, fetch: fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }: NotionClientOptions): NotionClient {
  return {
    async request(method, path, body) {
      for (let attempt = 0; ; attempt++) {
        let res: Response;
        try {
          res = await fetchImpl(`${BASE}${path}`, {
            method,
            headers: {
              Authorization: `Bearer ${token}`,
              "Notion-Version": NOTION_VERSION,
              ...(body !== undefined && { "Content-Type": "application/json" }),
            },
            ...(body !== undefined && { body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
        } catch (err) {
          const name = err instanceof Error ? err.name : "erro";
          throw new NotionUnavailable(`Falha de rede ao falar com o Notion (${name})`);
        }

        if (res.status === 429 && attempt < MAX_RETRIES) {
          const seconds = Number(res.headers.get("retry-after"));
          await sleep(Math.min(Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 500, MAX_WAIT_MS));
          continue;
        }
        if (res.status === 429 || res.status >= 500) throw new NotionUnavailable(`Notion indisponível (HTTP ${res.status})`);

        let json: any = null;
        try {
          json = await res.json();
        } catch {
          /* corpo vazio ou não JSON */
        }
        if (!res.ok) throw new NotionApiError(res.status, String(json?.code ?? "unknown"), String(json?.message ?? "erro").slice(0, 200));
        return json;
      }
    },
  };
}

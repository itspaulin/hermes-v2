import { NotionApiError, NotionUnavailable } from "./errors.js";

/** Cliente mínimo da API do Notion. Interface pequena para poder trocar por um falso nos testes. */
export interface NotionClient {
  request(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<any>;
  /** Sobe um arquivo para o Notion (criar o upload e enviar os bytes) e devolve o ID para usar em blocos de imagem. */
  upload(filename: string, contentType: string, bytes: Uint8Array): Promise<string>;
}

export const NOTION_VERSION = "2022-06-28";
const BASE = "https://api.notion.com";
const TIMEOUT_MS = 8000;
const UPLOAD_TIMEOUT_MS = 15000;
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
  const client: NotionClient = {
    async upload(filename, contentType, bytes) {
      const created = await client.request("POST", "/v1/file_uploads", { filename, content_type: contentType });
      const id = typeof created?.id === "string" ? created.id : "";
      if (id === "") throw new NotionApiError(502, "invalid_response", "upload sem ID");
      const form = new FormData();
      form.append("file", new Blob([bytes as Uint8Array<ArrayBuffer>], { type: contentType }), filename);
      let res: Response;
      try {
        res = await fetchImpl(`${BASE}/v1/file_uploads/${id}/send`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Notion-Version": NOTION_VERSION },
          body: form,
          signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
        });
      } catch (err) {
        throw new NotionUnavailable(`Falha de rede ao enviar arquivo ao Notion (${err instanceof Error ? err.name : "erro"})`);
      }
      if (res.status === 429 || res.status >= 500) throw new NotionUnavailable(`Notion indisponível (HTTP ${res.status})`);
      if (!res.ok) {
        const j: any = await res.json().catch(() => null);
        throw new NotionApiError(res.status, String(j?.code ?? "unknown"), String(j?.message ?? "erro").slice(0, 200));
      }
      return id;
    },
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
  return client;
}

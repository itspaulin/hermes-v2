import { describe, expect, it, vi } from "vitest";
import { createNotionClient, NOTION_VERSION } from "../src/notion/client.js";
import { NotionApiError, NotionUnavailable } from "../src/notion/errors.js";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("createNotionClient", () => {
  it("manda token, versão e corpo; devolve o JSON", async () => {
    const fetch = vi.fn(async () => json(200, { ok: 1 }));
    const client = createNotionClient({ token: "segredo", fetch: fetch as never });
    expect(await client.request("POST", "/v1/pages", { a: 1 })).toEqual({ ok: 1 });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.notion.com/v1/pages");
    expect(init.headers).toMatchObject({ Authorization: "Bearer segredo", "Notion-Version": NOTION_VERSION });
    expect(init.body).toBe('{"a":1}');
  });

  it("429 espera e tenta de novo; esgotadas as tentativas vira NotionUnavailable", async () => {
    const sleep = vi.fn(async () => {});
    const ok = vi.fn().mockResolvedValueOnce(json(429, {}, { "retry-after": "1" })).mockResolvedValueOnce(json(200, { ok: 1 }));
    expect(await createNotionClient({ token: "t", fetch: ok as never, sleep }).request("GET", "/x")).toEqual({ ok: 1 });
    expect(sleep).toHaveBeenCalledWith(1000);

    const always = vi.fn(async () => json(429, {}));
    await expect(createNotionClient({ token: "t", fetch: always as never, sleep }).request("GET", "/x")).rejects.toBeInstanceOf(NotionUnavailable);
    expect(always).toHaveBeenCalledTimes(3);
  });

  it("5xx e falha de rede viram NotionUnavailable (reenvio seguro)", async () => {
    await expect(createNotionClient({ token: "t", fetch: (async () => json(503, {})) as never }).request("GET", "/x")).rejects.toBeInstanceOf(NotionUnavailable);
    const net = vi.fn(async () => Promise.reject(Object.assign(new Error("token t na mensagem"), { name: "TypeError" })));
    const err = await createNotionClient({ token: "t", fetch: net as never }).request("GET", "/x").catch((e) => e);
    expect(err).toBeInstanceOf(NotionUnavailable);
    expect(err.message).not.toContain("token t");
  });

  it("4xx vira NotionApiError com o código do Notion, sem o token", async () => {
    const fetch = vi.fn(async () => json(404, { code: "object_not_found", message: "Could not find database" }));
    const err = await createNotionClient({ token: "segredo", fetch: fetch as never }).request("GET", "/x").catch((e) => e);
    expect(err).toBeInstanceOf(NotionApiError);
    expect(err).toMatchObject({ status: 404, code: "object_not_found" });
    expect(err.message).not.toContain("segredo");
  });
});

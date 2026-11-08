import { describe, expect, it, vi } from "vitest";
import { createNotionClient, NOTION_VERSION } from "../shared/notion/client.js";
import { NotionApiError, NotionUnavailable } from "../shared/notion/errors.js";

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

describe("upload de arquivo", () => {
  it("cria o upload, envia os bytes em multipart e devolve o ID", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return url.endsWith("/v1/file_uploads") ? json(200, { id: "up-1", status: "pending" }) : json(200, { id: "up-1", status: "uploaded" });
    });
    const id = await createNotionClient({ token: "segredo", fetch: fetch as never }).upload("a.png", "image/png", new Uint8Array([1, 2, 3]));
    expect(id).toBe("up-1");
    expect(calls[0]!.url).toBe("https://api.notion.com/v1/file_uploads");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ filename: "a.png", content_type: "image/png" });
    expect(calls[1]!.url).toBe("https://api.notion.com/v1/file_uploads/up-1/send");
    expect(calls[1]!.init.body).toBeInstanceOf(FormData);
    expect((calls[1]!.init.headers as Record<string, string>)["Content-Type"]).toBeUndefined(); // o fetch define o boundary
    expect(((calls[1]!.init.body as FormData).get("file") as File).size).toBe(3);
  });

  it("erro no envio: 4xx vira NotionApiError, 5xx/rede NotionUnavailable, sem o token", async () => {
    const make = (status: number) => createNotionClient({
      token: "segredo",
      fetch: (async (url: string) => (url.endsWith("/v1/file_uploads") ? json(200, { id: "u" }) : json(status, { code: "validation_error", message: "arquivo grande" }))) as never,
    });
    const api = await make(400).upload("a.png", "image/png", new Uint8Array(1)).catch((e) => e);
    expect(api).toBeInstanceOf(NotionApiError);
    expect(api.message).not.toContain("segredo");
    await expect(make(503).upload("a.png", "image/png", new Uint8Array(1))).rejects.toBeInstanceOf(NotionUnavailable);
    const net = createNotionClient({ token: "t", fetch: (async (url: string) => { if (url.endsWith("/v1/file_uploads")) return json(200, { id: "u" }); throw new TypeError("rede"); }) as never });
    await expect(net.upload("a.png", "image/png", new Uint8Array(1))).rejects.toBeInstanceOf(NotionUnavailable);
  });
});

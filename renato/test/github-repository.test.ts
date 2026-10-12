import { describe, expect, it } from "vitest";
import {
  GitHubAuthError,
  GitHubConflictError,
  GitHubNoteRepository,
  GitHubRateLimitError,
  GitHubRepositoryError,
  type HttpClient,
  type HttpRequestInit,
  type HttpResponse,
  noteFileName,
} from "../src/github-repository.js";
import { serializeNote } from "../src/markdown.js";
import type { Note } from "../src/types.js";

const TOKEN = "ghp_SUPERSECRET123";

function note(id: string, over: Partial<Note> = {}): Note {
  return {
    id,
    originalContent: "texto original",
    category: null,
    tags: [],
    createdAt: "2026-01-15T15:30:00.000Z",
    updatedAt: "2026-01-15T15:30:00.000Z",
    source: { kind: "manual" },
    ...over,
  };
}

function res(status: number, body: unknown = {}, headers: Record<string, string> = {}): HttpResponse {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    headers: { get: (n) => h[n.toLowerCase()] ?? null },
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

interface Call {
  url: string;
  init: HttpRequestInit;
}

/** GitHub falso em memória: path → {sha, markdown}. */
function fakeGitHub(files: Record<string, string> = {}) {
  const store = new Map<string, { sha: string; markdown: string }>();
  let counter = 0;
  for (const [p, md] of Object.entries(files)) store.set(p, { sha: `sha${++counter}`, markdown: md });
  const calls: Call[] = [];
  const http: HttpClient = async (url, init) => {
    calls.push({ url, init });
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname.replace(/^\/repos\/o\/r\/contents\/?/, ""));
    if (init.method === "GET") {
      const f = store.get(path);
      if (f) {
        return res(200, {
          type: "file",
          sha: f.sha,
          encoding: "base64",
          content: Buffer.from(f.markdown).toString("base64"),
        });
      }
      const children = [...store.keys()].filter((k) => k.startsWith(`${path}/`));
      if (children.length === 0) return res(404, { message: "Not Found" });
      return res(
        200,
        children.map((k) => ({ name: k.slice(path.length + 1), type: "file" })),
      );
    }
    const body = JSON.parse(init.body ?? "{}") as { content: string; sha?: string };
    const f = store.get(path);
    if (f && body.sha !== f.sha) return res(body.sha ? 409 : 422, { message: "sha mismatch" });
    if (!f && body.sha) return res(404, { message: "Not Found" });
    store.set(path, { sha: `sha${++counter}`, markdown: Buffer.from(body.content, "base64").toString("utf8") });
    return res(f ? 200 : 201, {});
  };
  return { http, store, calls };
}

const config = { owner: "o", repo: "r", branch: "main", directory: "Renato/Notas", token: TOKEN };

describe("noteFileName", () => {
  it("mantém ids seguros", () => {
    expect(noteFileName("n1")).toBe("n1.md");
    expect(noteFileName("tg-42_a")).toBe("tg-42_a.md");
  });

  it("neutraliza path traversal e separadores", () => {
    for (const id of ["../../etc/passwd", "a/b", "a\\b", "..", ".", "a\0b", "%2e%2e/x"]) {
      const name = noteFileName(id);
      expect(name).toMatch(/^[a-z0-9][a-z0-9-]*\.md$/);
      expect(name).not.toContain("..");
    }
  });

  it("é determinístico e evita colisões entre ids distintos", () => {
    expect(noteFileName("A/B")).toBe(noteFileName("A/B"));
    expect(noteFileName("A/B")).not.toBe(noteFileName("a/b"));
    expect(noteFileName("a b")).not.toBe(noteFileName("a-b"));
    expect(noteFileName("N1")).not.toBe(noteFileName("n1"));
  });

  it("limita tamanho e rejeita id vazio", () => {
    expect(noteFileName("x".repeat(500)).length).toBeLessThan(70);
    expect(() => noteFileName("")).toThrow(GitHubRepositoryError);
    expect(() => noteFileName("   ")).toThrow(GitHubRepositoryError);
  });
});

describe("GitHubNoteRepository", () => {
  it("create grava Markdown no caminho esperado e get devolve a nota", async () => {
    const gh = fakeGitHub();
    const repo = new GitHubNoteRepository(config, gh.http);
    const n = note("n1", { originalContent: "ideia: olá ``` mundo", tags: ["x"] });
    await repo.create(n);
    expect(gh.store.get("Renato/Notas/n1.md")?.markdown).toBe(serializeNote(n));
    expect(await repo.get("n1")).toEqual(n);
  });

  it("envia token apenas no header, branch e URL codificada", async () => {
    const gh = fakeGitHub();
    const repo = new GitHubNoteRepository(config, gh.http);
    await repo.create(note("n1"));
    const put = gh.calls[0]!;
    expect(put.init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(put.url).not.toContain(TOKEN);
    expect(put.init.body).not.toContain(TOKEN);
    expect(JSON.parse(put.init.body ?? "{}").branch).toBe("main");
  });

  it("get retorna null quando não existe", async () => {
    const repo = new GitHubNoteRepository(config, fakeGitHub().http);
    expect(await repo.get("nada")).toBeNull();
  });

  it("create em nota existente falha com conflito e não sobrescreve", async () => {
    const gh = fakeGitHub();
    const repo = new GitHubNoteRepository(config, gh.http);
    await repo.create(note("n1"));
    await expect(repo.create(note("n1", { category: "ideia" }))).rejects.toBeInstanceOf(GitHubConflictError);
    expect((await repo.get("n1"))?.category).toBeNull();
  });

  it("update usa o sha atual e preserva o original", async () => {
    const gh = fakeGitHub();
    const repo = new GitHubNoteRepository(config, gh.http);
    await repo.create(note("n1"));
    const updated = note("n1", { category: "estudo", updatedAt: "2026-01-16T00:00:00.000Z" });
    await repo.update(updated);
    expect(await repo.get("n1")).toEqual(updated);
    const put = gh.calls.filter((c) => c.init.method === "PUT")[1]!;
    expect(JSON.parse(put.init.body ?? "{}").sha).toBe("sha1");
  });

  it("update recusa alterar o conteúdo original", async () => {
    const gh = fakeGitHub();
    const repo = new GitHubNoteRepository(config, gh.http);
    await repo.create(note("n1"));
    await expect(repo.update(note("n1", { originalContent: "outro" }))).rejects.toThrow(/conteúdo original/);
    expect((await repo.get("n1"))?.originalContent).toBe("texto original");
  });

  it("update de nota inexistente falha", async () => {
    const repo = new GitHubNoteRepository(config, fakeGitHub().http);
    await expect(repo.update(note("n1"))).rejects.toThrow(/não encontrada/);
  });

  it("update com sha desatualizado (409) vira GitHubConflictError", async () => {
    const gh = fakeGitHub();
    const repo = new GitHubNoteRepository(config, gh.http);
    await repo.create(note("n1"));
    const racing: HttpClient = async (url, init) => {
      if (init.method === "PUT") {
        gh.store.set("Renato/Notas/n1.md", { sha: "outro", markdown: serializeNote(note("n1")) });
      }
      return gh.http(url, init);
    };
    const repo2 = new GitHubNoteRepository(config, racing);
    await expect(repo2.update(note("n1", { category: "ideia" }))).rejects.toBeInstanceOf(GitHubConflictError);
  });

  it("list retorna notas ordenadas e [] quando a pasta não existe", async () => {
    const empty = new GitHubNoteRepository(config, fakeGitHub().http);
    expect(await empty.list()).toEqual([]);

    const gh = fakeGitHub();
    const repo = new GitHubNoteRepository(config, gh.http);
    await repo.create(note("b", { createdAt: "2026-01-15T10:00:00.000Z", updatedAt: "2026-01-15T10:00:00.000Z" }));
    await repo.create(note("a"));
    await repo.create(note("Id/Estranho"));
    expect((await repo.list()).map((n) => n.id)).toEqual(["b", "Id/Estranho", "a"]);
  });

  it("list lança se o nome do arquivo não corresponde ao id", async () => {
    const gh = fakeGitHub({ "Renato/Notas/x.md": serializeNote(note("y")) });
    await expect(new GitHubNoteRepository(config, gh.http).list()).rejects.toThrow(/não corresponde/);
  });

  it("get lança para Markdown inválido ou id divergente", async () => {
    const gh = fakeGitHub({
      "Renato/Notas/ruim.md": "lixo",
      "Renato/Notas/n1.md": serializeNote(note("n2")),
    });
    const repo = new GitHubNoteRepository(config, gh.http);
    await expect(repo.get("ruim")).rejects.toThrow(/inválida/);
    await expect(repo.get("n1")).rejects.toThrow(/difere/);
  });
});

describe("erros HTTP", () => {
  const always = (r: HttpResponse): GitHubNoteRepository => new GitHubNoteRepository(config, async () => r);

  it("401 e 403 viram GitHubAuthError", async () => {
    await expect(always(res(401, { message: "Bad credentials" })).create(note("n1"))).rejects.toBeInstanceOf(GitHubAuthError);
    await expect(always(res(403, { message: "Forbidden" })).create(note("n1"))).rejects.toBeInstanceOf(GitHubAuthError);
  });

  it("429 e 403 com rate limit viram GitHubRateLimitError com espera", async () => {
    const a = always(res(429, { message: "slow down" }, { "retry-after": "30" }));
    await expect(a.get("n1")).rejects.toMatchObject({ name: "GitHubRateLimitError", retryAfterSeconds: 30 });
    const b = always(res(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0" }));
    await expect(b.create(note("n1"))).rejects.toBeInstanceOf(GitHubRateLimitError);
    const c = always(res(403, { message: "secondary rate limit" }));
    await expect(c.list()).rejects.toBeInstanceOf(GitHubRateLimitError);
  });

  it("422 e 409 no create viram conflito", async () => {
    await expect(always(res(422, { message: "sha wasn't supplied" })).create(note("n1"))).rejects.toBeInstanceOf(GitHubConflictError);
    await expect(always(res(409, { message: "conflict" })).create(note("n1"))).rejects.toBeInstanceOf(GitHubConflictError);
  });

  it("404 ao criar (branch/repo inexistente) e 5xx viram erro com status", async () => {
    await expect(always(res(404)).create(note("n1"))).rejects.toMatchObject({ status: 404 });
    await expect(always(res(500, { message: "boom" })).get("n1")).rejects.toMatchObject({ status: 500 });
  });

  it("resposta incompleta ou inválida é erro, não nota vazia", async () => {
    await expect(always(res(200, "{ não é json")).get("n1")).rejects.toThrow(/incompleta/);
    await expect(always(res(200, { type: "file", sha: "s" })).get("n1")).rejects.toThrow(/incompleta/);
    await expect(
      always(res(200, { type: "file", sha: "s", encoding: "none", content: "" })).get("n1"),
    ).rejects.toThrow(/incompleta/);
    await expect(always(res(200, { not: "array" })).list()).rejects.toThrow(/inesperada/);
  });

  it("falha de rede é encapsulada e não vaza o token", async () => {
    const repo = new GitHubNoteRepository(config, async () => {
      throw new Error(`connect failed with ${TOKEN}`);
    });
    const err = await repo.get("n1").then(() => new Error("não lançou"), (e: unknown) => e as Error);
    expect(err).toBeInstanceOf(GitHubRepositoryError);
    expect(err.message).not.toContain(TOKEN);
  });

  it("mensagens de erro da API não vazam o token", async () => {
    const repo = always(res(500, { message: `echo ${TOKEN}` }));
    const err = await repo.get("n1").then(() => new Error("não lançou"), (e: unknown) => e as Error);
    expect(err.message).not.toContain(TOKEN);
    expect(err).toBeInstanceOf(GitHubRepositoryError);
  });
});

describe("configuração", () => {
  const http: HttpClient = async () => res(200);

  it("valida campos e nunca expõe o token na serialização", () => {
    expect(() => new GitHubNoteRepository({ ...config, token: "" }, http)).toThrow(/token/);
    expect(() => new GitHubNoteRepository({ ...config, token: "a b" }, http)).toThrow(/token/);
    expect(() => new GitHubNoteRepository({ ...config, owner: "a/b" }, http)).toThrow(/owner/);
    expect(() => new GitHubNoteRepository({ ...config, branch: " " }, http)).toThrow(/branch/);
    expect(() => new GitHubNoteRepository({ ...config, directory: "a/../b" }, http)).toThrow(/directory/);
    const repo = new GitHubNoteRepository(config, http);
    expect(JSON.stringify(repo)).not.toContain(TOKEN);
  });

  it("directory vazio grava na raiz", async () => {
    const gh = fakeGitHub();
    await new GitHubNoteRepository({ ...config, directory: "" }, gh.http).create(note("n1"));
    expect(gh.store.has("n1.md")).toBe(true);
  });
});

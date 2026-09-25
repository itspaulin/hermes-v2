import { blobSha, type CommitRecord } from "../../src/vault/memory-store.js";

/**
 * GitHub falso: simula a Contents API (GET/PUT), o endpoint de branch e a semântica
 * relevante (sha por conteúdo, 422 ao criar existente, 409 com sha velho). Interface de
 * teste igual à do InMemoryVaultStore (externalWrite, externalDelete, beforeWrite, commits),
 * para rodar a mesma suíte nas duas implementações.
 */
export class FakeGitHub {
  private readonly files = new Map<string, string>();
  readonly commits: CommitRecord[] = [];
  readonly commitMessages: string[] = [];
  readonly requests: { method: string; url: string; headers: Record<string, string>; body?: unknown }[] = [];
  beforeWrite?: (op: "create" | "update", path: string) => void;

  constructor(
    readonly owner = "itspaulin",
    readonly repo = "vault",
    readonly branch = "main",
  ) {}

  externalWrite(path: string, content: string): void {
    this.files.set(path, content);
  }
  externalDelete(path: string): void {
    this.files.delete(path);
  }
  async read(path: string): Promise<{ content: string; sha: string } | null> {
    const c = this.files.get(path);
    return c === undefined ? null : { content: c, sha: blobSha(c) };
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.requests.push({ method, url: String(input), headers, body });

    const base = `/repos/${this.owner}/${this.repo}`;
    if (!url.pathname.startsWith(base)) return json(404, { message: "Not Found" });
    const rest = url.pathname.slice(base.length);

    if (rest.startsWith("/branches/")) {
      return decodeURIComponent(rest.slice("/branches/".length)) === this.branch
        ? json(200, { name: this.branch })
        : json(404, { message: "Branch not found" });
    }
    if (!rest.startsWith("/contents/")) return json(404, { message: "Not Found" });
    const path = rest.slice("/contents/".length).split("/").map(decodeURIComponent).join("/");

    if (method === "GET") {
      if (url.searchParams.get("ref") !== this.branch) return json(404, { message: "No commit found for the ref" });
      const file = this.files.get(path);
      if (file !== undefined) {
        const b64 = Buffer.from(file, "utf8").toString("base64").replace(/(.{60})/g, "$1\n");
        return json(200, {
          type: "file", path, name: path.split("/").pop(), sha: blobSha(file),
          size: Buffer.byteLength(file), encoding: "base64", content: b64,
        });
      }
      const prefix = `${path}/`;
      const children = new Map<string, unknown>();
      for (const p of this.files.keys()) {
        if (!p.startsWith(prefix)) continue;
        const name = p.slice(prefix.length).split("/")[0]!;
        const isDir = p.slice(prefix.length).includes("/");
        children.set(name, { type: isDir ? "dir" : "file", name, path: `${prefix}${name}`, sha: "x" });
      }
      return children.size ? json(200, [...children.values()]) : json(404, { message: "Not Found" });
    }

    // PUT
    if (body.branch !== this.branch) return json(404, { message: "Branch not found" });
    const content = Buffer.from(body.content, "base64").toString("utf8");
    this.beforeWrite?.(body.sha === undefined ? "create" : "update", path);
    const currentExists = this.files.has(path);
    if (body.sha === undefined) {
      if (currentExists) return json(422, { message: 'Invalid request.\n\n"sha" wasn\'t supplied.' });
      return this.commit("create", path, content, body.message, 201);
    }
    // Comportamento real (smoke test): PUT com sha em arquivo inexistente CRIA o arquivo (201).
    if (!currentExists) return this.commit("create", path, content, body.message, 201);
    if (blobSha(this.files.get(path)!) !== body.sha) {
      return json(409, { message: `${path} does not match ${body.sha}` });
    }
    if (this.files.get(path) === content) return json(200, { content: { sha: body.sha } });
    return this.commit("update", path, content, body.message, 200);
  };

  private commit(op: "create" | "update", path: string, content: string, message: string, status: number) {
    this.files.set(path, content);
    this.commits.push({ op, path });
    this.commitMessages.push(message);
    return json(status, { content: { sha: blobSha(content) } });
  }
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

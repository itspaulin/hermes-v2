import { createHash } from "node:crypto";
import { NoteFormatError, parseNote, serializeNote } from "./markdown.js";
import { type NoteRepository, NoteRepositoryError } from "./repository.js";
import type { Note } from "./types.js";

/** Subconjunto da resposta do `fetch` usado pelo adaptador (injetável nos testes). */
export interface HttpResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export interface HttpRequestInit {
  method: "GET" | "PUT";
  headers: Record<string, string>;
  body?: string;
}

/** Compatível com o `fetch` global. Nos testes, use um fake. */
export type HttpClient = (url: string, init: HttpRequestInit) => Promise<HttpResponse>;

export interface GitHubRepositoryConfig {
  owner: string;
  repo: string;
  branch: string;
  /** Pasta das notas dentro do repositório (ex.: "Renato/Notas"). */
  directory: string;
  /** Credencial injetada pelo chamador; nunca é registrada nem incluída em erros. */
  token: string;
  /** Padrão: https://api.github.com */
  apiBaseUrl?: string;
}

export class GitHubRepositoryError extends NoteRepositoryError {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GitHubRepositoryError";
  }
}

/** 401 ou 403 sem relação com limite de uso. */
export class GitHubAuthError extends GitHubRepositoryError {
  constructor(message: string, status: number) {
    super(message, status);
    this.name = "GitHubAuthError";
  }
}

/** 429 ou 403 por limite de uso. Tente de novo depois; a nota não foi gravada. */
export class GitHubRateLimitError extends GitHubRepositoryError {
  constructor(
    message: string,
    status: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message, status);
    this.name = "GitHubRateLimitError";
  }
}

/** O arquivo mudou (ou já existe) entre a leitura e a escrita. Nada foi sobrescrito. */
export class GitHubConflictError extends GitHubRepositoryError {
  constructor(message: string, status: number) {
    super(message, status);
    this.name = "GitHubConflictError";
  }
}

const ID_SAFE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const OWNER_REPO = /^[A-Za-z0-9._-]+$/;

/**
 * Nome de arquivo determinístico para um id. Ids já seguros (minúsculos, `[a-z0-9_-]`)
 * são usados como estão; os demais viram slug ASCII + hash do id original, o que evita
 * path traversal, separadores, colisões entre ids distintos e colisões por maiúsculas.
 */
export function noteFileName(id: string): string {
  if (typeof id !== "string" || id.trim() === "") throw new GitHubRepositoryError("id de nota vazio");
  if (ID_SAFE.test(id)) return `${id}.md`;
  const slug =
    id
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/g, "") || "nota";
  const hash = createHash("sha256").update(id, "utf8").digest("hex").slice(0, 12);
  return `${slug}-${hash}.md`;
}

function cleanDirectory(directory: string): string {
  const parts = directory.split("/").filter((p) => p !== "");
  for (const p of parts) {
    if (p === "." || p === ".." || p.includes("\\") || /[\u0000-\u001f]/.test(p)) {
      throw new GitHubRepositoryError("directory inválido");
    }
  }
  return parts.join("/");
}

interface ContentFile {
  sha: string;
  markdown: string;
}

/** Persiste notas como arquivos Markdown num repositório GitHub (Obsidian Vault) via Contents API. */
export class GitHubNoteRepository implements NoteRepository {
  private readonly owner: string;
  private readonly repo: string;
  private readonly branch: string;
  private readonly directory: string;
  private readonly baseUrl: string;
  readonly #token: string;
  private readonly http: HttpClient;

  constructor(config: GitHubRepositoryConfig, http: HttpClient) {
    if (!OWNER_REPO.test(config.owner) || !OWNER_REPO.test(config.repo) || config.owner === ".." || config.repo === "..") {
      throw new GitHubRepositoryError("owner/repo inválido");
    }
    if (config.branch.trim() === "") throw new GitHubRepositoryError("branch vazio");
    if (config.token.trim() === "" || /\s/.test(config.token)) {
      throw new GitHubRepositoryError("token ausente ou inválido");
    }
    this.owner = config.owner;
    this.repo = config.repo;
    this.branch = config.branch;
    this.directory = cleanDirectory(config.directory);
    this.baseUrl = (config.apiBaseUrl ?? "https://api.github.com").replace(/\/+$/, "");
    this.#token = config.token;
    this.http = http;
  }

  /** Evita vazar o token em console.log/JSON.stringify da instância. */
  toJSON(): Record<string, string> {
    return { owner: this.owner, repo: this.repo, branch: this.branch, directory: this.directory };
  }

  async create(note: Note): Promise<void> {
    const markdown = serializeNote(note);
    const path = this.pathFor(note.id);
    const res = await this.request("PUT", this.contentsUrl(path), {
      message: `renato: cria nota ${note.id}`,
      content: Buffer.from(markdown, "utf8").toString("base64"),
      branch: this.branch,
    });
    if (res.status === 200 || res.status === 201) return;
    if (res.status === 422 || res.status === 409) {
      // Sem `sha`, a API recusa quando o arquivo já existe (422) ou há escrita concorrente (409).
      throw new GitHubConflictError(`Nota já existe ou foi alterada concorrentemente: ${note.id}`, res.status);
    }
    this.fail(res, `criar nota ${note.id}`);
  }

  async update(note: Note): Promise<void> {
    const markdown = serializeNote(note);
    const path = this.pathFor(note.id);
    const current = await this.readFile(path);
    if (!current) throw new GitHubRepositoryError(`Nota não encontrada: ${note.id}`, 404);
    const existing = this.parse(note.id, current.markdown);
    if (existing.originalContent !== note.originalContent) {
      throw new GitHubRepositoryError(`Atualização não pode alterar o conteúdo original: ${note.id}`);
    }
    const res = await this.request("PUT", this.contentsUrl(path), {
      message: `renato: atualiza nota ${note.id}`,
      content: Buffer.from(markdown, "utf8").toString("base64"),
      branch: this.branch,
      sha: current.sha,
    });
    if (res.status === 200 || res.status === 201) return;
    if (res.status === 409 || res.status === 422) {
      throw new GitHubConflictError(`Conflito de versão ao atualizar nota ${note.id}; recarregue e tente de novo`, res.status);
    }
    this.fail(res, `atualizar nota ${note.id}`);
  }

  async get(id: string): Promise<Note | null> {
    const file = await this.readFile(this.pathFor(id));
    return file ? this.parse(id, file.markdown) : null;
  }

  async list(): Promise<Note[]> {
    const dirPath = this.directory;
    const res = await this.request("GET", `${this.contentsUrl(dirPath)}?ref=${encodeURIComponent(this.branch)}`);
    if (res.status === 404) return [];
    if (res.status !== 200) this.fail(res, "listar notas");
    let entries: unknown;
    try {
      entries = JSON.parse(res.body);
    } catch {
      throw new GitHubRepositoryError("Resposta incompleta ao listar notas (JSON inválido)", res.status);
    }
    if (!Array.isArray(entries)) throw new GitHubRepositoryError("Resposta inesperada ao listar notas", res.status);
    const names = entries
      .filter((e): e is { name: string; type: string } => !!e && typeof e.name === "string" && e.type === "file")
      .map((e) => e.name)
      .filter((n) => n.endsWith(".md"))
      .sort();
    const notes: Note[] = [];
    for (const name of names) {
      const file = await this.readFile(this.join(name));
      if (!file) throw new GitHubRepositoryError(`Arquivo listado desapareceu: ${name}`, 404);
      const note = this.parseAny(name, file.markdown);
      if (noteFileName(note.id) !== name) {
        throw new GitHubRepositoryError(`Nota "${name}" inválida: id "${note.id}" não corresponde ao nome do arquivo`);
      }
      notes.push(note);
    }
    return notes.sort((a, b) =>
      a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1,
    );
  }

  // --- internos ---

  private pathFor(id: string): string {
    return this.join(noteFileName(id));
  }

  private join(name: string): string {
    return this.directory ? `${this.directory}/${name}` : name;
  }

  private contentsUrl(path: string): string {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    const url = `${this.baseUrl}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/contents`;
    return `${url}${encoded ? `/${encoded}` : ""}`;
  }

  private async readFile(path: string): Promise<ContentFile | null> {
    const res = await this.request("GET", `${this.contentsUrl(path)}?ref=${encodeURIComponent(this.branch)}`);
    if (res.status === 404) return null;
    if (res.status !== 200) this.fail(res, `ler ${path}`);
    let json: unknown;
    try {
      json = JSON.parse(res.body);
    } catch {
      throw new GitHubRepositoryError(`Resposta incompleta ao ler ${path} (JSON inválido)`, res.status);
    }
    const f = json as { type?: unknown; sha?: unknown; content?: unknown; encoding?: unknown };
    if (
      !f ||
      f.type !== "file" ||
      typeof f.sha !== "string" ||
      f.sha === "" ||
      f.encoding !== "base64" ||
      typeof f.content !== "string"
    ) {
      throw new GitHubRepositoryError(`Resposta incompleta ao ler ${path}`, res.status);
    }
    return { sha: f.sha, markdown: Buffer.from(f.content, "base64").toString("utf8") };
  }

  private parse(id: string, markdown: string): Note {
    const note = this.parseAny(id, markdown);
    if (note.id !== id) throw new GitHubRepositoryError(`Nota "${id}" inválida: id "${note.id}" difere da requisitada`);
    return note;
  }

  private parseAny(label: string, markdown: string): Note {
    try {
      return parseNote(markdown);
    } catch (e) {
      if (e instanceof NoteFormatError) throw new GitHubRepositoryError(`Nota "${label}" inválida: ${e.message}`);
      throw e;
    }
  }

  private async request(
    method: "GET" | "PUT",
    url: string,
    body?: Record<string, unknown>,
  ): Promise<{ status: number; headers: HttpResponse["headers"]; body: string }> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${this.#token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "renato",
    };
    const init: HttpRequestInit = { method, headers };
    if (body) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    try {
      const res = await this.http(url, init);
      return { status: res.status, headers: res.headers, body: await res.text() };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      throw new GitHubRepositoryError(`Falha de rede ao acessar o GitHub: ${this.redact(reason)}`);
    }
  }

  private fail(res: { status: number; headers: HttpResponse["headers"]; body: string }, action: string): never {
    const detail = this.redact(this.apiMessage(res.body));
    const remaining = res.headers.get("x-ratelimit-remaining");
    const retryAfter = res.headers.get("retry-after");
    const limited =
      res.status === 429 ||
      (res.status === 403 && (remaining === "0" || retryAfter !== null || /rate limit/i.test(detail)));
    if (limited) {
      let seconds = retryAfter !== null && /^\d+$/.test(retryAfter) ? Number(retryAfter) : undefined;
      const reset = res.headers.get("x-ratelimit-reset");
      if (seconds === undefined && reset && /^\d+$/.test(reset)) {
        seconds = Math.max(0, Number(reset) - Math.floor(Date.now() / 1000));
      }
      throw new GitHubRateLimitError(`Limite de uso do GitHub atingido ao ${action}`, res.status, seconds);
    }
    if (res.status === 401) throw new GitHubAuthError(`Credencial do GitHub rejeitada (401) ao ${action}`, 401);
    if (res.status === 403) throw new GitHubAuthError(`Acesso negado pelo GitHub (403) ao ${action}`, 403);
    if (res.status === 404) throw new GitHubRepositoryError(`Recurso não encontrado (404) ao ${action}`, 404);
    if (res.status === 409 || res.status === 422) {
      throw new GitHubConflictError(`GitHub recusou a operação (${res.status}) ao ${action}: ${detail}`, res.status);
    }
    throw new GitHubRepositoryError(`GitHub respondeu ${res.status} ao ${action}: ${detail}`, res.status);
  }

  private apiMessage(body: string): string {
    try {
      const m = (JSON.parse(body) as { message?: unknown }).message;
      return typeof m === "string" ? m.slice(0, 200) : "";
    } catch {
      return "";
    }
  }

  private redact(text: string): string {
    return text.split(this.#token).join("[REDACTED]");
  }
}

import { VaultApiError, VaultInvalidNote, VaultUnavailable } from "./errors.js";
import { assertHermesDir, assertHermesPath } from "./paths.js";
import { guardVaultStore, type VaultFile, type VaultStore } from "./store.js";

/**
 * VaultStore sobre a GitHub Contents API. Não sabe o que é uma tarefa: só lê, cria,
 * atualiza com sha e lista arquivos. Traduz a API para a abstração:
 *
 *   404 (arquivo)        -> null / lista vazia
 *   422 "sha" (create)   -> "exists"
 *   409 ou 422 "sha" (update) -> "conflict"; update de arquivo removido -> GitHub RECRIA (201) -> "ok"
 *   429, 5xx, rate limit, rede -> VaultUnavailable (Telegram reenvia; tudo é idempotente)
 *   401, 403, repo/branch inexistente, outros 4xx -> VaultApiError (não adianta reenviar)
 *
 * Detalhes da API (status, headers, base64) não vazam para quem usa o VaultStore.
 * O token nunca entra em mensagens de erro.
 */
export interface GitHubVaultConfig {
  owner: string;
  repo: string;
  branch: string;
  /** PAT fine-grained (Contents: read and write, um repositório). Vem do SSM. */
  token: string;
}

export interface GitHubVaultDeps {
  fetch?: typeof fetch;
  /** Espera entre tentativas de create em corrida de branch. Injetável para testes. */
  sleep?: (ms: number) => Promise<void>;
  /** Timeout de cada requisição ao GitHub (padrão 10 s). Estouro vira VaultUnavailable. */
  timeoutMs?: number;
}

const API = "https://api.github.com";
const NAME_RE = /^[A-Za-z0-9_.-]+$/;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9_./-]*$/;
const MAX_FILE_BYTES = 1_000_000; // limite da Contents API para devolver conteúdo inline
const DIR_LISTING_LIMIT = 1000; // a Contents API trunca listagens nesse tamanho
const CREATE_RACE_ATTEMPTS = 3;

interface ApiResponse {
  status: number;
  json: unknown;
  headers: Headers;
}

/**
 * Único ponto de criação: devolve o store JÁ envolvido pela guarda de caminhos
 * (assertHermesPath/assertHermesDir antes de qualquer chamada de rede).
 */
export function createGitHubVaultStore(config: GitHubVaultConfig, deps: GitHubVaultDeps = {}): VaultStore {
  return guardVaultStore(new GitHubVaultStore(config, deps));
}

class GitHubVaultStore implements VaultStore {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly repoBase: string;
  private readonly timeoutMs: number;
  /** Verdadeiro depois de qualquer resposta que prove que repo, branch e token funcionam. */
  private verified = false;

  constructor(
    private readonly config: GitHubVaultConfig,
    deps: GitHubVaultDeps,
  ) {
    if (!NAME_RE.test(config.owner) || !NAME_RE.test(config.repo)) {
      throw new Error("owner/repo do Vault inválido");
    }
    if (!BRANCH_RE.test(config.branch) || config.branch.includes("..")) {
      throw new Error("branch do Vault inválido");
    }
    if (config.token.trim() === "") throw new Error("token do GitHub vazio");
    this.fetchImpl = deps.fetch ?? fetch;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.timeoutMs = deps.timeoutMs ?? 10_000;
    this.repoBase = `${API}/repos/${config.owner}/${config.repo}`;
  }

  async read(path: string): Promise<VaultFile | null> {
    assertHermesPath(path);
    const res = await this.request("GET", `${this.contentsUrl(path)}?ref=${encodeURIComponent(this.config.branch)}`);
    if (res.status === 200) {
      this.verified = true;
      return this.parseFile(path, res.json);
    }
    if (res.status === 404 && (await this.notFoundMeansMissing())) return null;
    return this.fail(res);
  }

  async create(path: string, content: string): Promise<"created" | "exists"> {
    assertHermesPath(path);
    const body = { message: `hermes: create ${path}`, content: toBase64(content), branch: this.config.branch };

    for (let attempt = 1; attempt <= CREATE_RACE_ATTEMPTS; attempt++) {
      const res = await this.request("PUT", this.contentsUrl(path), body);
      if (res.status === 200 || res.status === 201) {
        this.verified = true;
        return "created";
      }
      if (res.status === 422 && mentionsSha(res.json)) {
        this.verified = true;
        return "exists"; // sem sha em caminho existente: é a atomicidade do create
      }
      if (res.status === 409) {
        // O branch andou entre a leitura do head e o commit (outro escritor). Refazer é seguro:
        // criar-se-não-existir; se um commit anterior tivesse entrado, viria "exists".
        if (attempt < CREATE_RACE_ATTEMPTS) await this.sleep(250 * attempt);
        continue;
      }
      return this.fail(res);
    }
    throw new VaultUnavailable("GitHub: branch em disputa, tente novamente");
  }

  async update(path: string, sha: string, content: string): Promise<"ok" | "conflict"> {
    assertHermesPath(path);
    const res = await this.request("PUT", this.contentsUrl(path), {
      message: `hermes: update ${path}`,
      content: toBase64(content),
      sha,
      branch: this.config.branch,
    });
    if (res.status === 200 || res.status === 201) {
      this.verified = true;
      // 201 = o arquivo não existia e o GitHub o criou (comportamento real, ignora o sha).
      // Aconteceu se ele foi removido entre o read e este update. Fica registrado no stdout.
      if (res.status === 201) console.error(`[vault] update recriou arquivo removido: ${path}`);
      return "ok";
    }
    if (res.status === 409 || (res.status === 422 && mentionsSha(res.json))) {
      this.verified = true;
      return "conflict";
    }
    if (res.status === 404 && (await this.notFoundMeansMissing())) return "conflict"; // arquivo sumiu
    return this.fail(res);
  }

  async list(dir: string): Promise<string[]> {
    assertHermesDir(dir);
    const res = await this.request("GET", `${this.contentsUrl(dir)}?ref=${encodeURIComponent(this.config.branch)}`);
    if (res.status === 404) {
      if (await this.notFoundMeansMissing()) return []; // diretório ainda não existe
      return this.fail(res);
    }
    if (res.status !== 200) return this.fail(res);
    this.verified = true;

    if (!Array.isArray(res.json)) throw new VaultApiError(200, `${dir} não é um diretório`);
    if (res.json.length >= DIR_LISTING_LIMIT) {
      // A API trunca aqui; seguir em frente esconderia notas em silêncio.
      throw new VaultApiError(200, `${dir} tem ${DIR_LISTING_LIMIT}+ itens: listagem truncada`);
    }
    const paths: string[] = [];
    for (const entry of res.json as unknown[]) {
      const e = entry as { type?: unknown; path?: unknown; name?: unknown };
      if (e.type === "file" && typeof e.name === "string" && e.name.endsWith(".md") && typeof e.path === "string") {
        paths.push(e.path);
      }
    }
    return paths.sort();
  }

  // ---------- internos ----------

  private contentsUrl(path: string): string {
    return `${this.repoBase}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
  }

  private async request(method: "GET" | "PUT", url: string, body?: unknown): Promise<ApiResponse> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          authorization: `Bearer ${this.config.token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "hermes-v2",
          ...(body !== undefined && { "content-type": "application/json" }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
    } catch {
      // Rede, DNS ou timeout. Sem detalhes do erro original, por precaução com o token.
      throw new VaultUnavailable("Falha de rede ou timeout ao chamar o GitHub");
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      json = undefined;
    }
    return { status: res.status, json, headers: res.headers };
  }

  /** Converte uma resposta inesperada em VaultUnavailable (transitório) ou VaultApiError. */
  private fail(res: ApiResponse): never {
    const message = messageOf(res.json);
    if (res.status >= 500 || res.status === 429 || isRateLimited(res, message)) {
      throw new VaultUnavailable(`GitHub ${res.status}: ${message}`);
    }
    throw new VaultApiError(res.status, message);
  }

  /**
   * 404 é ambíguo no GitHub (arquivo ausente, mas também repo/branch inexistente ou token
   * sem acesso). Confirma uma vez que o branch é acessível; depois disso 404 é "ausente".
   */
  private async notFoundMeansMissing(): Promise<boolean> {
    if (this.verified) return true;
    const res = await this.request("GET", `${this.repoBase}/branches/${encodeURIComponent(this.config.branch)}`);
    if (res.status === 200) {
      this.verified = true;
      return true;
    }
    if (res.status === 404 || res.status === 401 || res.status === 403) {
      throw new VaultApiError(res.status, "repositório, branch ou permissão do token inválidos");
    }
    return this.fail(res);
  }

  private parseFile(path: string, json: unknown): VaultFile {
    const f = json as { type?: unknown; sha?: unknown; content?: unknown; encoding?: unknown; size?: unknown };
    if (Array.isArray(json) || f?.type !== "file") throw new VaultInvalidNote(path, "não é um arquivo regular");
    if (typeof f.sha !== "string") throw new VaultApiError(200, "resposta sem sha");
    if (typeof f.size === "number" && f.size > MAX_FILE_BYTES) {
      throw new VaultInvalidNote(path, "arquivo maior que 1 MB");
    }
    if (f.encoding !== "base64" || typeof f.content !== "string") {
      throw new VaultApiError(200, "conteúdo em formato inesperado");
    }
    let content: string;
    try {
      // fatal: bytes inválidos não viram U+FFFD em silêncio (reescrever corromperia o corpo).
      // ignoreBOM: mantém o BOM na string, em vez de descartá-lo.
      content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        Buffer.from(f.content.replace(/\s/g, ""), "base64"),
      );
    } catch {
      throw new VaultInvalidNote(path, "conteúdo não é UTF-8 válido");
    }
    return { content, sha: f.sha };
  }
}

function toBase64(content: string): string {
  return Buffer.from(content, "utf8").toString("base64");
}

function messageOf(json: unknown): string {
  const m = (json as { message?: unknown } | undefined)?.message;
  return typeof m === "string" ? m.replace(/\s+/g, " ").slice(0, 200) : "sem detalhes";
}

function mentionsSha(json: unknown): boolean {
  return /\bsha\b/i.test(messageOf(json));
}

function isRateLimited(res: ApiResponse, message: string): boolean {
  if (res.status !== 403) return false;
  return (
    res.headers.get("x-ratelimit-remaining") === "0" ||
    res.headers.has("retry-after") ||
    /rate limit|abuse/i.test(message)
  );
}

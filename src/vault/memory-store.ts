import { createHash } from "node:crypto";
import type { VaultFile, VaultStore } from "./store.js";

export interface CommitRecord {
  op: "create" | "update";
  path: string;
}

/** sha no formato de blob do git, como o GitHub devolve: dependente só do conteúdo. */
export function blobSha(content: string): string {
  const body = Buffer.from(content, "utf8");
  return createHash("sha1")
    .update(`blob ${body.length}\0`)
    .update(body)
    .digest("hex");
}

/**
 * VaultStore em memória com a semântica do GitHub Contents API, para testes:
 * - create em caminho existente: "exists" (o 422 do GitHub)
 * - update com sha desatualizado ou arquivo inexistente: "conflict"
 * - cada escrita que muda algo registra um "commit"; update idêntico não registra
 *
 * NÃO aplica a guarda de caminhos: use guardVaultStore(...) por cima, como em produção.
 */
export class InMemoryVaultStore implements VaultStore {
  private readonly files = new Map<string, string>();
  readonly commits: CommitRecord[] = [];

  /** Chamado antes de create/update. Permite simular edição concorrente entre a leitura e o PUT. */
  beforeWrite?: (op: "create" | "update", path: string) => void;

  /** Simula edição externa (Obsidian, obsidian-git): muda o arquivo sem passar pelo Hermes. */
  externalWrite(path: string, content: string): void {
    this.files.set(path, content);
  }

  async read(path: string): Promise<VaultFile | null> {
    const content = this.files.get(path);
    return content === undefined ? null : { content, sha: blobSha(content) };
  }

  async create(path: string, content: string): Promise<"created" | "exists"> {
    this.beforeWrite?.("create", path);
    if (this.files.has(path)) return "exists";
    this.files.set(path, content);
    this.commits.push({ op: "create", path });
    return "created";
  }

  async update(path: string, sha: string, content: string): Promise<"ok" | "conflict"> {
    this.beforeWrite?.("update", path);
    const current = this.files.get(path);
    if (current === undefined || blobSha(current) !== sha) return "conflict";
    if (current === content) return "ok";
    this.files.set(path, content);
    this.commits.push({ op: "update", path });
    return "ok";
  }

  async list(dir: string): Promise<string[]> {
    const prefix = `${dir}/`;
    return [...this.files.keys()]
      .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/") && p.endsWith(".md"))
      .sort();
  }
}

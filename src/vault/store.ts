import { assertHermesDir, assertHermesPath } from "./paths.js";

export interface VaultFile {
  content: string;
  /** Identificador de versão do conteúdo (blob sha no GitHub). */
  sha: string;
}

/**
 * I/O bruto do Vault. O domínio só conhece esta interface.
 * Implementações: InMemoryVaultStore (testes) e, depois, GitHubVaultStore.
 */
export interface VaultStore {
  /** null se o arquivo não existe. */
  read(path: string): Promise<VaultFile | null>;
  /** Criar-se-não-existir. "exists" se o caminho já existe (conteúdo não é tocado). */
  create(path: string, content: string): Promise<"created" | "exists">;
  /**
   * Atualiza com lock otimista. "conflict" se o sha não é o atual.
   *
   * ATENÇÃO (verificado no GitHub real, ver docs/smoke-test.md): se o arquivo NÃO existe
   * mais, o GitHub cria o arquivo (201) em vez de recusar, e o resultado é "ok". Não há
   * como impedir isso de forma atômica. O domínio não deve depender de "conflict" para
   * arquivo removido; a janela é só o intervalo entre o read e o update.
   */
  update(path: string, sha: string, content: string): Promise<"ok" | "conflict">;
  /** Caminhos dos arquivos .md diretamente dentro de `dir` (não recursivo). */
  list(dir: string): Promise<string[]>;
}

/**
 * Envolve qualquer VaultStore aplicando a guarda de caminhos em TODA operação,
 * antes de qualquer I/O. O domínio nunca deve receber um store sem guarda.
 */
export function guardVaultStore(inner: VaultStore): VaultStore {
  return {
    async read(path) {
      assertHermesPath(path);
      return inner.read(path);
    },
    async create(path, content) {
      assertHermesPath(path);
      return inner.create(path, content);
    },
    async update(path, sha, content) {
      assertHermesPath(path);
      return inner.update(path, sha, content);
    },
    async list(dir) {
      assertHermesDir(dir);
      const paths = await inner.list(dir);
      // Defesa em profundidade: o que volta também precisa estar dentro do contrato.
      for (const p of paths) assertHermesPath(p);
      return paths;
    },
  };
}

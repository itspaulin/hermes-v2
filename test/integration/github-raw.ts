import { expect } from "vitest";
import type { GitHubVaultConfig } from "../../src/vault/github-store.js";

/**
 * API crua do GitHub para verificar o Vault "de fora", sem passar pelo GitHubVaultStore,
 * e para limpar os arquivos criados pelos testes de integração.
 */
export function rawGitHub(cfg: GitHubVaultConfig) {
  const api = (path: string, init: RequestInit = {}) =>
    fetch(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${cfg.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "hermes-v2-integration",
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
    });

  return {
    api,
    async get(path: string): Promise<{ content: string; sha: string } | null> {
      const res = await api(`/contents/${path}?ref=${cfg.branch}`);
      if (res.status === 404) return null;
      expect(res.status).toBe(200);
      const j = (await res.json()) as { content: string; sha: string };
      return { content: Buffer.from(j.content, "base64").toString("utf8"), sha: j.sha };
    },
    async put(path: string, content: string, sha: string, message: string): Promise<void> {
      const res = await api(`/contents/${path}`, {
        method: "PUT",
        body: JSON.stringify({ message, content: Buffer.from(content, "utf8").toString("base64"), sha, branch: cfg.branch }),
      });
      expect(res.status).toBe(200);
    },
    async commitCount(path: string): Promise<number> {
      const res = await api(`/commits?path=${encodeURIComponent(path)}&sha=${cfg.branch}&per_page=100`);
      expect(res.status).toBe(200);
      return ((await res.json()) as unknown[]).length;
    },
    /** Remove um arquivo de teste. Devolve false se falhar. */
    async remove(path: string, message: string): Promise<boolean> {
      const res0 = await api(`/contents/${path}?ref=${cfg.branch}`);
      if (res0.status === 404) return true;
      const { sha } = (await res0.json()) as { sha: string };
      const res = await api(`/contents/${path}`, { method: "DELETE", body: JSON.stringify({ message, sha, branch: cfg.branch }) });
      return res.status === 200;
    },
  };
}

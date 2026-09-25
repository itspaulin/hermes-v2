import type { ParameterReader } from "../ssm.js";
import type { GitHubVaultConfig } from "./github-store.js";

/**
 * Config do Vault. owner/repo e branch não são segredo (env vars); o token vem do SSM
 * (SecureString). A Lambda recebe só o NOME do parâmetro do token.
 *   VAULT_REPO=owner/repo   VAULT_BRANCH=main   VAULT_GITHUB_TOKEN_PARAM=/hermes/prod/github/token
 */
export async function loadVaultConfig(
  ssm: ParameterReader,
  env: Record<string, string | undefined>,
): Promise<GitHubVaultConfig> {
  const need = (k: string): string => {
    const v = env[k]?.trim();
    if (!v) throw new Error(`Variável ausente: ${k}`);
    return v;
  };
  const repoFull = need("VAULT_REPO");
  const parts = repoFull.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("VAULT_REPO deve ser owner/repo");
  const token = await ssm.get(need("VAULT_GITHUB_TOKEN_PARAM"));
  return { owner: parts[0], repo: parts[1], branch: need("VAULT_BRANCH"), token };
}

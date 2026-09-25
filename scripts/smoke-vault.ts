/**
 * Smoke test REAL do GitHubVaultStore (nada de handler, Telegram ou TaskRepository).
 *
 *   VAULT_REPO=owner/repo VAULT_BRANCH=main \
 *   VAULT_GITHUB_TOKEN_PARAM=/hermes/prod/vault/github-token \
 *   npm run smoke:vault [-- --check-update-missing]
 *
 * O token é lido do SSM (credenciais AWS locais). Nunca é impresso.
 */
import { randomBytes } from "node:crypto";
import { createSsmReader } from "../src/ssm.js";
import { loadVaultConfig } from "../src/vault/config.js";
import { createGitHubVaultStore } from "../src/vault/github-store.js";
import { runVaultSmoke } from "./smoke-lib.js";

/** Registra só método, caminho e status. Sem headers, corpo ou token. */
const loggingFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  const url = new URL(String(input));
  console.log(`    http ${(init?.method ?? "GET").padEnd(3)} ${url.pathname}${url.search ? "?…" : ""} → ${res.status}`);
  return res;
};

const config = await loadVaultConfig(createSsmReader(), process.env);
const store = createGitHubVaultStore(config, { fetch: loggingFetch });

console.log(`Vault: ${config.owner}/${config.repo} @ ${config.branch}\n`);
const result = await runVaultSmoke(store, {
  suffix: randomBytes(4).toString("hex"),
  checkUpdateMissing: process.argv.includes("--check-update-missing"),
});

console.log("");
for (const s of result.steps) console.log(`${s.ok ? "OK  " : "FALHA"} ${s.name}${s.detail ? `  [${s.detail}]` : ""}`);

console.log(`\nArquivo de teste: ${result.path}`);
console.log(`Confira em https://github.com/${config.owner}/${config.repo}/commits/${config.branch} (2 commits "hermes: create/update ...")`);
console.log("O Hermes nunca apaga arquivos: remova o arquivo de teste manualmente.");
process.exit(result.ok ? 0 : 1);

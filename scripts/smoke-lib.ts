import { blobSha } from "../src/vault/memory-store.js";
import type { VaultStore } from "../src/vault/store.js";

export interface SmokeStep {
  name: string;
  ok: boolean;
  detail: string;
}

export interface SmokeOptions {
  /** Sufixo único do arquivo de teste (ex.: hex aleatório). */
  suffix: string;
  /** Opcional: também verifica update de arquivo inexistente (esperado: "conflict"). */
  checkUpdateMissing?: boolean;
}

const V1 = "---\nsmoke: 1\n---\n\n# Smoke test do Hermes\n\nAção 日本語 🚀\n";
const V2 = `${V1}\nsegunda versão\n`;

/**
 * Roteiro do smoke test do Vault. Recebe um VaultStore já pronto (GitHub real no script,
 * GitHub falso nos testes). Pára no primeiro passo que falhar (os seguintes dependem dele).
 * O único artefato deixado é um arquivo de teste em Hermes/tarefas/, que o Hermes nunca apaga.
 */
export async function runVaultSmoke(
  store: VaultStore,
  opts: SmokeOptions,
): Promise<{ ok: boolean; path: string; steps: SmokeStep[] }> {
  const path = `Hermes/tarefas/2000-01-01-smoke-test-${opts.suffix}.md`;
  const missing = `Hermes/tarefas/2000-01-01-smoke-missing-${opts.suffix}.md`;
  const steps: SmokeStep[] = [];
  let sha1 = "";
  let sha2 = "";

  const step = async (name: string, fn: () => Promise<string>): Promise<boolean> => {
    try {
      steps.push({ name, ok: true, detail: await fn() });
      return true;
    } catch (err) {
      steps.push({ name, ok: false, detail: `${(err as Error).name}: ${(err as Error).message}` });
      return false;
    }
  };
  const expectEq = (got: unknown, want: unknown): void => {
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      throw new Error(`esperado ${JSON.stringify(want)}, obtido ${JSON.stringify(got)}`);
    }
  };

  const plan: [string, () => Promise<string>][] = [
    ["GET arquivo inexistente → null (primeiro 404)", async () => {
      expectEq(await store.read(path), null);
      return "null";
    }],
    ["list de diretório inexistente → []", async () => {
      expectEq(await store.list("Hermes/checkins/2000"), []);
      return "[]";
    }],
    ["create → created", async () => {
      expectEq(await store.create(path, V1), "created");
      return "created";
    }],
    ["create repetido → exists (sem sobrescrever)", async () => {
      expectEq(await store.create(path, "outro conteúdo"), "exists");
      return "exists";
    }],
    ["read → conteúdo idêntico e sha = blob sha do git", async () => {
      const f = await store.read(path);
      if (!f) throw new Error("arquivo não encontrado após create");
      expectEq(f.content, V1);
      expectEq(f.sha, blobSha(V1));
      sha1 = f.sha;
      return `sha ${f.sha}`;
    }],
    ["update com sha correto → ok", async () => {
      expectEq(await store.update(path, sha1, V2), "ok");
      return "ok";
    }],
    ["read após update → novo conteúdo e novo sha", async () => {
      const f = await store.read(path);
      if (!f) throw new Error("arquivo sumiu");
      expectEq(f.content, V2);
      expectEq(f.sha, blobSha(V2));
      if (f.sha === sha1) throw new Error("sha não mudou");
      sha2 = f.sha;
      return `sha ${f.sha}`;
    }],
    ["update com sha antigo → conflict", async () => {
      expectEq(await store.update(path, sha1, "não deve ser gravado"), "conflict");
      return "conflict";
    }],
    ["conteúdo permanece o da segunda versão", async () => {
      const f = await store.read(path);
      expectEq(f?.content, V2);
      expectEq(f?.sha, sha2);
      return "intacto";
    }],
    ["list inclui o arquivo de teste", async () => {
      const paths = await store.list("Hermes/tarefas");
      if (!paths.includes(path)) throw new Error(`não listado em ${paths.length} arquivo(s)`);
      return `${paths.length} arquivo(s)`;
    }],
  ];

  if (opts.checkUpdateMissing) {
    plan.push(["update de arquivo inexistente → conflict", async () => {
      expectEq(await store.update(missing, blobSha("x"), "x"), "conflict");
      expectEq(await store.read(missing), null); // não pode ter criado o arquivo
      return "conflict";
    }]);
  }

  for (const [name, fn] of plan) {
    if (!(await step(name, fn))) break;
  }
  return { ok: steps.length === plan.length && steps.every((s) => s.ok), path, steps };
}

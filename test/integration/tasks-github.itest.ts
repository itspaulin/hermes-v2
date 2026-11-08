/**
 * Integração REAL: TaskRepository -> GitHubVaultStore -> GitHub. Sem Telegram, sem Lambda.
 *
 *   VAULT_REPO=owner/repo VAULT_BRANCH=main \
 *   VAULT_GITHUB_TOKEN_PARAM=/hermes/prod/vault/github-token \
 *   npm run test:integration
 *
 * Isolamento: todo arquivo criado tem ID `2020-01-01-it-<runid>-...` (data fixa no passado,
 * prefixo `it-`, id único da execução). No fim, SÓ os caminhos que este teste criou (e que
 * casam com esse padrão) são removidos, direto pela API, fora do domínio do Hermes.
 * Verificações "de fora" (conteúdo, número de commits) usam a API crua, não o store.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VaultTaskRepository } from "../../src/domain/task-repository.js";
import { taskPath } from "../../src/domain/task.js";
import { createSsmReader } from "../../src/ssm.js";
import { fakeClock } from "../../src/time/index.js";
import { loadVaultConfig } from "../../src/vault/config.js";
import { createGitHubVaultStore, type GitHubVaultConfig } from "../../src/vault/github-store.js";
import type { VaultStore } from "../../src/vault/store.js";

const RUN = randomBytes(4).toString("hex");
const EVENT = Date.parse("2020-01-01T15:00:00Z") / 1000; // 12:00 em SP, dia 2020-01-01
const ID_PREFIX = `2020-01-01-it-${RUN}-`;
const SAFE_PATH = new RegExp(`^Hermes/tarefas/${ID_PREFIX}[a-z0-9-]+\\.md$`);

let cfg: GitHubVaultConfig;
const created = new Set<string>();

// ---------- API crua (independente do GitHubVaultStore) ----------

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

async function rawGet(path: string): Promise<{ content: string; sha: string } | null> {
  const res = await api(`/contents/${path}?ref=${cfg.branch}`);
  if (res.status === 404) return null;
  expect(res.status).toBe(200);
  const j = (await res.json()) as { content: string; sha: string };
  return { content: Buffer.from(j.content, "base64").toString("utf8"), sha: j.sha };
}

async function rawPut(path: string, content: string, sha: string, message: string): Promise<void> {
  const res = await api(`/contents/${path}`, {
    method: "PUT",
    body: JSON.stringify({ message, content: Buffer.from(content, "utf8").toString("base64"), sha, branch: cfg.branch }),
  });
  expect(res.status).toBe(200);
}

async function commitCount(path: string): Promise<number> {
  const res = await api(`/commits?path=${encodeURIComponent(path)}&sha=${cfg.branch}&per_page=100`);
  expect(res.status).toBe(200);
  return ((await res.json()) as unknown[]).length;
}

/** Corpo = tudo depois da cerca de fechamento do frontmatter. */
const bodyOf = (c: string) => c.slice(c.indexOf("\n---", 4) + 4);

// ---------- montagem ----------

function newRepo(clockIso = "2020-01-01T15:10:00Z", wrap?: (s: VaultStore) => VaultStore) {
  const base = createGitHubVaultStore(cfg);
  const store: VaultStore = wrap ? wrap(base) : base;
  const clock = fakeClock(clockIso);
  const repo = new VaultTaskRepository(store, clock);
  return { repo, clock };
}

/** Cria uma tarefa de teste com título único (registra para limpeza). */
async function makeTask(repo: VaultTaskRepository, label: string) {
  const { task, created: wasCreated } = await repo.create({ title: `it ${RUN} ${label}`, eventEpochSeconds: EVENT });
  created.add(task.path);
  expect(wasCreated).toBe(true);
  expect(task.id.startsWith(ID_PREFIX)).toBe(true);
  return task;
}

beforeAll(async () => {
  cfg = await loadVaultConfig(createSsmReader(), process.env);
  console.log(`Integração: ${cfg.owner}/${cfg.repo} @ ${cfg.branch}  run=${RUN}`);
});

afterAll(async () => {
  const failed: string[] = [];
  for (const path of created) {
    if (!SAFE_PATH.test(path)) {
      failed.push(`${path} (fora do padrão de teste, NÃO removido)`);
      continue;
    }
    const f = await rawGet(path);
    if (!f) continue;
    const res = await api(`/contents/${path}`, {
      method: "DELETE",
      body: JSON.stringify({ message: `chore: limpa arquivo de teste de integração ${path}`, sha: f.sha, branch: cfg.branch }),
    });
    if (res.status !== 200) failed.push(`${path} (DELETE ${res.status})`);
  }
  console.log(failed.length ? `Limpeza INCOMPLETA, remova à mão:\n${failed.join("\n")}` : `Limpeza ok: ${created.size} arquivo(s) removido(s)`);
});

// ---------- cenários ----------

describe("TaskRepository sobre o GitHub real", () => {
  it("1. criar: o arquivo existe no GitHub com o conteúdo esperado", async () => {
    const { repo } = newRepo();
    const task = await makeTask(repo, "criar");
    const raw = await rawGet(task.path);
    expect(raw?.content).toBe(
      [
        "---",
        "schema: 1",
        `id: ${task.id}`,
        "type: tarefa",
        `title: it ${RUN} criar`,
        "status: pendente",
        "created: 2020-01-01T12:00:00-03:00",
        "updated: 2020-01-01T12:00:00-03:00",
        "---",
        "",
        `# it ${RUN} criar`,
        "",
      ].join("\n"),
    );
    expect(await commitCount(task.path)).toBe(1);
  });

  it("2. encontrar: find devolve a mesma tarefa; inexistente devolve null", async () => {
    const { repo } = newRepo();
    const task = await makeTask(repo, "encontrar");
    expect(await repo.find(task.id)).toEqual(task);
    expect(await repo.find(`${ID_PREFIX}nao-existe`)).toBeNull();
  });

  it("3. concluir: status, done_at e updated mudam; created e corpo ficam", async () => {
    const { repo } = newRepo("2020-01-01T15:10:00Z");
    const task = await makeTask(repo, "concluir");
    const before = (await rawGet(task.path))!.content;

    const { task: done, changed } = await repo.complete(task.id);
    expect(changed).toBe(true);
    expect(done).toMatchObject({
      status: "feita",
      created: "2020-01-01T12:00:00-03:00",
      doneAt: "2020-01-01T12:10:00-03:00",
      updated: "2020-01-01T12:10:00-03:00",
    });
    const after = (await rawGet(task.path))!.content;
    expect(bodyOf(after)).toBe(bodyOf(before));
    expect(after).toBe(
      before
        .replace("status: pendente", "status: feita")
        .replace("updated: 2020-01-01T12:00:00-03:00", "updated: 2020-01-01T12:10:00-03:00")
        .replace("---\n\n#", "done_at: 2020-01-01T12:10:00-03:00\n---\n\n#"),
    );
  });

  it("4. repetir conclusão: no-op, nenhum commit novo, done_at intacto", async () => {
    const { repo, clock } = newRepo();
    const task = await makeTask(repo, "repetir-concluir");
    await repo.complete(task.id);
    const snapshot = (await rawGet(task.path))!;
    const commits = await commitCount(task.path);
    expect(commits).toBe(2);

    clock.advanceMs(3_600_000);
    const again = await repo.complete(task.id);
    expect(again.changed).toBe(false);
    expect((await rawGet(task.path))!).toEqual(snapshot);
    expect(await commitCount(task.path)).toBe(commits);
  });

  it("5. cancelar: status cancelada, e repetir é no-op sem commit", async () => {
    const { repo, clock } = newRepo();
    const task = await makeTask(repo, "cancelar");
    const { task: cancelled, changed } = await repo.cancel(task.id);
    expect(changed).toBe(true);
    expect(cancelled.status).toBe("cancelada");
    expect(cancelled.doneAt).toBeUndefined();

    const commits = await commitCount(task.path);
    clock.advanceMs(60_000);
    expect((await repo.cancel(task.id)).changed).toBe(false);
    expect(await commitCount(task.path)).toBe(commits);
  });

  it("6. repetir criação: devolve a existente, sem segundo arquivo nem commit", async () => {
    const { repo } = newRepo();
    const task = await makeTask(repo, "repetir-criar");
    const again = await repo.create({ title: `it ${RUN} repetir-criar`, eventEpochSeconds: EVENT });
    expect(again.created).toBe(false);
    expect(again.task).toEqual(task);
    // Título equivalente (caixa, espaços, pontuação) e outro horário do mesmo dia: mesma tarefa.
    const alt = await repo.create({ title: `  IT ${RUN}   Repetir-Criar! `, eventEpochSeconds: EVENT + 3600 });
    expect(alt.created).toBe(false);
    expect(await commitCount(task.path)).toBe(1);
  });

  it("7. edição manual do corpo diretamente no GitHub sobrevive ao complete", async () => {
    const { repo } = newRepo();
    const task = await makeTask(repo, "edicao-manual");
    const raw = (await rawGet(task.path))!;
    const manual = `${raw.content}\nMinha anotação manual.\n\n<!-- comentário meu -->\n\n- CAP\n- sharding\n- Ação 日本語 🚀\n`;
    await rawPut(task.path, manual, raw.sha, "edição manual (teste)");

    await repo.complete(task.id);
    const after = (await rawGet(task.path))!.content;
    expect(bodyOf(after)).toBe(bodyOf(manual));
    expect(after).toContain("status: feita");
    expect(after).toContain("<!-- comentário meu -->");
    expect(after).toContain("Ação 日本語 🚀");
  });

  it("8. conflito real (409): relê, reaplica e o resultado tem a edição externa + o status", async () => {
    let injected = 0;
    let updateCalls = 0;
    const { repo } = newRepo("2020-01-01T15:10:00Z", (inner) => ({
      read: (p) => inner.read(p),
      create: (p, c) => inner.create(p, c),
      list: (d) => inner.list(d),
      update: async (p, sha, c) => {
        updateCalls++;
        if (injected === 0) {
          injected++;
          // Entre o read e o update do Hermes, alguém edita o arquivo (corpo E frontmatter).
          const cur = (await rawGet(p))!;
          const edited = cur.content
            .replace("type: tarefa", "type: tarefa\ncustom_key: 42")
            .concat("\nedição concorrente no corpo\n");
          await rawPut(p, edited, cur.sha, "edição concorrente (teste)");
        }
        return inner.update(p, sha, c);
      },
    }));
    const task = await makeTask(repo, "conflito");

    const { task: done, changed } = await repo.complete(task.id);
    expect(changed).toBe(true);
    expect(done.status).toBe("feita");
    expect(updateCalls).toBe(2); // 1ª: 409 real; 2ª: sucesso sobre a versão nova

    const after = (await rawGet(task.path))!.content;
    expect(after).toContain("custom_key: 42"); // edição externa (frontmatter) preservada
    expect(after).toContain("edição concorrente no corpo"); // edição externa (corpo) preservada
    expect(after).toContain("status: feita"); // alteração do Hermes aplicada
    expect(after).toContain("done_at: 2020-01-01T12:10:00-03:00");
  });

  it("9. listPending lê as tarefas reais e ordena", async () => {
    const { repo } = newRepo();
    const a = await makeTask(repo, "lista-a");
    const b = await makeTask(repo, "lista-b");
    await repo.complete(b.id);
    const { tasks, skipped } = await repo.listPending();
    const mine = tasks.filter((t) => t.id.startsWith(ID_PREFIX)).map((t) => t.id);
    expect(mine).toContain(a.id);
    expect(mine).not.toContain(b.id);
    expect(skipped.filter((s) => s.path.includes(ID_PREFIX))).toEqual([]);
  });

  it("10. a guarda de caminhos vale contra o GitHub real: nada fora de Hermes/ é tocado", async () => {
    const store = createGitHubVaultStore(cfg);
    for (const bad of ["README.md", "Hermes/../README.md", "Hermes2/metas/x.md"]) {
      await expect(store.read(bad)).rejects.toThrow(/fora do contrato/);
      await expect(store.create(bad, "x")).rejects.toThrow(/fora do contrato/);
    }
    expect((await rawGet("README.md"))?.content).toBeDefined();
  });
});

import { describe, expect, it, vi } from "vitest";
import { TaskNotFound, TaskRepository, TaskValidationError, type CreateTaskInput } from "../src/domain/task-repository.js";
import { parseTask, taskPath } from "../src/domain/task.js";
import { fakeClock } from "../src/time/index.js";
import { VaultConflict, VaultInvalidNote } from "../src/vault/errors.js";
import { InMemoryVaultStore } from "../src/vault/memory-store.js";
import { createGitHubVaultStore } from "../src/vault/github-store.js";
import { guardVaultStore, type VaultStore } from "../src/vault/store.js";
import { FakeGitHub } from "./support/fake-github.js";

const epoch = (iso: string) => Date.parse(iso) / 1000;
const EVENT = epoch("2026-09-25T18:00:00Z"); // 25/09 15:00 em SP
const ID = "2026-09-25-estudar-system-design";
const PATH = taskPath(ID);

/** Superfície de teste comum ao InMemoryVaultStore e ao GitHub falso. */
interface TestBackend {
  store: VaultStore;
  externalWrite(path: string, content: string): void;
  externalDelete(path: string): void;
  read(path: string): Promise<{ content: string; sha: string } | null>;
  commits: { op: string; path: string }[];
  beforeWrite?: (op: "create" | "update", path: string) => void;
}

function memoryBackend(): TestBackend {
  const mem = new InMemoryVaultStore();
  return {
    store: guardVaultStore(mem),
    externalWrite: (p, c) => mem.externalWrite(p, c),
    externalDelete: (p) => mem.externalDelete(p),
    read: (p) => mem.read(p),
    commits: mem.commits,
    set beforeWrite(fn: TestBackend["beforeWrite"]) { mem.beforeWrite = fn; },
  };
}

function githubBackend(): TestBackend {
  const gh = new FakeGitHub();
  return {
    store: createGitHubVaultStore(
      { owner: gh.owner, repo: gh.repo, branch: gh.branch, token: "t" },
      { fetch: gh.fetch, sleep: async () => {} },
    ),
    externalWrite: (p, c) => gh.externalWrite(p, c),
    externalDelete: (p) => gh.externalDelete(p),
    read: (p) => gh.read(p),
    commits: gh.commits,
    set beforeWrite(fn: TestBackend["beforeWrite"]) { gh.beforeWrite = fn; },
  };
}

/** Corpo = tudo depois da cerca de fechamento. */
const bodyOf = (c: string) => c.slice(c.indexOf("\n---", 4) + 4);

const USER_NOTE = [
  "---",
  "schema: 1",
  "id: " + ID,
  "type: tarefa",
  "title: Estudar system design",
  "status: pendente",
  "created: 2026-09-25T15:00:00-03:00",
  "# comentário yaml meu",
  "custom_key: 42",
  "tags: [a,b]",
  "---",
  "",
  "# Estudar system design",
  "",
  "Minha anotação manual.",
  "",
  "<!-- comentário meu -->",
  "",
  "- CAP",
  "- sharding",
  "- Ação 日本語 🚀",
  "",
].join("\n");

describe.each([
  ["InMemoryVaultStore", memoryBackend],
  ["GitHubVaultStore (GitHub falso)", githubBackend],
] as const)("TaskRepository sobre %s", (_name, makeBackend) => {

function setup(nowIso = "2026-09-25T18:10:00Z") {
  const mem = makeBackend();
  const clock = fakeClock(nowIso);
  const repo = new TaskRepository(mem.store, clock);
  return { mem, clock, repo };
}

describe("create", () => {
  it("cria com frontmatter completo e corpo inicial mínimo", async () => {
    const { repo, mem } = setup();
    const { task, created } = await repo.create({ title: "Estudar system design", eventEpochSeconds: EVENT });
    expect(created).toBe(true);
    expect(task).toMatchObject({
      id: ID,
      path: PATH,
      title: "Estudar system design",
      status: "pendente",
      created: "2026-09-25T15:00:00-03:00",
      updated: "2026-09-25T15:00:00-03:00",
    });
    const raw = (await mem.read(PATH))!.content;
    expect(raw).toBe(
      [
        "---",
        "schema: 1",
        `id: ${ID}`,
        "type: tarefa",
        "title: Estudar system design",
        "status: pendente",
        "created: 2026-09-25T15:00:00-03:00",
        "updated: 2026-09-25T15:00:00-03:00",
        "---",
        "",
        "# Estudar system design",
        "",
      ].join("\n"),
    );
  });

  it("grava due e meta quando informados", async () => {
    const { repo } = setup();
    const { task } = await repo.create({
      title: "Estudar system design",
      eventEpochSeconds: EVENT,
      due: "2026-09-30" as never,
      meta: "melhorar-linkedin",
    });
    expect(task).toMatchObject({ due: "2026-09-30", meta: "melhorar-linkedin" });
  });

  it("idempotente: repetir não cria, não gera commit e devolve a existente", async () => {
    const { repo, mem } = setup();
    await repo.create({ title: "Estudar system design", eventEpochSeconds: EVENT });
    const again = await repo.create({ title: "Estudar system design", eventEpochSeconds: EVENT });
    expect(again.created).toBe(false);
    expect(again.task.id).toBe(ID);
    expect(mem.commits).toHaveLength(1);
  });

  it("mesmo título no mesmo dia (outra mensagem, outro horário) é a mesma tarefa", async () => {
    const { repo, mem } = setup();
    await repo.create({ title: "Estudar system design", eventEpochSeconds: EVENT });
    const r = await repo.create({ title: "  ESTUDAR   system-design! ", eventEpochSeconds: EVENT + 3600 });
    expect(r.created).toBe(false);
    expect(mem.commits).toHaveLength(1);
  });

  it("D1: mensagem às 23:59 reprocessada às 00:01 mantém o ID do dia do evento", async () => {
    const { repo, mem, clock } = setup("2026-09-26T02:59:00Z"); // agora = 25/09 23:59
    const event = epoch("2026-09-26T02:59:00Z");
    const first = await repo.create({ title: "Estudar system design", eventEpochSeconds: event });
    clock.set("2026-09-26T03:01:00Z"); // reenvio às 00:01 do dia 26
    const retry = await repo.create({ title: "Estudar system design", eventEpochSeconds: event });
    expect(first.task.id).toBe(ID);
    expect(retry.task.id).toBe(ID);
    expect(retry.created).toBe(false);
    expect(mem.commits).toHaveLength(1);
  });

  it("dia diferente é tarefa diferente", async () => {
    const { repo, mem } = setup();
    await repo.create({ title: "Estudar system design", eventEpochSeconds: EVENT });
    const r = await repo.create({ title: "Estudar system design", eventEpochSeconds: EVENT + 86_400 });
    expect(r.created).toBe(true);
    expect(mem.commits).toHaveLength(2);
  });

  it("título com caracteres especiais e unicode faz round-trip", async () => {
    const { repo } = setup();
    const title = 'Revisar: "CAP" # teorema — 日本語 🚀';
    const { task } = await repo.create({ title, eventEpochSeconds: EVENT });
    expect((await repo.find(task.id))?.title).toBe(title);
  });

  it.each([
    ["vazio", { title: "   " }],
    ["só símbolos", { title: "!!! 👋" }],
    ["longo demais", { title: "a".repeat(201) }],
    ["controle", { title: "a\u0007b" }],
    ["due inválido", { title: "ok", due: "2026-02-30" as never }],
    ["meta inválida", { title: "ok", meta: "../x" }],
    ["evento inválido", { title: "ok", eventEpochSeconds: -5 }],
  ])("valida entrada: %s", async (_n, over) => {
    const { repo, mem } = setup();
    await expect(repo.create({ title: "ok", eventEpochSeconds: EVENT, ...(over as Partial<CreateTaskInput>) })).rejects.toBeInstanceOf(
      TaskValidationError,
    );
    expect(mem.commits).toHaveLength(0);
  });

  it("quebras de linha no título viram espaço", async () => {
    const { repo } = setup();
    const { task } = await repo.create({ title: "a\n b\t c", eventEpochSeconds: EVENT });
    expect(task.title).toBe("a b c");
  });
});

describe("complete / cancel", () => {
  it("complete altera status, done_at e updated; nada além disso", async () => {
    const { repo, mem } = setup();
    await repo.create({ title: "Estudar system design", eventEpochSeconds: EVENT });
    const before = (await mem.read(PATH))!.content;
    const { task, changed } = await repo.complete(ID);
    expect(changed).toBe(true);
    expect(task).toMatchObject({
      status: "feita",
      doneAt: "2026-09-25T15:10:00-03:00",
      updated: "2026-09-25T15:10:00-03:00",
      created: "2026-09-25T15:00:00-03:00",
    });
    const after = (await mem.read(PATH))!.content;
    expect(bodyOf(after)).toBe(bodyOf(before));
    expect(after).toBe(
      before
        .replace("status: pendente", "status: feita")
        .replace("updated: 2026-09-25T15:00:00-03:00", "updated: 2026-09-25T15:10:00-03:00")
        .replace("---\n\n# Estudar", "done_at: 2026-09-25T15:10:00-03:00\n---\n\n# Estudar"),
    );
  });

  it("updated e done_at têm o mesmo formato de created (sem milissegundos) com relógio real", async () => {
    const { repo } = setup("2026-09-25T18:10:00.430Z");
    await repo.create({ title: "Estudar system design", eventEpochSeconds: EVENT });
    const { task } = await repo.complete(ID);
    expect(task.updated).toBe("2026-09-25T15:10:00-03:00");
    expect(task.doneAt).toBe("2026-09-25T15:10:00-03:00");
    expect(task.created).toBe("2026-09-25T15:00:00-03:00");
  });

  it("created nunca muda", async () => {
    const { repo, clock } = setup();
    await repo.create({ title: "Estudar system design", eventEpochSeconds: EVENT });
    clock.set("2026-10-02T12:00:00Z");
    expect((await repo.complete(ID)).task.created).toBe("2026-09-25T15:00:00-03:00");
  });

  it("idempotente: complete duas vezes = 1 commit e updated/done_at inalterados", async () => {
    const { repo, mem, clock } = setup();
    await repo.create({ title: "Estudar system design", eventEpochSeconds: EVENT });
    await repo.complete(ID);
    const snapshot = (await mem.read(PATH))!.content;
    clock.advanceMs(3_600_000);
    const again = await repo.complete(ID);
    expect(again.changed).toBe(false);
    expect((await mem.read(PATH))!.content).toBe(snapshot);
    expect(mem.commits).toHaveLength(2); // create + 1 update
  });

  it("cancelar tarefa feita mantém done_at; completar cancelada define done_at", async () => {
    const { repo, clock } = setup();
    await repo.create({ title: "Estudar system design", eventEpochSeconds: EVENT });
    await repo.complete(ID);
    clock.advanceMs(60_000);
    const cancelled = await repo.cancel(ID);
    expect(cancelled.task).toMatchObject({ status: "cancelada", doneAt: "2026-09-25T15:10:00-03:00" });

    const { repo: r2 } = setup();
    await r2.create({ title: "Estudar system design", eventEpochSeconds: EVENT });
    await r2.cancel(ID);
    const done = await r2.complete(ID);
    expect(done.task.doneAt).toBeDefined();
  });

  it("tarefa inexistente", async () => {
    const { repo } = setup();
    await expect(repo.complete("2026-09-25-nao-existe")).rejects.toBeInstanceOf(TaskNotFound);
  });

  it("ID fora do contrato é barrado pela guarda antes de qualquer I/O", async () => {
    const { repo } = setup();
    await expect(repo.complete("../../pessoal/segredo")).rejects.toThrow(/fora do contrato/);
    await expect(repo.find("x")).rejects.toThrow(/fora do contrato/);
  });
});

describe("PRESERVAÇÃO: o corpo e o frontmatter do usuário sobrevivem", () => {
  it("complete: corpo byte a byte, comentário YAML, chaves extras, ordem e formatação", async () => {
    const { repo, mem } = setup();
    mem.externalWrite(PATH, USER_NOTE);
    await repo.complete(ID);
    const after = (await mem.read(PATH))!.content;

    expect(bodyOf(after)).toBe(bodyOf(USER_NOTE));
    expect(after).toBe(
      USER_NOTE.replace("status: pendente", "status: feita").replace(
        "tags: [a,b]\n---",
        "tags: [a,b]\ndone_at: 2026-09-25T15:10:00-03:00\nupdated: 2026-09-25T15:10:00-03:00\n---",
      ),
    );
    expect(after).toContain("# comentário yaml meu");
    expect(after).toContain("custom_key: 42");
    expect(after).toContain("tags: [a,b]");
    expect(after).toContain("Ação 日本語 🚀");
  });

  it("corpo vazio, sem quebra final", async () => {
    const { repo, mem } = setup();
    const note = USER_NOTE.slice(0, USER_NOTE.indexOf("\n---", 4) + 4); // termina na cerca
    mem.externalWrite(PATH, note);
    await repo.complete(ID);
    const after = (await mem.read(PATH))!.content;
    expect(bodyOf(after)).toBe("");
    expect(after.endsWith("\n---")).toBe(true);
  });

  it("corpo com linha '---' e CRLF interno", async () => {
    const { repo, mem } = setup();
    const note = USER_NOTE.replace("- CAP", "---\r\n- CAP\r\n---");
    mem.externalWrite(PATH, note);
    await repo.cancel(ID);
    expect(bodyOf((await mem.read(PATH))!.content)).toBe(bodyOf(note));
  });

  it("arquivo em CRLF continua em CRLF", async () => {
    const { repo, mem } = setup();
    const crlf = USER_NOTE.replace(/\n/g, "\r\n");
    mem.externalWrite(PATH, crlf);
    await repo.complete(ID);
    const after = (await mem.read(PATH))!.content;
    expect(after.replace(/\r\n/g, "")).not.toContain("\n");
    expect(after).toContain("status: feita\r\n");
    expect(bodyOf(after)).toBe(bodyOf(crlf));
  });

  it("nota sem `updated` (escrita à mão) ganha updated", async () => {
    const { repo, mem } = setup();
    mem.externalWrite(PATH, USER_NOTE);
    expect((await repo.find(ID))?.updated).toBeUndefined();
    expect((await repo.complete(ID)).task.updated).toBe("2026-09-25T15:10:00-03:00");
  });

  it("nota com status entre aspas e comentário na linha", async () => {
    const { repo, mem } = setup();
    mem.externalWrite(PATH, USER_NOTE.replace("status: pendente", 'status: "pendente"   # meu'));
    await repo.complete(ID);
    expect((await mem.read(PATH))!.content).toContain('status: "feita"   # meu\n');
  });
});

describe("CONCORRÊNCIA: releitura e reaplicação, nunca escrita forçada", () => {
  it("edição manual entre leitura e PUT: reaplica sobre a versão nova e preserva a edição", async () => {
    const { repo, mem } = setup();
    mem.externalWrite(PATH, USER_NOTE);
    let fired = false;
    mem.beforeWrite = (op, path) => {
      if (op !== "update" || fired) return;
      fired = true;
      // Usuário edita o corpo E outro campo pelo Obsidian, no meio da operação.
      mem.externalWrite(
        path,
        USER_NOTE.replace("custom_key: 42", "custom_key: 43").replace("- CAP", "- CAP (revisado)\n- novo item"),
      );
    };

    const { task, changed } = await repo.complete(ID);
    expect(changed).toBe(true);
    expect(task.status).toBe("feita");
    const after = (await mem.read(PATH))!.content;
    expect(after).toContain("custom_key: 43");
    expect(after).toContain("- CAP (revisado)\n- novo item");
    expect(after).toContain("status: feita");
    expect(bodyOf(after)).toContain("Minha anotação manual.");
  });

  it("conflito persistente: exatamente 3 tentativas, depois VaultConflict, sem sobrescrever", async () => {
    const { repo, mem } = setup();
    mem.externalWrite(PATH, USER_NOTE);
    let updates = 0;
    let counter = 0;
    mem.beforeWrite = (op, path) => {
      if (op !== "update") return;
      updates++;
      mem.externalWrite(path, USER_NOTE.replace("custom_key: 42", `custom_key: ${100 + ++counter}`));
    };

    await expect(repo.complete(ID)).rejects.toBeInstanceOf(VaultConflict);
    expect(updates).toBe(3);
    const after = (await mem.read(PATH))!.content;
    expect(after).toContain("custom_key: 103"); // a última edição do usuário ficou
    expect(after).toContain("status: pendente"); // Hermes não forçou nada
    expect(mem.commits).toHaveLength(0);
  });

  it("conflito só nas 2 primeiras tentativas: sucede na 3ª", async () => {
    const { repo, mem } = setup();
    mem.externalWrite(PATH, USER_NOTE);
    let n = 0;
    mem.beforeWrite = (op, path) => {
      if (op === "update" && n++ < 2) mem.externalWrite(path, USER_NOTE.replace("custom_key: 42", `custom_key: ${n}`));
    };
    expect((await repo.complete(ID)).changed).toBe(true);
    expect(n).toBe(3);
  });

  it("usuário já marcou como feita durante a operação: vira no-op, sem sobrescrever", async () => {
    const { repo, mem } = setup();
    mem.externalWrite(PATH, USER_NOTE);
    let fired = false;
    mem.beforeWrite = (op, path) => {
      if (op !== "update" || fired) return;
      fired = true;
      mem.externalWrite(path, USER_NOTE.replace("status: pendente", "status: feita"));
    };
    const r = await repo.complete(ID);
    expect(r.changed).toBe(false);
    expect((await mem.read(PATH))!.content).toBe(USER_NOTE.replace("status: pendente", "status: feita"));
  });

  it("arquivo removido entre o read e o update: o GitHub recria (limitação conhecida, janela mínima)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { repo, mem } = setup();
    mem.externalWrite(PATH, USER_NOTE);
    mem.beforeWrite = (op) => {
      if (op === "update") mem.externalDelete(PATH);
    };
    // O PUT com sha em caminho inexistente cria o arquivo: a operação pedida se completa.
    const r = await repo.complete(ID);
    expect(r.changed).toBe(true);
    expect((await mem.read(PATH))!.content).toContain("status: feita");
  });

  it("arquivo removido ANTES da operação: TaskNotFound", async () => {
    const { repo } = setup();
    await expect(repo.complete(ID)).rejects.toBeInstanceOf(TaskNotFound);
  });
});

describe("notas inválidas", () => {
  it.each([
    ["schema desconhecido", (s: string) => s.replace("schema: 1", "schema: 2")],
    ["type errado", (s: string) => s.replace("type: tarefa", "type: meta")],
    ["status inválido", (s: string) => s.replace("status: pendente", "status: done")],
    ["id difere do arquivo", (s: string) => s.replace(`id: ${ID}`, "id: outro")],
    ["created ausente", (s: string) => s.replace("created: 2026-09-25T15:00:00-03:00\n", "")],
    ["created sem offset", (s: string) => s.replace("-03:00", "")],
    ["due inválido", (s: string) => s.replace("custom_key: 42", "due: 2026-02-30")],
    ["title vazio", (s: string) => s.replace("title: Estudar system design", "title: ''")],
    ["sem frontmatter", () => "# só corpo\n"],
  ])("%s: complete recusa e não escreve", async (_n, mutate) => {
    const { repo, mem } = setup();
    const bad = mutate(USER_NOTE);
    mem.externalWrite(PATH, bad);
    await expect(repo.complete(ID)).rejects.toBeInstanceOf(VaultInvalidNote);
    expect((await mem.read(PATH))!.content).toBe(bad);
    expect(mem.commits).toHaveLength(0);
  });

  it("status em formato não suportado: recusa sem mexer no arquivo", async () => {
    const { repo, mem } = setup();
    const bad = USER_NOTE.replace("status: pendente", "status: |\n  pendente");
    mem.externalWrite(PATH, bad);
    await expect(repo.complete(ID)).rejects.toBeInstanceOf(VaultInvalidNote);
    expect((await mem.read(PATH))!.content).toBe(bad);
  });
});

describe("listPending", () => {
  it("só pendentes, ordenadas por prazo (sem prazo por último) e depois por ID", async () => {
    const { repo, mem } = setup();
    await repo.create({ title: "c sem prazo", eventEpochSeconds: EVENT });
    await repo.create({ title: "b prazo tarde", eventEpochSeconds: EVENT, due: "2026-10-10" as never });
    await repo.create({ title: "a prazo cedo", eventEpochSeconds: EVENT, due: "2026-09-27" as never });
    await repo.create({ title: "feita", eventEpochSeconds: EVENT });
    await repo.create({ title: "cancelada", eventEpochSeconds: EVENT });
    await repo.complete("2026-09-25-feita");
    await repo.cancel("2026-09-25-cancelada");
    mem.externalWrite("Hermes/metas/x.md", "fora do escopo da listagem");

    const { tasks, skipped } = await repo.listPending();
    expect(tasks.map((t) => t.id)).toEqual([
      "2026-09-25-a-prazo-cedo",
      "2026-09-25-b-prazo-tarde",
      "2026-09-25-c-sem-prazo",
    ]);
    expect(skipped).toEqual([]);
  });

  it("nota inválida é pulada e reportada, sem derrubar as outras", async () => {
    const { repo, mem } = setup();
    await repo.create({ title: "boa", eventEpochSeconds: EVENT });
    mem.externalWrite(taskPath("2026-09-25-quebrada"), "sem frontmatter");
    mem.externalWrite(taskPath("2026-09-25-status-ruim"), USER_NOTE.replace(ID, "2026-09-25-status-ruim").replace("pendente", "xyz"));
    const { tasks, skipped } = await repo.listPending();
    expect(tasks.map((t) => t.id)).toEqual(["2026-09-25-boa"]);
    expect(skipped.map((s) => s.path)).toEqual([
      taskPath("2026-09-25-quebrada"),
      taskPath("2026-09-25-status-ruim"),
    ]);
  });

  it("lista vazia", async () => {
    expect(await setup().repo.listPending()).toEqual({ tasks: [], skipped: [] });
  });

  it("mais de 10 tarefas (várias rodadas de leitura)", async () => {
    const { repo } = setup();
    for (let i = 0; i < 25; i++) await repo.create({ title: `tarefa ${String(i).padStart(2, "0")}`, eventEpochSeconds: EVENT });
    expect((await repo.listPending()).tasks).toHaveLength(25);
  });
});

describe("parseTask", () => {
  it("lê uma nota escrita à mão com os campos mínimos", () => {
    expect(parseTask(USER_NOTE, PATH)).toMatchObject({ id: ID, status: "pendente", created: "2026-09-25T15:00:00-03:00" });
  });
});

});

import { describe, expect, it, vi } from "vitest";
import { VaultPathViolation } from "../src/vault/errors.js";
import { blobSha, InMemoryVaultStore } from "../src/vault/memory-store.js";
import { guardVaultStore, type VaultStore } from "../src/vault/store.js";

const P = "Hermes/tarefas/2026-09-25-estudar.md";

describe("InMemoryVaultStore (semântica do GitHub)", () => {
  it("read de inexistente é null", async () => {
    expect(await new InMemoryVaultStore().read(P)).toBeNull();
  });

  it("create cria; segundo create é 'exists' e não toca no conteúdo", async () => {
    const s = new InMemoryVaultStore();
    expect(await s.create(P, "a")).toBe("created");
    expect(await s.create(P, "b")).toBe("exists");
    expect((await s.read(P))?.content).toBe("a");
    expect(s.commits).toEqual([{ op: "create", path: P }]);
  });

  it("sha é o blob sha do git (depende só do conteúdo)", async () => {
    const s = new InMemoryVaultStore();
    await s.create(P, "hello\n");
    expect((await s.read(P))?.sha).toBe("ce013625030ba8dba906f756967f9e9ca394464a"); // git hash-object
    expect(blobSha("hello\n")).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });

  it("update com sha atual funciona e gera commit", async () => {
    const s = new InMemoryVaultStore();
    await s.create(P, "a");
    const { sha } = (await s.read(P))!;
    expect(await s.update(P, sha, "b")).toBe("ok");
    expect((await s.read(P))?.content).toBe("b");
    expect(s.commits).toHaveLength(2);
  });

  it("update com sha antigo é conflito e não altera nada", async () => {
    const s = new InMemoryVaultStore();
    await s.create(P, "a");
    const { sha } = (await s.read(P))!;
    s.externalWrite(P, "editado à mão");
    expect(await s.update(P, sha, "b")).toBe("conflict");
    expect((await s.read(P))?.content).toBe("editado à mão");
    expect(s.commits).toHaveLength(1);
  });

  it("update de arquivo inexistente CRIA o arquivo (como o GitHub real, verificado no smoke test)", async () => {
    const s = new InMemoryVaultStore();
    expect(await s.update(P, "x", "b")).toBe("ok");
    expect((await s.read(P))?.content).toBe("b");
    expect(s.commits).toEqual([{ op: "create", path: P }]);
  });

  it("update idêntico não gera commit", async () => {
    const s = new InMemoryVaultStore();
    await s.create(P, "a");
    const { sha } = (await s.read(P))!;
    expect(await s.update(P, sha, "a")).toBe("ok");
    expect(s.commits).toHaveLength(1);
  });

  it("beforeWrite simula edição concorrente entre leitura e PUT", async () => {
    const s = new InMemoryVaultStore();
    await s.create(P, "a");
    const { sha } = (await s.read(P))!;
    s.beforeWrite = (op, path) => op === "update" && s.externalWrite(path, "concorrente");
    expect(await s.update(P, sha, "b")).toBe("conflict");
  });

  it("list: só .md diretamente dentro do diretório, ordenado", async () => {
    const s = new InMemoryVaultStore();
    await s.create("Hermes/tarefas/2026-09-26-b.md", "x");
    await s.create("Hermes/tarefas/2026-09-25-a.md", "x");
    await s.create("Hermes/metas/m.md", "x");
    await s.create("Hermes/checkins/2026/2026-09-25-checkin.md", "x");
    s.externalWrite("Hermes/tarefas/nota.txt", "x");
    expect(await s.list("Hermes/tarefas")).toEqual([
      "Hermes/tarefas/2026-09-25-a.md",
      "Hermes/tarefas/2026-09-26-b.md",
    ]);
    expect(await s.list("Hermes/checkins")).toEqual([]);
    expect(await s.list("Hermes/checkins/2026")).toEqual(["Hermes/checkins/2026/2026-09-25-checkin.md"]);
  });
});

function spyStore(listResult: string[] = []): VaultStore {
  return {
    read: vi.fn(async () => null),
    create: vi.fn(async () => "created" as const),
    update: vi.fn(async () => "ok" as const),
    list: vi.fn(async () => listResult),
  };
}

describe("guardVaultStore: a guarda vale em TODA operação, antes de qualquer I/O", () => {
  const evil = "Hermes/../pessoal/segredo.md";

  it("bloqueia read, create, update e list sem chamar o store interno", async () => {
    const inner = spyStore();
    const g = guardVaultStore(inner);
    await expect(g.read(evil)).rejects.toBeInstanceOf(VaultPathViolation);
    await expect(g.create(evil, "x")).rejects.toBeInstanceOf(VaultPathViolation);
    await expect(g.update(evil, "sha", "x")).rejects.toBeInstanceOf(VaultPathViolation);
    await expect(g.list("Hermes/../pessoal")).rejects.toBeInstanceOf(VaultPathViolation);
    for (const fn of Object.values(inner)) expect(fn).not.toHaveBeenCalled();
  });

  it.each(["metas/x.md", "Hermes2/metas/x.md", "Hermes/tarefas/../../x.md", "../segredo.md"])(
    "bloqueia %s",
    async (p) => {
      const inner = spyStore();
      const g = guardVaultStore(inner);
      await expect(g.create(p, "x")).rejects.toBeInstanceOf(VaultPathViolation);
      expect(inner.create).not.toHaveBeenCalled();
    },
  );

  it("caminhos válidos passam para o store interno", async () => {
    const inner = spyStore();
    const g = guardVaultStore(inner);
    await g.read(P);
    await g.create(P, "x");
    await g.update(P, "sha", "y");
    await g.list("Hermes/tarefas");
    expect(inner.read).toHaveBeenCalledWith(P);
    expect(inner.create).toHaveBeenCalledWith(P, "x");
    expect(inner.update).toHaveBeenCalledWith(P, "sha", "y");
    expect(inner.list).toHaveBeenCalledWith("Hermes/tarefas");
  });

  it("list valida também o que o store interno devolve", async () => {
    const g = guardVaultStore(spyStore(["Hermes/tarefas/2026-09-25-a.md", "pessoal/x.md"]));
    await expect(g.list("Hermes/tarefas")).rejects.toBeInstanceOf(VaultPathViolation);
  });

  it("integra com InMemoryVaultStore: fluxo válido funciona", async () => {
    const mem = new InMemoryVaultStore();
    const g = guardVaultStore(mem);
    expect(await g.create(P, "a")).toBe("created");
    expect(await g.list("Hermes/tarefas")).toEqual([P]);
    await expect(g.create("Hermes/../x.md", "a")).rejects.toBeInstanceOf(VaultPathViolation);
    expect(mem.commits).toHaveLength(1);
  });
});

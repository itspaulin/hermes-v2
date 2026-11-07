import { beforeEach, describe, expect, it } from "vitest";
import { MetaNotFound } from "../src/domain/meta-repository.js";
import { TaskNotFound, TaskValidationError } from "../src/domain/task-repository.js";
import { NotionMetaRepository } from "../src/notion/meta-repository.js";
import { NotionTaskRepository } from "../src/notion/task-repository.js";
import { fakeClock } from "../src/time/index.js";
import { FakeNotion } from "./support/fake-notion.js";

const TASKS_DB = "db-tarefas";
const METAS_DB = "db-metas";
const clock = fakeClock("2026-11-07T22:30:00Z"); // 19:30 em SP
const EVENT = Date.parse("2026-11-07T21:23:00Z") / 1000; // 18:23 em SP

const t = (s: string) => ({ title: [{ text: { content: s } }] });
const rt = (s: string) => ({ rich_text: [{ text: { content: s } }] });
const sel = (s: string) => ({ select: { name: s } });
const date = (s: string) => ({ date: { start: s } });

let notion: FakeNotion;
let metas: NotionMetaRepository;
let tasks: NotionTaskRepository;

beforeEach(() => {
  notion = new FakeNotion();
  metas = new NotionMetaRepository(notion, METAS_DB);
  tasks = new NotionTaskRepository(notion, TASKS_DB, metas, clock);
});

describe("NotionMetaRepository", () => {
  it("cria com ID, status ativa, criação com horário e prazo; repetir não duplica", async () => {
    const first = await metas.create({ title: "Melhorar LinkedIn", eventEpochSeconds: EVENT, due: "2026-12-31" as never });
    expect(first.created).toBe(true);
    expect(first.meta).toMatchObject({ id: "melhorar-linkedin", title: "Melhorar LinkedIn", status: "ativa", due: "2026-12-31", created: "2026-11-07T18:23:00-03:00" });
    const again = await metas.create({ title: "melhorar  linkedin", eventEpochSeconds: EVENT });
    expect(again.created).toBe(false);
    expect(notion.pages).toHaveLength(1);
  });

  it("find, list ordenada e setStatus idempotente", async () => {
    await metas.create({ title: "Zeta", eventEpochSeconds: EVENT });
    await metas.create({ title: "Alfa", eventEpochSeconds: EVENT, due: "2026-12-01" as never });
    expect((await metas.find("zeta"))?.title).toBe("Zeta");
    expect(await metas.find("nao-existe")).toBeNull();
    expect(await metas.find("Inválido!")).toBeNull();
    expect((await metas.list()).metas.map((m) => m.id)).toEqual(["alfa", "zeta"]);

    expect((await metas.setStatus("zeta", "concluida")).changed).toBe(true);
    expect((await metas.setStatus("zeta", "concluida")).changed).toBe(false);
    expect((await metas.find("zeta"))?.status).toBe("concluida");
    await expect(metas.setStatus("nao-existe", "pausada")).rejects.toBeInstanceOf(MetaNotFound);
  });

  it("aceita linha criada à mão no Notion (sem ID, Status e Criada) e grava o ID ao alterar", async () => {
    notion.addManual(METAS_DB, { Nome: t("Aprender Rust") });
    const [meta] = (await metas.list()).metas;
    expect(meta).toMatchObject({ id: "aprender-rust", status: "ativa" });
    expect(meta!.created).toMatch(/^2026-11-07T/);

    await metas.setStatus("aprender-rust", "pausada");
    expect(notion.pages[0]!.properties.ID.rich_text[0].plain_text).toBe("aprender-rust");
    expect((await metas.find("aprender-rust"))?.status).toBe("pausada");
    expect(notion.pages).toHaveLength(1);
  });

  it("linha com status desconhecido ou sem título vai para `skipped`, sem derrubar a lista", async () => {
    await metas.create({ title: "Boa", eventEpochSeconds: EVENT });
    notion.addManual(METAS_DB, { Nome: t("Ruim"), Status: sel("em andamento") });
    notion.addManual(METAS_DB, { Nome: t("  ") });
    const { metas: ok, skipped } = await metas.list();
    expect(ok.map((m) => m.id)).toEqual(["boa"]);
    expect(skipped.map((s) => s.reason).sort()).toEqual(["meta sem título", "status inválido: em andamento"]);
  });

  it("segue a paginação do Notion", async () => {
    notion.pageSize = 2;
    for (const n of ["a", "b", "c", "d", "e"]) await metas.create({ title: `Meta ${n}`, eventEpochSeconds: EVENT });
    expect((await metas.list()).metas).toHaveLength(5);
  });
});

describe("NotionTaskRepository", () => {
  it("cria com ID determinístico, pendente, criação com horário e prazo; repetir não duplica", async () => {
    const { task, created } = await tasks.create({ title: "Estudar inglês", eventEpochSeconds: EVENT, due: "2026-11-08" as never });
    expect(created).toBe(true);
    expect(task).toMatchObject({ id: "2026-11-07-estudar-ingles", title: "Estudar inglês", status: "pendente", due: "2026-11-08", created: "2026-11-07T18:23:00-03:00" });
    const again = await tasks.create({ title: "Estudar inglês", eventEpochSeconds: EVENT });
    expect(again.created).toBe(false);
    expect(again.task.due).toBe("2026-11-08");
    expect(notion.pages).toHaveLength(1);
  });

  it("valida a entrada como o Vault: título vazio e data inválida", async () => {
    await expect(tasks.create({ title: "  ", eventEpochSeconds: EVENT })).rejects.toBeInstanceOf(TaskValidationError);
    await expect(tasks.create({ title: "ok", eventEpochSeconds: EVENT, due: "2026-02-31" as never })).rejects.toBeInstanceOf(TaskValidationError);
    expect(notion.pages).toHaveLength(0);
  });

  it("liga a tarefa à meta pela relação e devolve o ID da meta ao ler", async () => {
    await metas.create({ title: "Melhorar LinkedIn", eventEpochSeconds: EVENT });
    const { task } = await tasks.create({ title: "Postar", eventEpochSeconds: EVENT, meta: "melhorar-linkedin" });
    expect(task.meta).toBe("melhorar-linkedin");
    const page = notion.pages.find((p) => p.database === TASKS_DB)!;
    expect(page.properties.Meta.relation).toEqual([{ id: notion.pages.find((p) => p.database === METAS_DB)!.id }]);
    expect((await tasks.find("2026-11-07-postar"))?.meta).toBe("melhorar-linkedin");
    expect((await tasks.listPending()).tasks[0]!.meta).toBe("melhorar-linkedin");
  });

  it("meta inexistente não cria a tarefa", async () => {
    await expect(tasks.create({ title: "Postar", eventEpochSeconds: EVENT, meta: "nao-existe" })).rejects.toThrow(/Meta não encontrada/);
    expect(notion.pages).toHaveLength(0);
  });

  it("complete grava Feita em uma vez só e é idempotente; cancel idem", async () => {
    await tasks.create({ title: "A", eventEpochSeconds: EVENT });
    await tasks.create({ title: "B", eventEpochSeconds: EVENT });
    const done = await tasks.complete("2026-11-07-a");
    expect(done.changed).toBe(true);
    expect(done.task).toMatchObject({ status: "feita", doneAt: "2026-11-07T19:30:00-03:00" });
    expect((await tasks.complete("2026-11-07-a")).changed).toBe(false);

    expect((await tasks.cancel("2026-11-07-b")).changed).toBe(true);
    expect((await tasks.cancel("2026-11-07-b")).changed).toBe(false);
    expect((await tasks.find("2026-11-07-b"))?.status).toBe("cancelada");
    await expect(tasks.complete("2026-11-07-nao-existe")).rejects.toBeInstanceOf(TaskNotFound);
  });

  it("setDue muda o prazo, é idempotente e só vale para pendente; o título e as outras propriedades ficam", async () => {
    await tasks.create({ title: "A", eventEpochSeconds: EVENT, due: "2026-11-10" as never });
    const r = await tasks.setDue("2026-11-07-a", "2026-11-08" as never);
    expect(r).toMatchObject({ changed: true, task: { due: "2026-11-08", title: "A", status: "pendente" } });
    expect((await tasks.setDue("2026-11-07-a", "2026-11-08" as never)).changed).toBe(false);
    await expect(tasks.setDue("2026-11-07-a", "2026-02-31" as never)).rejects.toBeInstanceOf(TaskValidationError);
    await expect(tasks.setDue("2026-11-07-nao-existe", "2026-11-08" as never)).rejects.toBeInstanceOf(TaskNotFound);
    await tasks.complete("2026-11-07-a");
    await expect(tasks.setDue("2026-11-07-a", "2026-11-09" as never)).rejects.toBeInstanceOf(TaskValidationError);
  });

  it("alterar manda só as propriedades do Hermes (não sobrescreve o que você editou no Notion)", async () => {
    await tasks.create({ title: "A", eventEpochSeconds: EVENT });
    notion.calls.length = 0;
    await tasks.complete("2026-11-07-a");
    const patch = notion.calls.find((c) => c.method === "PATCH")!;
    expect(Object.keys(patch.body.properties).sort()).toEqual(["Feita em", "Status"]);
  });

  it("listPending traz pendentes e linhas criadas à mão; listAll traz tudo; ordem: prazo, depois ID", async () => {
    await tasks.create({ title: "Sem prazo", eventEpochSeconds: EVENT });
    await tasks.create({ title: "Com prazo", eventEpochSeconds: EVENT, due: "2026-11-09" as never });
    await tasks.create({ title: "Feita", eventEpochSeconds: EVENT });
    await tasks.complete("2026-11-07-feita");
    notion.addManual(TASKS_DB, { Nome: t("Criada no Notion"), Prazo: date("2026-11-08") });

    const pending = (await tasks.listPending()).tasks;
    expect(pending.map((x) => x.title)).toEqual(["Criada no Notion", "Com prazo", "Sem prazo"]);
    expect(pending[0]).toMatchObject({ id: "2026-11-07-criada-no-notion", status: "pendente", due: "2026-11-08" });
    expect((await tasks.listAll()).tasks).toHaveLength(4);
  });

  it("tarefa criada à mão é achada por /feita (ID derivado) e ganha o ID gravado", async () => {
    notion.addManual(TASKS_DB, { Nome: t("Pagar boleto") });
    const id = (await tasks.listPending()).tasks[0]!.id;
    expect((await tasks.complete(id)).task.status).toBe("feita");
    expect(notion.pages[0]!.properties.ID.rich_text[0].plain_text).toBe(id);
    expect((await tasks.find(id))?.status).toBe("feita");
    expect(notion.pages).toHaveLength(1);
  });

  it("prazo com horário vira a data civil de São Paulo", async () => {
    notion.addManual(TASKS_DB, { Nome: t("X"), Prazo: date("2026-11-08T01:00:00.000Z") });
    expect((await tasks.listPending()).tasks[0]!.due).toBe("2026-11-07");
  });

  it("`updated` vem da última edição do Notion, sem milissegundos", async () => {
    await tasks.create({ title: "A", eventEpochSeconds: EVENT });
    expect((await tasks.find("2026-11-07-a"))!.updated).toMatch(/^2026-11-07T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("linhas inválidas vão para `skipped`", async () => {
    notion.addManual(TASKS_DB, { Nome: t("Estranha"), Status: sel("doing") });
    notion.addManual(TASKS_DB, { Nome: t("Prazo ruim"), Prazo: date("2026-13-45") });
    const { tasks: ok, skipped } = await tasks.listAll();
    expect(ok).toEqual([]);
    expect(skipped).toHaveLength(2);
  });

  it("importTask preserva status e datas, liga a meta, e não duplica", async () => {
    await metas.importMeta({ id: "m", path: "x", title: "M", status: "ativa", created: "2026-09-01T10:00:00-03:00" });
    const task = { id: "2026-09-02-velha", path: "x", title: "Velha", status: "feita" as const, created: "2026-09-02T09:00:00-03:00", doneAt: "2026-09-03T10:00:00-03:00", due: "2026-09-05" as never, meta: "m" };
    expect(await tasks.importTask(task)).toBe("created");
    expect(await tasks.importTask(task)).toBe("exists");
    expect((await tasks.find("2026-09-02-velha"))).toMatchObject({ status: "feita", created: "2026-09-02T09:00:00-03:00", doneAt: "2026-09-03T10:00:00-03:00", due: "2026-09-05", meta: "m" });
    expect(await metas.importMeta({ id: "m", path: "x", title: "M", status: "ativa", created: "2026-09-01T10:00:00-03:00" })).toBe("exists");
  });

  it("segue a paginação", async () => {
    notion.pageSize = 2;
    for (const n of "abcde") await tasks.create({ title: `Tarefa ${n}`, eventEpochSeconds: EVENT });
    expect((await tasks.listPending()).tasks).toHaveLength(5);
  });
});

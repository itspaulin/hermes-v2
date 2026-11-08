import { localDateOfInstant, nowIso, type Clock, type LocalDate } from "../time/index.js";
import { TASK_ID_RE } from "../domain/task-resolve.js";
import { TASK_STATUSES, type Task, type TaskStatus } from "../domain/task.js";
import {
  compareTasks,
  planTask,
  TaskNotFound,
  TaskValidationError,
  validateDue,
  type CreateTaskInput,
  type PendingListing,
  type TaskRepository,
} from "../domain/task-repository.js";
import { slugify } from "../vault/slug.js";
import type { NotionClient } from "../../shared/notion/client.js";
import type { NotionMetaRepository } from "./meta-repository.js";
import {
  byIdProperty,
  dateProp,
  instantOf,
  localDateOf,
  normalizeInstant,
  PROP,
  queryAll,
  relationIds,
  relationProp,
  selectName,
  selectProp,
  text,
  textProp,
  titleProp,
  withoutId,
  type NotionPage,
} from "./pages.js";

type Parsed = { ok: true; task: Task } | { ok: false; reason: string };

/** Mapa página-da-meta -> ID da meta, carregado só quando alguma tarefa tem relação. */
type MetaLookup = () => Promise<Map<string, string>>;

/**
 * Página do banco Tarefas -> Task. Linha criada à mão (sem ID, Criada ou Status) é aceita: o ID vira
 * AAAA-MM-DD-<slug do título> (data de criação da página), a criação vem da página e o status é pendente.
 */
async function parseTask(page: NotionPage, metaIds: MetaLookup): Promise<Parsed> {
  const p = page.properties;
  const title = text(p[PROP.title]).trim();
  if (title === "") return { ok: false, reason: "tarefa sem título" };

  const status = selectName(p[PROP.status]) ?? "pendente";
  if (!(TASK_STATUSES as readonly string[]).includes(status)) return { ok: false, reason: `status inválido: ${status}` };

  const created = instantOf(p[PROP.created], page.created_time)!;
  let id = text(p[PROP.id]).trim();
  if (id === "") {
    try {
      id = `${localDateOfInstant(created)}-${slugify(title)}`;
    } catch {
      return { ok: false, reason: "título sem letras ou números aproveitáveis" };
    }
  }
  if (!TASK_ID_RE.test(id)) return { ok: false, reason: `ID inválido: ${id}` };

  let due: LocalDate | undefined;
  try {
    due = localDateOf(p[PROP.due]);
  } catch {
    return { ok: false, reason: "prazo inválido" };
  }

  const [metaPage] = relationIds(p[PROP.meta]);
  const meta = metaPage === undefined ? undefined : (await metaIds()).get(metaPage);
  const doneAt = instantOf(p[PROP.doneAt]);

  return {
    ok: true,
    task: {
      id,
      path: page.id,
      title,
      status: status as TaskStatus,
      created,
      updated: normalizeInstant(page.last_edited_time),
      ...(due !== undefined && { due }),
      ...(meta !== undefined && { meta }),
      ...(doneAt !== undefined && { doneAt }),
    },
  };
}

interface Row {
  page: NotionPage;
  task: Task;
  hasId: boolean;
}

/**
 * Tarefas no banco Tarefas do Notion. Mesmo contrato do TaskRepository do Vault (docs/notion-contract.md):
 * criar é criar-se-não-existir por ID determinístico; alterar muda só as propriedades do Hermes.
 * Sem lock otimista: o Notion atualiza propriedade por propriedade, então edições suas em outros campos
 * não são perdidas.
 */
export class NotionTaskRepository implements TaskRepository {
  constructor(
    private readonly client: NotionClient,
    private readonly databaseId: string,
    private readonly metas: NotionMetaRepository,
    private readonly clock: Clock,
  ) {}

  plan(input: CreateTaskInput): { id: string; title: string; createdAt: string } {
    return planTask(input);
  }

  async create(input: CreateTaskInput): Promise<{ task: Task; created: boolean }> {
    const { id, title, createdAt } = planTask(input);
    const existing = await this.findRow(id, false);
    if (existing) return { task: existing.task, created: false };

    const metaPage = input.meta === undefined ? undefined : await this.metaPageId(input.meta);
    const page: NotionPage = await this.client.request("POST", "/v1/pages", {
      parent: { database_id: this.databaseId },
      properties: {
        [PROP.title]: titleProp(title),
        [PROP.id]: textProp(id),
        [PROP.status]: selectProp("pendente"),
        [PROP.created]: dateProp(createdAt),
        ...(input.due !== undefined && { [PROP.due]: dateProp(input.due) }),
        ...(metaPage !== undefined && { [PROP.meta]: relationProp([metaPage]) }),
      },
    });
    return { task: await this.parsed(page), created: true };
  }

  async find(id: string): Promise<Task | null> {
    return (await this.findRow(id, true))?.task ?? null;
  }

  complete(id: string): Promise<{ task: Task; changed: boolean }> {
    return this.mutate(id, (task, now) =>
      task.status === "feita"
        ? null
        : { [PROP.status]: selectProp("feita"), ...(task.doneAt === undefined && { [PROP.doneAt]: dateProp(now) }) },
    );
  }

  cancel(id: string): Promise<{ task: Task; changed: boolean }> {
    return this.mutate(id, (task) => (task.status === "cancelada" ? null : { [PROP.status]: selectProp("cancelada") }));
  }

  async setDue(id: string, due: LocalDate): Promise<{ task: Task; changed: boolean }> {
    validateDue(due);
    return this.mutate(id, (task) => {
      if (task.status !== "pendente") throw new TaskValidationError(`A tarefa já está ${task.status}.`);
      return task.due === due ? null : { [PROP.due]: dateProp(due) };
    });
  }

  async listPending(): Promise<PendingListing> {
    // Sem Status (linha criada à mão) conta como pendente.
    const filter = { or: [{ property: PROP.status, select: { equals: "pendente" } }, { property: PROP.status, select: { is_empty: true } }] };
    return this.list(filter);
  }

  listAll(): Promise<PendingListing> {
    return this.list(undefined);
  }

  /** Migração: cria a tarefa com todos os campos (status, datas, meta), se o ID ainda não existe. */
  async importTask(task: Task): Promise<"created" | "exists"> {
    if (await this.findRow(task.id, false)) return "exists";
    const metaPage = task.meta === undefined ? undefined : await this.metaPageId(task.meta).catch(() => undefined);
    await this.client.request("POST", "/v1/pages", {
      parent: { database_id: this.databaseId },
      properties: {
        [PROP.title]: titleProp(task.title),
        [PROP.id]: textProp(task.id),
        [PROP.status]: selectProp(task.status),
        [PROP.created]: dateProp(task.created),
        ...(task.due !== undefined && { [PROP.due]: dateProp(task.due) }),
        ...(task.doneAt !== undefined && { [PROP.doneAt]: dateProp(task.doneAt) }),
        ...(metaPage !== undefined && { [PROP.meta]: relationProp([metaPage]) }),
      },
    });
    return "created";
  }

  private async list(filter: unknown): Promise<PendingListing> {
    const lookup = this.metaLookup();
    const tasks: Task[] = [];
    const skipped: PendingListing["skipped"] = [];
    for (const page of await queryAll(this.client, this.databaseId, filter)) {
      const r = await parseTask(page, lookup);
      if (r.ok) tasks.push(r.task);
      else skipped.push({ path: page.id, reason: r.reason });
    }
    tasks.sort(compareTasks);
    skipped.sort((a, b) => a.path.localeCompare(b.path));
    return { tasks, skipped };
  }

  /** Lê a linha, calcula as propriedades a mudar (null = nada muda) e grava só elas. */
  private async mutate(
    id: string,
    plan: (task: Task, now: string) => Record<string, unknown> | null,
  ): Promise<{ task: Task; changed: boolean }> {
    const row = await this.findRow(id, true);
    if (!row) throw new TaskNotFound(id);
    const props = plan(row.task, nowIso(this.clock));
    if (props === null) return { task: row.task, changed: false };
    // Linha criada à mão: grava o ID derivado, para a tarefa passar a ser achada por ele.
    if (!row.hasId) props[PROP.id] = textProp(id);
    const page: NotionPage = await this.client.request("PATCH", `/v1/pages/${row.page.id}`, { properties: props });
    return { task: await this.parsed(page), changed: true };
  }

  private async parsed(page: NotionPage): Promise<Task> {
    const r = await parseTask(page, this.metaLookup());
    if (!r.ok) throw new Error(`Tarefa inválida no Notion (${page.id}): ${r.reason}`);
    return r.task;
  }

  private metaLookup(): MetaLookup {
    let cached: Promise<Map<string, string>> | undefined;
    return () => (cached ??= this.metas.withPages().then((all) => new Map(all.map((m) => [m.pageId, m.meta.id]))));
  }

  private async metaPageId(metaId: string): Promise<string> {
    const found = (await this.metas.withPages()).find((m) => m.meta.id === metaId);
    if (!found) throw new TaskValidationError(`Meta não encontrada: ${metaId}`);
    return found.pageId;
  }

  /** Linha pelo ID; com `adoptManual`, também linhas criadas à mão (sem ID) cujo ID derivado bate. A mais antiga vence. */
  private async findRow(id: string, adoptManual: boolean): Promise<Row | null> {
    const lookup = this.metaLookup();
    const hit = (await queryAll(this.client, this.databaseId, byIdProperty(id)))[0];
    if (hit) {
      const r = await parseTask(hit, lookup);
      return r.ok ? { page: hit, task: r.task, hasId: true } : null;
    }
    if (!adoptManual) return null;
    for (const page of await queryAll(this.client, this.databaseId, withoutId)) {
      const r = await parseTask(page, lookup);
      if (r.ok && r.task.id === id) return { page, task: r.task, hasId: false };
    }
    return null;
  }
}

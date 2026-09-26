import {
  instantIsoOfEpochSeconds,
  localDateOfEpochSeconds,
  nowIso,
  parseLocalDate,
  type Clock,
  type LocalDate,
} from "../time/index.js";
import { VaultConflict, VaultInvalidNote } from "../vault/errors.js";
import { parseNote, renderNote, serializeNote, setScalar } from "../vault/frontmatter.js";
import { isSlug, slugify } from "../vault/slug.js";
import type { VaultStore } from "../vault/store.js";
import {
  parseTask,
  taskFromNote,
  taskPath,
  TASK_SCHEMA_VERSION,
  TASKS_DIR,
  type Task,
  type TaskStatus,
} from "./task.js";

export const MAX_ATTEMPTS = 3;
const MAX_TITLE_LENGTH = 200;
const READ_CONCURRENCY = 10;

/** Entrada inválida do usuário (título vazio, data ruim...). Não é falha de infraestrutura. */
export class TaskValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskValidationError";
  }
}

export class TaskNotFound extends Error {
  constructor(readonly id: string) {
    super(`Tarefa não encontrada: ${id}`);
    this.name = "TaskNotFound";
  }
}

export interface CreateTaskInput {
  title: string;
  /** Instante do EVENTO (ex.: message.date do Telegram), em epoch seconds. Define o ID e `created`. */
  eventEpochSeconds: number;
  due?: LocalDate;
  meta?: string;
}

export interface PendingListing {
  tasks: Task[];
  /** Notas que o Hermes não conseguiu interpretar. Ficam de fora, não derrubam a listagem. */
  skipped: { path: string; reason: string }[];
}

/**
 * Tarefas sobre um VaultStore. Não conhece Telegram nem GitHub.
 * O store recebido deve ser o guardado (guardVaultStore).
 *
 * Contrato (docs/vault-contract.md): criar é criar-se-não-existir; alterar é "set" de
 * campos do Hermes com lock otimista por sha, releitura e reaplicação em conflito
 * (até MAX_ATTEMPTS) e NUNCA escrita forçada. O corpo da nota nunca é tocado.
 */
export class TaskRepository {
  constructor(
    private readonly store: VaultStore,
    private readonly clock: Clock,
  ) {}

  /** Idempotente: mesmo evento/título gera o mesmo ID; se já existe, devolve a existente. */
  async create(input: CreateTaskInput): Promise<{ task: Task; created: boolean }> {
    const title = normalizeTitle(input.title);
    let slug: string;
    try {
      slug = slugify(title);
    } catch {
      throw new TaskValidationError("Título sem letras ou números aproveitáveis");
    }
    if (input.due !== undefined) validateDue(input.due);
    if (input.meta !== undefined && !isSlug(input.meta)) {
      throw new TaskValidationError(`ID de meta inválido: ${input.meta}`);
    }

    // Tempo do evento (não o relógio): um reenvio depois da meia-noite mantém o ID.
    let date: LocalDate;
    let createdAt: string;
    try {
      date = localDateOfEpochSeconds(input.eventEpochSeconds);
      createdAt = instantIsoOfEpochSeconds(input.eventEpochSeconds);
    } catch {
      throw new TaskValidationError("Instante do evento inválido");
    }

    const id = `${date}-${slug}`;
    const path = taskPath(id);
    const content = renderNote(
      {
        schema: TASK_SCHEMA_VERSION,
        id,
        type: "tarefa",
        title,
        status: "pendente",
        created: createdAt,
        updated: createdAt,
        ...(input.due !== undefined && { due: input.due }),
        ...(input.meta !== undefined && { meta: input.meta }),
      },
      // Wikilink só para navegação no Obsidian; o Hermes lê o vínculo do frontmatter.
      `\n# ${title}\n${input.meta !== undefined ? `\nMeta: [[${input.meta}]]\n` : ""}`,
    );

    if ((await this.store.create(path, content)) === "created") {
      return { task: parseTask(content, path), created: true };
    }
    const existing = await this.store.read(path);
    if (!existing) throw new VaultConflict(path); // sumiu entre o "exists" e a leitura
    return { task: parseTask(existing.content, path), created: false };
  }

  async find(id: string): Promise<Task | null> {
    const path = taskPath(id);
    const file = await this.store.read(path);
    return file ? parseTask(file.content, path) : null;
  }

  /** Idempotente. `changed` = false se já estava feita (nada é escrito). */
  complete(id: string): Promise<{ task: Task; changed: boolean }> {
    return this.setStatus(id, "feita");
  }

  /** Idempotente. `changed` = false se já estava cancelada (nada é escrito). */
  cancel(id: string): Promise<{ task: Task; changed: boolean }> {
    return this.setStatus(id, "cancelada");
  }

  async listPending(): Promise<PendingListing> {
    const { tasks, skipped } = await this.listAll();
    return { tasks: tasks.filter((t) => t.status === "pendente"), skipped };
  }

  /** Tarefas de qualquer status (para estatísticas). Mesma ordenação de listPending. */
  async listAll(): Promise<PendingListing> {
    const paths = await this.store.list(TASKS_DIR);
    const tasks: Task[] = [];
    const skipped: PendingListing["skipped"] = [];

    for (let i = 0; i < paths.length; i += READ_CONCURRENCY) {
      const chunk = paths.slice(i, i + READ_CONCURRENCY);
      const results = await Promise.all(
        chunk.map(async (path) => {
          const file = await this.store.read(path);
          if (!file) return null; // removida entre list e read
          try {
            return parseTask(file.content, path);
          } catch (err) {
            if (err instanceof VaultInvalidNote) {
              skipped.push({ path, reason: err.message });
              return null;
            }
            throw err;
          }
        }),
      );
      for (const t of results) if (t) tasks.push(t);
    }

    tasks.sort(compareTasks);
    skipped.sort((a, b) => a.path.localeCompare(b.path));
    return { tasks, skipped };
  }

  private async setStatus(id: string, target: TaskStatus): Promise<{ task: Task; changed: boolean }> {
    const path = taskPath(id);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const file = await this.store.read(path);
      if (!file) throw new TaskNotFound(id);

      const note = parseNote(file.content, path);
      const current = taskFromNote(note, path);
      if (current.status === target) return { task: current, changed: false };

      // Só campos que o Hermes possui. Corpo e chaves desconhecidas ficam como estão.
      const now = nowIso(this.clock);
      setScalar(note, "status", target);
      if (target === "feita" && current.doneAt === undefined) setScalar(note, "done_at", now);
      setScalar(note, "updated", now);
      const next = serializeNote(note);

      if ((await this.store.update(path, file.sha, next)) === "ok") {
        return { task: parseTask(next, path), changed: true };
      }
      // conflict: relê e reaplica a operação sobre a versão nova. Nunca força.
    }
    throw new VaultConflict(path);
  }
}

function normalizeTitle(raw: string): string {
  const title = raw.replace(/\s+/g, " ").trim();
  if (title === "") throw new TaskValidationError("Título vazio");
  if (title.length > MAX_TITLE_LENGTH) {
    throw new TaskValidationError(`Título longo demais (máximo ${MAX_TITLE_LENGTH} caracteres)`);
  }
  if (/[\u0000-\u001f\u007f]/.test(title)) throw new TaskValidationError("Título com caracteres de controle");
  return title;
}

function validateDue(due: string): void {
  try {
    parseLocalDate(due);
  } catch {
    throw new TaskValidationError(`Data inválida: ${due}`);
  }
}

/** Com prazo primeiro (mais cedo antes), sem prazo depois; desempate por ID. */
function compareTasks(a: Task, b: Task): number {
  if (a.due && b.due && a.due !== b.due) return a.due < b.due ? -1 : 1;
  if (a.due && !b.due) return -1;
  if (!a.due && b.due) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

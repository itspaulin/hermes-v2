import { isSlug } from "../vault/slug.js";
import { VaultInvalidNote } from "../vault/errors.js";
import { parseNote, type Note } from "../vault/frontmatter.js";
import { HERMES_ROOT } from "../vault/paths.js";
import { parseInstantIso, parseLocalDate, type LocalDate } from "../time/index.js";

export const TASK_STATUSES = ["pendente", "feita", "cancelada"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_SCHEMA_VERSION = 1;
export const TASKS_DIR = `${HERMES_ROOT}/tarefas`;

export interface Task {
  id: string;
  path: string;
  title: string;
  status: TaskStatus;
  /** Instante ISO 8601 com offset. Nunca alterado depois da criação. */
  created: string;
  /** Instante da última alteração feita pelo Hermes. Pode faltar em notas escritas à mão. */
  updated?: string;
  due?: LocalDate;
  /** ID da meta associada. */
  meta?: string;
  /** Instante da primeira conclusão. */
  doneAt?: string;
}

export function taskPath(id: string): string {
  return `${TASKS_DIR}/${id}.md`;
}

export function taskIdFromPath(path: string): string {
  return path.slice(TASKS_DIR.length + 1, -".md".length);
}

/** Valida o frontmatter de uma tarefa. Lança VaultInvalidNote com o motivo. */
export function taskFromNote(note: Note, path: string): Task {
  const d = note.data;
  const bad = (reason: string): never => {
    throw new VaultInvalidNote(path, reason);
  };
  const str = (key: string, required: boolean): string | undefined => {
    const v = d[key];
    if (v === undefined || v === null) return required ? bad(`campo ausente: ${key}`) : undefined;
    if (typeof v !== "string" || v.trim() === "") return bad(`campo inválido: ${key}`);
    return v;
  };
  const wrap = <T>(key: string, fn: (s: string) => T, v: string | undefined): T | undefined => {
    if (v === undefined) return undefined;
    try {
      return fn(v);
    } catch {
      return bad(`campo inválido: ${key}`);
    }
  };

  if (d.schema !== TASK_SCHEMA_VERSION) bad(`schema desconhecido: ${String(d.schema)}`);
  if (d.type !== "tarefa") bad(`type inesperado: ${String(d.type)}`);

  const id = str("id", true)!;
  if (id !== taskIdFromPath(path)) bad("id difere do nome do arquivo");

  const status = str("status", true)!;
  if (!(TASK_STATUSES as readonly string[]).includes(status)) bad(`status inválido: ${status}`);

  const meta = str("meta", false);
  if (meta !== undefined && !isSlug(meta)) bad("campo inválido: meta");

  return {
    id,
    path,
    title: str("title", true)!,
    status: status as TaskStatus,
    created: wrap("created", parseInstantIso, str("created", true))!,
    updated: wrap("updated", parseInstantIso, str("updated", false)),
    due: wrap("due", parseLocalDate, str("due", false)),
    meta,
    doneAt: wrap("done_at", parseInstantIso, str("done_at", false)),
  };
}

export function parseTask(content: string, path: string): Task {
  return taskFromNote(parseNote(content, path), path);
}

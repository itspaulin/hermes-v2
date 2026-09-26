import { VaultInvalidNote } from "../vault/errors.js";
import { parseNote, type Note } from "../vault/frontmatter.js";
import { HERMES_ROOT } from "../vault/paths.js";
import { isSlug } from "../vault/slug.js";
import { parseInstantIso, parseLocalDate, type LocalDate } from "../time/index.js";

export const META_STATUSES = ["ativa", "concluida", "pausada", "cancelada"] as const;
export type MetaStatus = (typeof META_STATUSES)[number];

export const META_SCHEMA_VERSION = 1;
export const METAS_DIR = `${HERMES_ROOT}/metas`;

export interface Meta {
  /** Slug do título. Igual ao nome do arquivo. */
  id: string;
  path: string;
  title: string;
  status: MetaStatus;
  /** Instante ISO 8601 com offset. Nunca alterado depois da criação. */
  created: string;
  updated?: string;
  due?: LocalDate;
}

export function metaPath(id: string): string {
  return `${METAS_DIR}/${id}.md`;
}

export function metaIdFromPath(path: string): string {
  return path.slice(METAS_DIR.length + 1, -".md".length);
}

/** Valida o frontmatter de uma meta. Lança VaultInvalidNote com o motivo. */
export function metaFromNote(note: Note, path: string): Meta {
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

  if (d.schema !== META_SCHEMA_VERSION) bad(`schema desconhecido: ${String(d.schema)}`);
  if (d.type !== "meta") bad(`type inesperado: ${String(d.type)}`);

  const id = str("id", true)!;
  if (!isSlug(id) || id !== metaIdFromPath(path)) bad("id difere do nome do arquivo");

  const status = str("status", true)!;
  if (!(META_STATUSES as readonly string[]).includes(status)) bad(`status inválido: ${status}`);

  return {
    id,
    path,
    title: str("title", true)!,
    status: status as MetaStatus,
    created: wrap("created", parseInstantIso, str("created", true))!,
    updated: wrap("updated", parseInstantIso, str("updated", false)),
    due: wrap("due", parseLocalDate, str("due", false)),
  };
}

export function parseMeta(content: string, path: string): Meta {
  return metaFromNote(parseNote(content, path), path);
}

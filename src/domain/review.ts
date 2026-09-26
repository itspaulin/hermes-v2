import { VaultInvalidNote } from "../vault/errors.js";
import { parseNote, type Note } from "../vault/frontmatter.js";
import { HERMES_ROOT } from "../vault/paths.js";
import { isoWeekLabel, parseInstantIso, parseLocalDate, type LocalDate } from "../time/index.js";

export const REVIEW_SCHEMA_VERSION = 1;
export const REVIEWS_DIR = `${HERMES_ROOT}/revisoes`;

export interface Review {
  /** Semana ISO, ex.: `2026-W39`. Igual ao nome do arquivo. */
  id: string;
  path: string;
  /** Segunda-feira da semana. */
  weekStart: LocalDate;
  created: string;
  updated?: string;
  answeredAt?: string;
  answer?: string;
}

export function reviewPath(id: string): string {
  return `${REVIEWS_DIR}/${id}.md`;
}

/** Valida o frontmatter de uma revisão. Lança VaultInvalidNote com o motivo. */
export function reviewFromNote(note: Note, path: string): Review {
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

  if (d.schema !== REVIEW_SCHEMA_VERSION) bad(`schema desconhecido: ${String(d.schema)}`);
  if (d.type !== "revisao") bad(`type inesperado: ${String(d.type)}`);

  const id = str("id", true)!;
  const weekStart = wrap("week_start", parseLocalDate, str("week_start", true))!;
  if (path !== reviewPath(id) || str("week", true) !== id || isoWeekLabel(weekStart) !== id) {
    bad("id, week ou week_start diferem do nome do arquivo");
  }

  return {
    id,
    path,
    weekStart,
    created: wrap("created", parseInstantIso, str("created", true))!,
    updated: wrap("updated", parseInstantIso, str("updated", false)),
    answeredAt: wrap("answered_at", parseInstantIso, str("answered_at", false)),
    answer: str("answer", false),
  };
}

export function parseReview(content: string, path: string): Review {
  return reviewFromNote(parseNote(content, path), path);
}

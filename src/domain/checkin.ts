import { VaultInvalidNote } from "../vault/errors.js";
import { parseNote, type Note } from "../vault/frontmatter.js";
import { HERMES_ROOT } from "../vault/paths.js";
import { parseInstantIso, parseLocalDate, type LocalDate } from "../time/index.js";

export const CHECKIN_KINDS = ["checkin", "metrics"] as const;
export type CheckinKind = (typeof CHECKIN_KINDS)[number];

export const CHECKIN_SCHEMA_VERSION = 1;
export const CHECKINS_DIR = `${HERMES_ROOT}/checkins`;

export interface Checkin {
  /** `<AAAA-MM-DD>-<tipo>`. Igual ao nome do arquivo. */
  id: string;
  path: string;
  kind: CheckinKind;
  date: LocalDate;
  created: string;
  updated?: string;
  answeredAt?: string;
  /** Resposta do usuário numa linha só (várias respostas separadas por " | "). */
  answer?: string;
}

export function checkinId(date: LocalDate, kind: CheckinKind): string {
  return `${date}-${kind}`;
}

export function checkinYearDir(year: string): string {
  return `${CHECKINS_DIR}/${year}`;
}

export function checkinPath(date: LocalDate, kind: CheckinKind): string {
  return `${checkinYearDir(date.slice(0, 4))}/${checkinId(date, kind)}.md`;
}

/** Valida o frontmatter de um check-in. Lança VaultInvalidNote com o motivo. */
export function checkinFromNote(note: Note, path: string): Checkin {
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

  if (d.schema !== CHECKIN_SCHEMA_VERSION) bad(`schema desconhecido: ${String(d.schema)}`);
  if (d.type !== "checkin") bad(`type inesperado: ${String(d.type)}`);

  const kind = str("kind", true)!;
  if (!(CHECKIN_KINDS as readonly string[]).includes(kind)) bad(`kind inválido: ${kind}`);
  const date = wrap("date", parseLocalDate, str("date", true))!;
  const id = str("id", true)!;
  if (id !== checkinId(date, kind as CheckinKind) || path !== checkinPath(date, kind as CheckinKind)) {
    bad("id, date ou kind diferem do nome do arquivo");
  }

  return {
    id,
    path,
    kind: kind as CheckinKind,
    date,
    created: wrap("created", parseInstantIso, str("created", true))!,
    updated: wrap("updated", parseInstantIso, str("updated", false)),
    answeredAt: wrap("answered_at", parseInstantIso, str("answered_at", false)),
    answer: str("answer", false),
  };
}

export function parseCheckin(content: string, path: string): Checkin {
  return checkinFromNote(parseNote(content, path), path);
}

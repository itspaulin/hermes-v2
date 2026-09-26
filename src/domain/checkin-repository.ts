import { addDays, nowIso, type Clock, type LocalDate } from "../time/index.js";
import { VaultConflict, VaultInvalidNote } from "../vault/errors.js";
import { renderNote } from "../vault/frontmatter.js";
import type { VaultStore } from "../vault/store.js";
import { hasAnswered, writeAnswer } from "./answer.js";
import {
  checkinFromNote,
  checkinId,
  checkinPath,
  checkinYearDir,
  parseCheckin,
  CHECKIN_SCHEMA_VERSION,
  type Checkin,
  type CheckinKind,
} from "./checkin.js";

const READ_CONCURRENCY = 10;
/** Quantos dias para trás /checkin e /metrica ainda procuram um check-in sem resposta. */
export const ANSWER_WINDOW_DAYS = 7;

export class CheckinNotFound extends Error {
  constructor(readonly id: string) {
    super(`Check-in não encontrado: ${id}`);
    this.name = "CheckinNotFound";
  }
}

export interface CheckinListing {
  checkins: Checkin[];
  skipped: { path: string; reason: string }[];
}

/**
 * Check-ins (`checkin` diário e `metrics` semanal) sobre um VaultStore. Mesmo contrato das
 * tarefas: criar-se-não-existir no caminho calculado, resposta por set com lock otimista,
 * corpo nunca reescrito depois de criado.
 */
export class CheckinRepository {
  constructor(
    private readonly store: VaultStore,
    private readonly clock: Clock,
  ) {}

  /** Idempotente: o slot (data + tipo) é único. `body` só é usado na criação. */
  async open(input: { kind: CheckinKind; date: LocalDate; body: string }): Promise<{ checkin: Checkin; created: boolean }> {
    const { kind, date } = input;
    const path = checkinPath(date, kind);
    const now = nowIso(this.clock);
    const content = renderNote(
      { schema: CHECKIN_SCHEMA_VERSION, id: checkinId(date, kind), type: "checkin", kind, date, created: now, updated: now },
      `\n${input.body.trimEnd()}\n`,
    );

    if ((await this.store.create(path, content)) === "created") {
      return { checkin: parseCheckin(content, path), created: true };
    }
    const existing = await this.store.read(path);
    if (!existing) throw new VaultConflict(path);
    return { checkin: parseCheckin(existing.content, path), created: false };
  }

  async find(date: LocalDate, kind: CheckinKind): Promise<Checkin | null> {
    const path = checkinPath(date, kind);
    const file = await this.store.read(path);
    return file ? parseCheckin(file.content, path) : null;
  }

  /** Check-ins com data entre `from` e `to` (inclusive), qualquer tipo, por data. */
  async listBetween(from: LocalDate, to: LocalDate): Promise<CheckinListing> {
    const paths: string[] = [];
    for (let year = Number(from.slice(0, 4)); year <= Number(to.slice(0, 4)); year++) {
      paths.push(...(await this.store.list(checkinYearDir(String(year)))));
    }
    const checkins: Checkin[] = [];
    const skipped: CheckinListing["skipped"] = [];

    for (let i = 0; i < paths.length; i += READ_CONCURRENCY) {
      const results = await Promise.all(
        paths.slice(i, i + READ_CONCURRENCY).map(async (path) => {
          const file = await this.store.read(path);
          if (!file) return null;
          try {
            return parseCheckin(file.content, path);
          } catch (err) {
            if (err instanceof VaultInvalidNote) {
              skipped.push({ path, reason: err.message });
              return null;
            }
            throw err;
          }
        }),
      );
      for (const c of results) if (c && c.date >= from && c.date <= to) checkins.push(c);
    }

    checkins.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    skipped.sort((a, b) => a.path.localeCompare(b.path));
    return { checkins, skipped };
  }

  /**
   * Para onde vai a resposta `text`: o check-in do tipo que JÁ tem esse texto (reenvio do
   * Telegram vira no-op), senão o mais recente sem resposta, ambos nos últimos ANSWER_WINDOW_DAYS dias.
   */
  async targetFor(kind: CheckinKind, today: LocalDate, text: string): Promise<Checkin | null> {
    const { checkins } = await this.listBetween(addDays(today, -ANSWER_WINDOW_DAYS), today);
    const ofKind = checkins.filter((c) => c.kind === kind);
    return (
      ofKind.find((c) => hasAnswered(c.answer, text)) ??
      ofKind.filter((c) => c.answer === undefined).at(-1) ??
      null
    );
  }

  /** Acrescenta a resposta ao check-in. Repetir o mesmo texto é no-op. */
  answer(checkin: Checkin, text: string): Promise<{ checkin: Checkin; changed: boolean }> {
    return writeAnswer(
      this.store,
      this.clock,
      checkin.path,
      text,
      (note) => checkinFromNote(note, checkin.path),
      (c) => c.answer,
      () => new CheckinNotFound(checkin.id),
    ).then(({ value, changed }) => ({ checkin: value, changed }));
  }
}

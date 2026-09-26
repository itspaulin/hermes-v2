import { isoWeekLabel, nowIso, addDays, type Clock, type LocalDate } from "../time/index.js";
import { VaultConflict } from "../vault/errors.js";
import { renderNote } from "../vault/frontmatter.js";
import type { VaultStore } from "../vault/store.js";
import { hasAnswered, writeAnswer } from "./answer.js";
import { parseReview, reviewFromNote, reviewPath, REVIEW_SCHEMA_VERSION, type Review } from "./review.js";

export class ReviewNotFound extends Error {
  constructor(readonly id: string) {
    super(`Revisão não encontrada: ${id}`);
    this.name = "ReviewNotFound";
  }
}

/** Revisões semanais sobre um VaultStore. Mesmo contrato dos check-ins. */
export class ReviewRepository {
  constructor(
    private readonly store: VaultStore,
    private readonly clock: Clock,
  ) {}

  /** Idempotente: uma revisão por semana ISO. `body` só é usado na criação. */
  async open(input: { weekStart: LocalDate; body: string }): Promise<{ review: Review; created: boolean }> {
    const id = isoWeekLabel(input.weekStart);
    const path = reviewPath(id);
    const now = nowIso(this.clock);
    const content = renderNote(
      { schema: REVIEW_SCHEMA_VERSION, id, type: "revisao", week: id, week_start: input.weekStart, created: now, updated: now },
      `\n${input.body.trimEnd()}\n`,
    );

    if ((await this.store.create(path, content)) === "created") {
      return { review: parseReview(content, path), created: true };
    }
    const existing = await this.store.read(path);
    if (!existing) throw new VaultConflict(path);
    return { review: parseReview(existing.content, path), created: false };
  }

  async find(id: string): Promise<Review | null> {
    const path = reviewPath(id);
    const file = await this.store.read(path);
    return file ? parseReview(file.content, path) : null;
  }

  /**
   * Para onde vai a resposta `text`, entre a revisão desta semana e a da anterior: a que JÁ tem
   * esse texto (reenvio do Telegram vira no-op), senão a mais recente sem resposta.
   */
  async targetFor(today: LocalDate, text: string): Promise<Review | null> {
    const found = await Promise.all([today, addDays(today, -7)].map((d) => this.find(isoWeekLabel(d))));
    const reviews = found.filter((r): r is Review => r !== null);
    return reviews.find((r) => hasAnswered(r.answer, text)) ?? reviews.find((r) => r.answer === undefined) ?? null;
  }

  answer(review: Review, text: string): Promise<{ review: Review; changed: boolean }> {
    return writeAnswer(
      this.store,
      this.clock,
      review.path,
      text,
      (note) => reviewFromNote(note, review.path),
      (r) => r.answer,
      () => new ReviewNotFound(review.id),
    ).then(({ value, changed }) => ({ review: value, changed }));
  }
}

import { nowIso, type Clock } from "../time/index.js";
import { VaultConflict } from "../vault/errors.js";
import { parseNote, serializeNote, setScalar, type Note } from "../vault/frontmatter.js";
import type { VaultStore } from "../vault/store.js";

export const MAX_ANSWER_LENGTH = 1000;
const MAX_ATTEMPTS = 3;
export const ANSWER_SEPARATOR = " | ";

/** Entrada inválida do usuário numa resposta (vazia, longa demais). Não é falha de infraestrutura. */
export class AnswerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnswerValidationError";
  }
}

/** Uma linha só: o frontmatter do Hermes é sempre escalar de uma linha (contrato, seção 5). */
export function normalizeAnswer(raw: string): string {
  const text = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (text === "") throw new AnswerValidationError("A resposta está vazia.");
  if (text.length > MAX_ANSWER_LENGTH) {
    throw new AnswerValidationError(`Resposta longa demais (máximo ${MAX_ANSWER_LENGTH} caracteres).`);
  }
  return text;
}

/**
 * Registra a resposta num campo `answer` do frontmatter (o corpo continua do usuário).
 * Uma segunda resposta diferente é ACRESCENTADA (" | "), nunca substitui; repetir o mesmo
 * texto é no-op. Lock otimista com releitura, sem nunca forçar a escrita.
 */
export async function writeAnswer<T>(
  store: VaultStore,
  clock: Clock,
  path: string,
  rawText: string,
  parse: (note: Note) => T,
  answerOf: (value: T) => string | undefined,
  onMissing: () => Error,
): Promise<{ value: T; changed: boolean }> {
  const text = normalizeAnswer(rawText);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const file = await store.read(path);
    if (!file) throw onMissing();

    const note = parseNote(file.content, path);
    const current = parse(note);
    const previous = answerOf(current);
    if (previous !== undefined && previous.split(ANSWER_SEPARATOR).includes(text)) return { value: current, changed: false };

    const now = nowIso(clock);
    setScalar(note, "answer", previous === undefined ? text : `${previous}${ANSWER_SEPARATOR}${text}`);
    if (note.data.answered_at === undefined) setScalar(note, "answered_at", now);
    setScalar(note, "updated", now);
    const next = serializeNote(note);

    if ((await store.update(path, file.sha, next)) === "ok") {
      return { value: parse(parseNote(next, path)), changed: true };
    }
  }
  throw new VaultConflict(path);
}

/** Esse texto (normalizado) já foi registrado como resposta? Torna o reenvio do Telegram um no-op. */
export function hasAnswered(answer: string | undefined, rawText: string): boolean {
  return answer !== undefined && answer.split(ANSWER_SEPARATOR).includes(normalizeAnswer(rawText));
}

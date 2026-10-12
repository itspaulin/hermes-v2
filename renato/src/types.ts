export const CATEGORIES = ["ideia", "estudo", "trabalho", "projeto", "referencia"] as const;
export type Category = (typeof CATEGORIES)[number];

export const MESSAGE_SOURCES = ["telegram", "manual"] as const;
export type MessageSourceKind = (typeof MESSAGE_SOURCES)[number];

export interface MessageSource {
  kind: MessageSourceKind;
  /** Identificador da mensagem na origem (ex.: message_id do Telegram). */
  messageId?: string;
}

export interface Note {
  id: string;
  /** Texto exatamente como recebido; nunca é alterado. */
  originalContent: string;
  /** Texto organizado/resumo; opcional. */
  organizedContent?: string;
  /** null = sem categoria confirmada. */
  category: Category | null;
  tags: string[];
  project?: string;
  /** Instantes UTC em ISO 8601. */
  createdAt: string;
  updatedAt: string;
  source: MessageSource;
}

export function isCategory(value: unknown): value is Category {
  return typeof value === "string" && (CATEGORIES as readonly string[]).includes(value);
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function validInstant(value: unknown): value is string {
  return typeof value === "string" && ISO_UTC.test(value) && !Number.isNaN(Date.parse(value));
}

/** Retorna a lista de problemas encontrados; vazia se a nota é válida. */
export function validateNote(note: Note): string[] {
  const errors: string[] = [];
  if (typeof note.id !== "string" || note.id.trim() === "") errors.push("id vazio");
  if (typeof note.originalContent !== "string" || note.originalContent.trim() === "") {
    errors.push("originalContent vazio");
  }
  if (note.category !== null && !isCategory(note.category)) errors.push("categoria inválida");
  if (!Array.isArray(note.tags) || note.tags.some((t) => typeof t !== "string" || t === "")) {
    errors.push("tags inválidas");
  }
  if (note.project !== undefined && note.project.trim() === "") errors.push("project vazio");
  if (!validInstant(note.createdAt)) errors.push("createdAt inválido");
  if (!validInstant(note.updatedAt)) errors.push("updatedAt inválido");
  if (validInstant(note.createdAt) && validInstant(note.updatedAt) && note.updatedAt < note.createdAt) {
    errors.push("updatedAt anterior a createdAt");
  }
  if (!note.source || !(MESSAGE_SOURCES as readonly string[]).includes(note.source.kind)) {
    errors.push("source inválida");
  }
  return errors;
}

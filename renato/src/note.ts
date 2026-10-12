import { classify } from "./classify.js";
import { type Clock, utcIso } from "./clock.js";
import { type MessageSource, type Note, validateNote } from "./types.js";

export interface CaptureInput {
  id: string;
  content: string;
  source: MessageSource;
}

/** Cria uma nota a partir de texto bruto. O texto original é guardado intacto. */
export function captureNote(input: CaptureInput, clock: Clock): Note {
  const c = classify(input.content);
  const now = utcIso(clock.now());
  const note: Note = {
    id: input.id,
    originalContent: input.content,
    category: c.category,
    tags: c.tags,
    createdAt: now,
    updatedAt: now,
    source: input.source,
  };
  if (c.organizedContent !== "" && c.organizedContent !== input.content) {
    note.organizedContent = c.organizedContent;
  }
  if (c.project) note.project = c.project;

  const errors = validateNote(note);
  if (errors.length > 0) throw new Error(`Nota inválida: ${errors.join("; ")}`);
  return note;
}

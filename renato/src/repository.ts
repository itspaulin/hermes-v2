import { NoteFormatError, parseNote, serializeNote } from "./markdown.js";
import type { Note } from "./types.js";

/** Persistência abstrata de notas. Implementações não devem perder dados em silêncio. */
export interface NoteRepository {
  /** Falha se já existir nota com o mesmo id. */
  create(note: Note): Promise<void>;
  /** Falha se a nota não existir. */
  update(note: Note): Promise<void>;
  /** null se não existir; lança se o conteúdo armazenado for inválido. */
  get(id: string): Promise<Note | null>;
  /** Ordenado por createdAt e id. Lança se alguma nota armazenada for inválida. */
  list(): Promise<Note[]>;
}

export class NoteRepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoteRepositoryError";
  }
}

/** Implementação em memória para testes; guarda o Markdown serializado, não o objeto. */
export class InMemoryNoteRepository implements NoteRepository {
  private readonly files = new Map<string, string>();

  /** `initial` mapeia id → Markdown bruto (útil para simular arquivos corrompidos). */
  constructor(initial: Record<string, string> = {}) {
    for (const [id, md] of Object.entries(initial)) this.files.set(id, md);
  }

  async create(note: Note): Promise<void> {
    const md = serializeNote(note);
    if (this.files.has(note.id)) throw new NoteRepositoryError(`Nota já existe: ${note.id}`);
    this.files.set(note.id, md);
  }

  async update(note: Note): Promise<void> {
    const md = serializeNote(note);
    if (!this.files.has(note.id)) throw new NoteRepositoryError(`Nota não encontrada: ${note.id}`);
    this.files.set(note.id, md);
  }

  async get(id: string): Promise<Note | null> {
    const md = this.files.get(id);
    return md === undefined ? null : this.read(id, md);
  }

  async list(): Promise<Note[]> {
    const notes = [...this.files].map(([id, md]) => this.read(id, md));
    return notes.sort((a, b) =>
      a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1,
    );
  }

  private read(id: string, md: string): Note {
    try {
      const note = parseNote(md);
      if (note.id !== id) throw new NoteFormatError(`id "${note.id}" difere da chave "${id}"`);
      return note;
    } catch (e) {
      if (e instanceof NoteFormatError) throw new NoteRepositoryError(`Nota "${id}" inválida: ${e.message}`);
      throw e;
    }
  }
}

import { type Category, type MessageSourceKind, type Note, validateNote } from "./types.js";

/** Erro explícito de serialização/parsing de nota. Nunca descarta dados em silêncio. */
export class NoteFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoteFormatError";
  }
}

const ORIGINAL_HEADING = "## Conteúdo original";
const ORGANIZED_HEADING = "## Conteúdo organizado";
const FRONTMATTER_END = "\n---\n\n";
const KEYS: readonly string[] = [
  "id",
  "category",
  "tags",
  "project",
  "source",
  "sourceMessageId",
  "createdAt",
  "updatedAt",
];
const REQUIRED = ["id", "category", "tags", "source", "createdAt", "updatedAt"] as const;

function fenceFor(content: string): string {
  let longest = 0;
  for (const run of content.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return "`".repeat(Math.max(3, longest + 1));
}

function block(heading: string, content: string): string {
  const fence = fenceFor(content);
  return `${heading}\n\n${fence}\n${content}\n${fence}\n`;
}

/**
 * Serializa uma nota em Markdown determinístico.
 *
 * Metadados vão no frontmatter (valores em JSON, que é YAML válido); os conteúdos vão em blocos
 * cercados cuja cerca é maior que qualquer sequência de crases do texto, preservando-o byte a byte
 * (exceto por conversão externa de fim de linha, que o formato não protege).
 */
export function serializeNote(note: Note): string {
  const errors = validateNote(note);
  if (note.organizedContent !== undefined && note.organizedContent === "") {
    errors.push("organizedContent vazio");
  }
  if (errors.length > 0) throw new NoteFormatError(`Nota inválida: ${errors.join("; ")}`);

  const meta: [string, unknown][] = [
    ["id", note.id],
    ["category", note.category],
    ["tags", note.tags],
  ];
  if (note.project !== undefined) meta.push(["project", note.project]);
  meta.push(["source", note.source.kind]);
  if (note.source.messageId !== undefined) meta.push(["sourceMessageId", note.source.messageId]);
  meta.push(["createdAt", note.createdAt], ["updatedAt", note.updatedAt]);

  let out = "---\n";
  for (const [k, v] of meta) out += `${k}: ${JSON.stringify(v)}\n`;
  out += "---\n\n" + block(ORIGINAL_HEADING, note.originalContent);
  if (note.organizedContent !== undefined) out += "\n" + block(ORGANIZED_HEADING, note.organizedContent);
  return out;
}

function readBlock(text: string, pos: number, heading: string): { content: string; next: number } {
  const head = `${heading}\n\n`;
  if (!text.startsWith(head, pos)) {
    throw new NoteFormatError(`Esperado "${heading}" seguido de linha em branco na posição ${pos}`);
  }
  const open = /^`{3,}\n/.exec(text.slice(pos + head.length));
  if (!open) throw new NoteFormatError(`Bloco de "${heading}" sem cerca de abertura`);
  const fence = open[0].slice(0, -1);
  const start = pos + head.length + open[0].length;
  const close = text.indexOf(`\n${fence}`, start);
  if (close === -1) throw new NoteFormatError(`Bloco de "${heading}" sem cerca de fechamento`);
  const after = close + 1 + fence.length;
  if (after < text.length && text[after] !== "\n") {
    throw new NoteFormatError(`Cerca de fechamento malformada em "${heading}"`);
  }
  return { content: text.slice(start, close), next: after + 1 };
}

function parseMeta(raw: string): Map<string, unknown> {
  const map = new Map<string, unknown>();
  for (const line of raw.split("\n")) {
    const m = /^([A-Za-z]+): (.*)$/.exec(line);
    if (!m) throw new NoteFormatError(`Linha de metadado inválida: ${JSON.stringify(line)}`);
    const key = m[1]!;
    if (!KEYS.includes(key)) throw new NoteFormatError(`Metadado desconhecido: ${key}`);
    if (map.has(key)) throw new NoteFormatError(`Metadado duplicado: ${key}`);
    try {
      map.set(key, JSON.parse(m[2]!));
    } catch {
      throw new NoteFormatError(`Valor de "${key}" não é JSON válido: ${m[2]}`);
    }
  }
  for (const key of REQUIRED) {
    if (!map.has(key)) throw new NoteFormatError(`Metadado obrigatório ausente: ${key}`);
  }
  return map;
}

/** Lê Markdown produzido por `serializeNote`. Lança `NoteFormatError` com a causa exata se inválido. */
export function parseNote(markdown: string): Note {
  if (!markdown.startsWith("---\n")) {
    throw new NoteFormatError('Frontmatter ausente: o arquivo deve começar com "---"');
  }
  const end = markdown.indexOf(FRONTMATTER_END, 3);
  if (end === -1) throw new NoteFormatError('Frontmatter sem fechamento "---" seguido de linha em branco');
  const meta = parseMeta(markdown.slice(4, end));

  const original = readBlock(markdown, end + FRONTMATTER_END.length, ORIGINAL_HEADING);
  let organized: string | undefined;
  let pos = original.next;
  if (pos < markdown.length) {
    if (markdown[pos] !== "\n") throw new NoteFormatError("Conteúdo inesperado após o conteúdo original");
    const b = readBlock(markdown, pos + 1, ORGANIZED_HEADING);
    organized = b.content;
    pos = b.next;
    if (pos < markdown.length) throw new NoteFormatError("Conteúdo inesperado após o conteúdo organizado");
  }

  const str = (k: string): string => {
    const v = meta.get(k);
    if (typeof v !== "string") throw new NoteFormatError(`Metadado "${k}" deve ser texto`);
    return v;
  };
  const tags = meta.get("tags");
  if (!Array.isArray(tags) || tags.some((t) => typeof t !== "string")) {
    throw new NoteFormatError('Metadado "tags" deve ser lista de textos');
  }
  const category = meta.get("category");
  if (category !== null && typeof category !== "string") {
    throw new NoteFormatError('Metadado "category" deve ser texto ou null');
  }

  const note: Note = {
    id: str("id"),
    originalContent: original.content,
    category: category as Category | null,
    tags: tags as string[],
    createdAt: str("createdAt"),
    updatedAt: str("updatedAt"),
    source: { kind: str("source") as MessageSourceKind },
  };
  if (meta.has("sourceMessageId")) note.source.messageId = str("sourceMessageId");
  if (meta.has("project")) note.project = str("project");
  if (organized !== undefined) {
    if (organized === "") throw new NoteFormatError("Conteúdo organizado presente mas vazio");
    note.organizedContent = organized;
  }

  const errors = validateNote(note);
  if (errors.length > 0) throw new NoteFormatError(`Nota inválida: ${errors.join("; ")}`);
  return note;
}

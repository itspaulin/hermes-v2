import { type Category, isCategory } from "./types.js";

export interface Classification {
  /** null = ambíguo ou sem marcador explícito; não confirmado. */
  category: Category | null;
  tags: string[];
  project?: string;
  /** Texto sem o prefixo de categoria e com espaços normalizados. */
  organizedContent: string;
}

const PREFIX = /^\s*([\p{L}]+)\s*:\s*/u;
const HASHTAG = /(?:^|\s)#([\p{L}\p{N}_-]+)/gu;
const PROJECT = /(?:^|\s)@([\p{L}\p{N}_-]+)/gu;

function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Regras explícitas (sem inferência semântica):
 * - categoria só é confirmada por prefixo "categoria:" ou hashtag #categoria;
 * - marcadores conflitantes => categoria null;
 * - #hashtags viram tags (exceto hashtags de categoria);
 * - "@nome" define o projeto; mais de um @ distinto => sem projeto.
 */
export function classify(content: string): Classification {
  const markers = new Set<Category>();

  let body = content;
  const prefix = PREFIX.exec(content);
  const word = prefix?.[1] ? fold(prefix[1]) : "";
  if (prefix && isCategory(word)) {
    markers.add(word);
    body = content.slice(prefix[0].length);
  }

  const tags: string[] = [];
  for (const m of body.matchAll(HASHTAG)) {
    const tag = fold(m[1] ?? "");
    if (isCategory(tag)) markers.add(tag);
    else if (tag && !tags.includes(tag)) tags.push(tag);
  }

  const projects = new Set<string>();
  for (const m of body.matchAll(PROJECT)) {
    const name = fold(m[1] ?? "");
    if (name) projects.add(name);
  }

  const [only] = markers;
  const result: Classification = {
    category: markers.size === 1 && only ? only : null,
    tags,
    organizedContent: normalizeWhitespace(body),
  };
  const [project] = projects;
  if (projects.size === 1 && project) result.project = project;
  return result;
}

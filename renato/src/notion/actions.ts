import type { InputValidator } from "../../../shared/ai/decision.js";
import type { NoteContent } from "./blocks.js";
import { normalizeDiagram, normalizeMindMap } from "./diagram.js";
import { TIPOS, type Tipo } from "./notas.js";

/**
 * Ações que o modelo pode PEDIR no modo Notion. O código as executa e confirma pelo resultado real.
 * Escolha de tema: `existente` (ID de um tema da lista), `novo` (nome; `pai` opcional, ID de um tema da
 * lista) ou ausente (Caixa de entrada).
 */
export type TemaChoice = { existente: string } | { novo: string; pai?: string } | null;

export type RenatoNotionActions = {
  save_note: { titulo: string; resumo: string; tipo: Tipo; tema: TemaChoice; conteudo: NoteContent };
  append_to_note: { id: string; conteudo: NoteContent };
  /** Sem texto nem tema: as notas mais recentes (até `limite`, 10 por padrão). */
  find_notes: { texto?: string; tema?: string; limite?: number };
  move_note: { id: string; tema: NonNullable<TemaChoice> };
  create_tema: { nome: string; pai?: string };
  /** Arquiva o tema (lixeira do Notion). Com notas ou subtemas, só com `confirmar`. */
  delete_tema: { tema: string; confirmar: boolean };
  delete_note: { id: string };
  /** Desfaz a última ação do Renato que mudou o Notion. */
  undo: Record<string, never>;
};

export const MAX_TITLE = 120;
export const MAX_SUMMARY = 300;
const MAX_TOPICS = 12;
const MAX_POINTS = 10;
const MAX_CONCEPTS = 15;
const MAX_GAPS = 8;
const MAX_TRANSCRIPT = 8000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Texto de uma linha: sem controle, espaços colapsados, vazio = null, longo demais = cortado. */
export function line(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return s === "" ? null : s.slice(0, max);
}

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * Conteúdo da nota. Tolerante: itens inválidos são descartados (a nota não falha por um ponto torto).
 * Só estruturas que não são objeto, ou ausência de qualquer conteúdo, recusam a ação.
 */
export function contentInput(raw: unknown): NoteContent | null {
  if (!isRecord(raw)) return null;
  const topicos: NoteContent["topicos"] = [];
  for (const t of list(raw.topicos)) {
    if (!isRecord(t) || topicos.length >= MAX_TOPICS) continue;
    const titulo = line(t.titulo, MAX_TITLE);
    if (titulo === null) continue;
    const pontos = list(t.pontos).map((p) => line(p, 300)).filter((p): p is string => p !== null).slice(0, MAX_POINTS);
    topicos.push({ titulo, pontos });
  }
  const conceitos: NoteContent["conceitos"] = [];
  for (const c of list(raw.conceitos)) {
    if (!isRecord(c) || conceitos.length >= MAX_CONCEPTS) continue;
    const termo = line(c.termo, 60);
    const definicao = line(c.definicao, 300);
    if (termo !== null && definicao !== null) conceitos.push({ termo, definicao });
  }
  const lacunas = list(raw.lacunas).map((l) => line(l, 200)).filter((l): l is string => l !== null).slice(0, MAX_GAPS);
  const diagrama = normalizeDiagram(raw.diagrama);
  const mapaMental = normalizeMindMap(raw.mapaMental);
  const transcricao = typeof raw.transcricao === "string" && raw.transcricao.trim() !== "" ? raw.transcricao.slice(0, MAX_TRANSCRIPT) : undefined;

  if (topicos.length === 0 && conceitos.length === 0 && !diagrama && !mapaMental) return null;
  return { topicos, conceitos, lacunas, ...(diagrama && { diagrama }), ...(mapaMental && { mapaMental }), ...(transcricao !== undefined && { transcricao }) };
}

function temaChoice(raw: unknown): TemaChoice | undefined {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) return undefined;
  const existente = line(raw.existente, 100);
  if (existente !== null) return { existente };
  const novo = line(raw.novo, 100);
  if (novo === null) return undefined;
  const pai = line(raw.pai, 100);
  return { novo, ...(pai !== null && { pai }) };
}

export const saveNoteInput: InputValidator<RenatoNotionActions["save_note"]> = (raw) => {
  if (!isRecord(raw)) return null;
  const titulo = line(raw.titulo, MAX_TITLE);
  const resumo = line(raw.resumo, MAX_SUMMARY);
  const conteudo = contentInput(raw.conteudo);
  const tema = temaChoice(raw.tema);
  const tipo = (TIPOS as readonly unknown[]).includes(raw.tipo) ? (raw.tipo as Tipo) : "resumo";
  if (titulo === null || resumo === null || conteudo === null || tema === undefined) return null;
  return { titulo, resumo, tipo, tema, conteudo };
};

export const appendToNoteInput: InputValidator<RenatoNotionActions["append_to_note"]> = (raw) => {
  if (!isRecord(raw)) return null;
  const id = line(raw.id, 100);
  const conteudo = contentInput(raw.conteudo);
  return id === null || conteudo === null ? null : { id, conteudo };
};

export const findNotesInput: InputValidator<RenatoNotionActions["find_notes"]> = (raw) => {
  if (raw !== undefined && raw !== null && !isRecord(raw)) return null;
  const r = isRecord(raw) ? raw : {};
  const texto = line(r.texto, 100);
  const tema = line(r.tema, 100);
  const limite = typeof r.limite === "number" && Number.isInteger(r.limite) && r.limite >= 1 ? Math.min(r.limite, 20) : undefined;
  return { ...(texto !== null && { texto }), ...(tema !== null && { tema }), ...(limite !== undefined && { limite }) };
};

export const moveNoteInput: InputValidator<RenatoNotionActions["move_note"]> = (raw) => {
  if (!isRecord(raw)) return null;
  const id = line(raw.id, 100);
  const tema = temaChoice(raw.tema);
  return id === null || tema === undefined || tema === null ? null : { id, tema };
};

export const createTemaInput: InputValidator<RenatoNotionActions["create_tema"]> = (raw) => {
  if (!isRecord(raw)) return null;
  const nome = line(raw.nome, 100);
  const pai = line(raw.pai, 100);
  return nome === null ? null : { nome, ...(pai !== null && { pai }) };
};

export const deleteTemaInput: InputValidator<RenatoNotionActions["delete_tema"]> = (raw) => {
  if (!isRecord(raw)) return null;
  const tema = line(raw.tema, 100);
  return tema === null ? null : { tema, confirmar: raw.confirmar === true };
};

export const deleteNoteInput: InputValidator<RenatoNotionActions["delete_note"]> = (raw) => {
  if (!isRecord(raw)) return null;
  const id = line(raw.id, 100);
  return id === null ? null : { id };
};

export const undoInput: InputValidator<RenatoNotionActions["undo"]> = () => ({});

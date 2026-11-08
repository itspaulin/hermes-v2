import { richText } from "../../../shared/notion/props.js";

/** Bloco do Notion (formato da API). Só os tipos que o Renato escreve. */
export type Block = Record<string, unknown>;

/** Conteúdo organizado de uma nota. Tudo vem do texto/imagem do usuário, exceto `lacunas` (sugestões do modelo). */
export interface NoteContent {
  topicos: { titulo: string; pontos: string[] }[];
  conceitos: { termo: string; definicao: string }[];
  /** Código Mermaid de um diagrama de arquitetura/fluxo. */
  diagrama?: string;
  /** Código Mermaid (mindmap) ou null para usar só a lista de tópicos. */
  mapaMental?: string;
  /** Perguntas e pontos em aberto sugeridos pelo modelo. Aparecem separados do conteúdo do usuário. */
  lacunas: string[];
  /** Texto exato do usuário (ou transcrição da imagem). */
  transcricao?: string;
}

export const MAX_BLOCKS_PER_REQUEST = 100;

export const heading = (level: 2 | 3, content: string): Block => ({
  type: `heading_${level}`,
  [`heading_${level}`]: { rich_text: richText(content) },
});
export const paragraph = (content: string): Block => ({ type: "paragraph", paragraph: { rich_text: richText(content) } });
export const bullet = (content: string, children: Block[] = []): Block => ({
  type: "bulleted_list_item",
  bulleted_list_item: { rich_text: richText(content), ...(children.length > 0 && { children }) },
});
export const toggle = (title: string, children: Block[]): Block => ({
  type: "toggle",
  toggle: { rich_text: richText(title), children },
});
export const mermaid = (code: string): Block => ({ type: "code", code: { language: "mermaid", rich_text: richText(code) } });

/** A transcrição vira um parágrafo por linha, dentro de um toggle fechado. */
const transcript = (raw: string): Block =>
  toggle("Transcrição original", raw.split(/\r?\n/).map((l) => paragraph(l === "" ? " " : l)).slice(0, MAX_BLOCKS_PER_REQUEST - 1));

/** Seções, na ordem fixa combinada: tópicos, conceitos, diagrama, mapa mental, lacunas, transcrição. */
function sections(c: NoteContent): Block[] {
  const out: Block[] = [];
  if (c.topicos.length > 0) {
    out.push(heading(2, "O que entendi"));
    for (const t of c.topicos) out.push(bullet(t.titulo, t.pontos.map((p) => bullet(p))));
  }
  if (c.conceitos.length > 0) {
    out.push(heading(2, "Conceitos-chave"));
    for (const k of c.conceitos) out.push(bullet(`${k.termo}: ${k.definicao}`));
  }
  if (c.diagrama) out.push(heading(2, "Diagrama"), mermaid(c.diagrama));
  if (c.mapaMental) out.push(heading(2, "Mapa mental"), mermaid(c.mapaMental));
  if (c.lacunas.length > 0) {
    out.push(heading(2, "Lacunas e perguntas (sugestões do Renato)"));
    for (const l of c.lacunas) out.push(bullet(l));
  }
  if (c.transcricao) out.push(transcript(c.transcricao));
  return out;
}

/** Corpo de uma nota nova. O resumo vai antes das seções. */
export function noteBlocks(summary: string, c: NoteContent): Block[] {
  return [...(summary.trim() === "" ? [] : [paragraph(summary)]), ...sections(c)];
}

/** Seção acrescentada ao fim de uma nota existente. `dateLabel` ex.: "08/11/2026". Nada do que já existe é tocado. */
export function complementBlocks(dateLabel: string, c: NoteContent): Block[] {
  return [heading(2, `Complemento, ${dateLabel}`), ...sections(c)];
}

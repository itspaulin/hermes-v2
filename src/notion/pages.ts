import { localDateOfInstant, parseLocalDate, type LocalDate } from "../time/index.js";
import type { NotionClient } from "./client.js";

/**
 * Leitura e escrita das propriedades dos bancos Tarefas e Metas. Os nomes são o contrato com o Notion
 * (docs/notion-contract.md): `Nome` (title), `ID` (text), `Status` (select), `Prazo`, `Criada`, `Feita em`
 * (date) e `Meta` (relation). Linhas criadas à mão no Notion (sem ID, Criada ou Status) são aceitas.
 */
export interface NotionPage {
  id: string;
  created_time: string;
  last_edited_time: string;
  properties: Record<string, any>;
}

export const PROP = {
  title: "Nome",
  id: "ID",
  status: "Status",
  due: "Prazo",
  created: "Criada",
  doneAt: "Feita em",
  meta: "Meta",
} as const;

export const text = (prop: any): string => ((prop?.title ?? prop?.rich_text ?? []) as { plain_text?: string }[]).map((t) => t.plain_text ?? "").join("");
export const selectName = (prop: any): string | undefined => prop?.select?.name ?? undefined;
export const dateStart = (prop: any): string | undefined => prop?.date?.start ?? undefined;
export const relationIds = (prop: any): string[] => ((prop?.relation ?? []) as { id: string }[]).map((r) => r.id);

/** O Notion devolve milissegundos ("...:00.000-03:00"); o Hermes grava instantes sem eles. */
export const normalizeInstant = (iso: string): string => iso.replace(/\.\d+(?=Z|[+-]\d{2}:\d{2}$)/, "");

/** Instante de uma propriedade de data: só vale se tiver horário e offset; senão devolve o `fallback`. */
export function instantOf(prop: any, fallback?: string): string | undefined {
  const start = dateStart(prop);
  return start !== undefined && /T.*(Z|[+-]\d{2}:\d{2})$/.test(start) ? normalizeInstant(start) : fallback === undefined ? undefined : normalizeInstant(fallback);
}

/** Data de uma propriedade de data. Com horário, a data civil em America/Sao_Paulo. Lança se inválida. */
export function localDateOf(prop: any): LocalDate | undefined {
  const start = dateStart(prop);
  if (start === undefined) return undefined;
  return start.length <= 10 ? parseLocalDate(start) : localDateOfInstant(normalizeInstant(start));
}

export const titleProp = (value: string) => ({ title: [{ type: "text", text: { content: value } }] });
export const textProp = (value: string) => ({ rich_text: [{ type: "text", text: { content: value } }] });
export const selectProp = (name: string) => ({ select: { name } });
export const dateProp = (start: string | null) => ({ date: start === null ? null : { start } });
export const relationProp = (pageIds: string[]) => ({ relation: pageIds.map((id) => ({ id })) });

/** Todas as páginas de um banco (segue a paginação). Sempre da mais antiga para a mais nova. */
export async function queryAll(client: NotionClient, databaseId: string, filter?: unknown): Promise<NotionPage[]> {
  const pages: NotionPage[] = [];
  let cursor: string | undefined;
  do {
    const res = await client.request("POST", `/v1/databases/${databaseId}/query`, {
      page_size: 100,
      sorts: [{ timestamp: "created_time", direction: "ascending" }],
      ...(filter !== undefined && { filter }),
      ...(cursor !== undefined && { start_cursor: cursor }),
    });
    pages.push(...(res.results as NotionPage[]));
    cursor = res.has_more ? (res.next_cursor as string) : undefined;
  } while (cursor !== undefined);
  return pages;
}

export const byIdProperty = (id: string) => ({ property: PROP.id, rich_text: { equals: id } });
export const withoutId = { property: PROP.id, rich_text: { is_empty: true } };

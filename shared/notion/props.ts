import type { NotionClient } from "./client.js";

/**
 * Leitura e escrita genéricas de propriedades do Notion (sem conhecer nenhum banco do Hermes ou do Renato).
 * Cada assistente define os nomes das suas propriedades no próprio código.
 */
export interface NotionPage {
  id: string;
  url?: string;
  created_time: string;
  last_edited_time: string;
  properties: Record<string, any>;
}

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

/** O Notion limita cada trecho de texto a 2000 caracteres: textos longos viram vários trechos. */
const chunks = (value: string): string[] => (value.length === 0 ? [""] : (value.match(/[\s\S]{1,2000}/g) as string[]));
export const richText = (value: string) => chunks(value).map((content) => ({ type: "text", text: { content } }));

export const titleProp = (value: string) => ({ title: richText(value) });
export const textProp = (value: string) => ({ rich_text: richText(value) });
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

export const byIdProperty = (id: string) => ({ property: "ID", rich_text: { equals: id } });
export const withoutId = { property: "ID", rich_text: { is_empty: true } };

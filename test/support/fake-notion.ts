import type { NotionClient } from "../../shared/notion/client.js";
import { NotionApiError } from "../../shared/notion/errors.js";

/**
 * Notion falso em memória: só o que o Hermes usa. POST /v1/databases/:id/query (filtros select
 * equals/is_empty, rich_text equals/is_empty e `or`; ordem de criação; paginação), POST /v1/pages
 * e PATCH /v1/pages/:id (substitui só as propriedades enviadas).
 */
export interface FakePage {
  id: string;
  created_time: string;
  last_edited_time: string;
  properties: Record<string, any>;
  database: string;
  url?: string;
  /** Blocos do corpo da página (create com `children` e PATCH /blocks/:id/children). */
  children?: any[];
}

export class FakeNotion implements NotionClient {
  pages: FakePage[] = [];
  uploads: { id: string; filename: string; contentType: string; bytes: Uint8Array }[] = [];
  calls: { method: string; path: string; body?: any }[] = [];
  pageSize = 100;
  /** Falha a próxima chamada que combine com o teste. */
  failWith?: (method: string, path: string) => Error | undefined;
  private n = 0;
  private time = Date.parse("2026-11-07T21:00:00Z");

  async request(method: string, path: string, body?: any): Promise<any> {
    this.calls.push({ method, path, body });
    const err = this.failWith?.(method, path);
    if (err) throw err;

    const query = /^\/v1\/databases\/([^/]+)\/query$/.exec(path);
    if (method === "POST" && query) return this.query(query[1]!, body);
    if (method === "POST" && path === "/v1/pages") {
      const page: FakePage = {
        id: `page-${++this.n}`,
        database: body.parent.database_id,
        created_time: this.stamp(),
        last_edited_time: this.stamp(),
        properties: normalize(body.properties),
        children: body.children ?? [],
      };
      page.url = `https://www.notion.so/${page.id}`;
      this.pages.push(page);
      return out(page);
    }
    const getPage = /^\/v1\/pages\/([^/]+)$/.exec(path);
    if (method === "GET" && getPage) {
      const page = this.pages.find((p) => p.id === getPage[1]);
      if (!page) throw Object.assign(new NotionApiError(404, "object_not_found", "x"));
      return { ...out(page), parent: { database_id: page.database } };
    }
    const blocks = /^\/v1\/blocks\/([^/]+)\/children$/.exec(path);
    if (method === "PATCH" && blocks) {
      const page = this.pages.find((p) => p.id === blocks[1]);
      if (!page) throw Object.assign(new Error("not found"), { name: "NotionApiError" });
      if (body.children.length > 100) throw new Error("mais de 100 blocos por requisição");
      (page.children ??= []).push(...body.children);
      return { results: [] };
    }
    const patch = /^\/v1\/pages\/([^/]+)$/.exec(path);
    if (method === "PATCH" && patch) {
      const page = this.pages.find((p) => p.id === patch[1]);
      if (!page) throw Object.assign(new Error("not found"), { name: "NotionApiError" });
      page.properties = { ...page.properties, ...normalize(body.properties) };
      page.last_edited_time = this.stamp();
      return out(page);
    }
    throw new Error(`rota não suportada no fake: ${method} ${path}`);
  }

  async upload(filename: string, contentType: string, bytes: Uint8Array): Promise<string> {
    this.calls.push({ method: "UPLOAD", path: filename });
    const err = this.failWith?.("UPLOAD", filename);
    if (err) throw err;
    const id = `upload-${++this.n}`;
    this.uploads.push({ id, filename, contentType, bytes });
    return id;
  }

  /** Adiciona uma linha como se tivesse sido criada à mão no Notion. */
  addManual(database: string, properties: Record<string, any>): FakePage {
    const page: FakePage = { id: `page-${++this.n}`, database, created_time: this.stamp(), last_edited_time: this.stamp(), properties: normalize(properties) };
    this.pages.push(page);
    return page;
  }

  private stamp(): string {
    this.time += 60_000;
    return new Date(this.time).toISOString();
  }

  private query(db: string, body: any) {
    if ((body.page_size ?? 100) > 100) throw new Error("page_size acima de 100");
    const all = this.pages.filter((p) => p.database === db && matches(p, body.filter));
    const sort = body.sorts?.[0];
    if (sort?.direction === "descending") {
      const key = sort.timestamp === "last_edited_time" ? "last_edited_time" : "created_time";
      all.sort((a, b) => (a[key] < b[key] ? 1 : a[key] > b[key] ? -1 : 0));
    }
    const start = body.start_cursor ? Number(body.start_cursor) : 0;
    const slice = all.slice(start, start + (body.page_size ?? this.pageSize));
    const next = start + slice.length;
    return { results: slice.map(out), has_more: next < all.length, next_cursor: next < all.length ? String(next) : null };
  }
}

const out = ({ database: _d, ...page }: FakePage) => structuredClone(page);

/** O Notion devolve propriedades com `plain_text` e a data com milissegundos; o fake imita isso. */
function normalize(props: Record<string, any>): Record<string, any> {
  const res: Record<string, any> = {};
  for (const [k, v] of Object.entries(props)) {
    if (v?.title) res[k] = { title: v.title.map((t: any) => ({ plain_text: t.text.content })) };
    else if (v?.relation) res[k] = { relation: v.relation };
    else if (v?.rich_text) res[k] = { rich_text: v.rich_text.map((t: any) => ({ plain_text: t.text.content })) };
    else if (v && "date" in v) res[k] = { date: v.date === null ? null : { start: /T/.test(v.date.start) ? v.date.start.replace(/(:\d{2})(?=Z|[+-]\d{2}:\d{2}$)/, "$1.000") : v.date.start } };
    else res[k] = v;
  }
  return res;
}

function matches(page: FakePage, filter: any): boolean {
  if (!filter) return true;
  if (filter.or) return filter.or.some((f: any) => matches(page, f));
  if (filter.and) return filter.and.every((f: any) => matches(page, f));
  const prop = page.properties[filter.property];
  if (filter.title) {
    const value = (prop?.title ?? []).map((t: any) => t.plain_text).join("").toLowerCase();
    return value.includes(String(filter.title.contains).toLowerCase());
  }
  if (filter.relation) return (prop?.relation ?? []).some((r: any) => r.id === filter.relation.contains);
  if (filter.select) {
    const name = prop?.select?.name;
    return "equals" in filter.select ? name === filter.select.equals : name === undefined;
  }
  if (filter.rich_text) {
    const value = (prop?.rich_text ?? []).map((t: any) => t.plain_text).join("");
    if ("contains" in filter.rich_text) return value.toLowerCase().includes(String(filter.rich_text.contains).toLowerCase());
    return "equals" in filter.rich_text ? value === filter.rich_text.equals : value === "";
  }
  throw new Error(`filtro não suportado no fake: ${JSON.stringify(filter)}`);
}

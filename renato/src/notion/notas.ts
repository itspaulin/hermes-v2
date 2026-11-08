import type { NotionClient } from "../../../shared/notion/client.js";
import { NotionApiError } from "../../../shared/notion/errors.js";
import {
  dateProp,
  instantOf,
  normalizeInstant,
  queryAll,
  relationIds,
  relationProp,
  selectName,
  selectProp,
  text,
  textProp,
  titleProp,
  byIdProperty,
  type NotionPage,
} from "../../../shared/notion/props.js";
import { MAX_BLOCKS_PER_REQUEST, type Block } from "./blocks.js";
import type { Tema, TemaRepository } from "./temas.js";

/** Nomes das propriedades do banco Notas (contrato com o Notion, docs/notion-contract.md). */
const P = { name: "Nome", id: "ID", summary: "Resumo", tema: "Tema", tipo: "Tipo", origem: "Origem", estado: "Estado", created: "Criada" } as const;

export const TIPOS = ["conceito", "diagrama", "resumo", "ideia", "duvida"] as const;
export const ORIGENS = ["texto", "imagem"] as const;
export const ESTADOS = ["nova", "revisada"] as const;
export type Tipo = (typeof TIPOS)[number];
export type Origem = (typeof ORIGENS)[number];
export type Estado = (typeof ESTADOS)[number];

export interface Nota {
  /** ID determinístico (ex.: telegram-<chat>-<mensagem>), a chave de idempotência. */
  id: string;
  pageId: string;
  url: string | undefined;
  title: string;
  summary: string;
  tipo?: Tipo;
  origem?: Origem;
  estado: Estado;
  /** ID (slug) do tema. */
  temaId?: string;
  created: string;
  updated: string;
}

export interface NewNota {
  id: string;
  title: string;
  summary: string;
  tipo: Tipo;
  origem: Origem;
  temaPageId: string;
  createdAt: string;
  blocks: Block[];
}

export class NotaNotFound extends Error {
  constructor(readonly id: string) {
    super(`Nota não encontrada: ${id}`);
    this.name = "NotaNotFound";
  }
}

const oneOf = <T extends string>(list: readonly T[], v: string | undefined): T | undefined => (v !== undefined && (list as readonly string[]).includes(v) ? (v as T) : undefined);

function parse(page: NotionPage, slugByPage: Map<string, string>): Nota | null {
  const p = page.properties;
  const title = text(p[P.name]).trim();
  const id = text(p[P.id]).trim();
  if (title === "" || id === "") return null; // linha sem ID/título: criada à mão, o Renato não mexe nela
  const [temaPage] = relationIds(p[P.tema]);
  const temaId = temaPage === undefined ? undefined : slugByPage.get(temaPage);
  const tipo = oneOf(TIPOS, selectName(p[P.tipo]));
  const origem = oneOf(ORIGENS, selectName(p[P.origem]));
  return {
    id,
    pageId: page.id,
    url: page.url,
    title,
    summary: text(p[P.summary]).trim(),
    estado: oneOf(ESTADOS, selectName(p[P.estado])) ?? "nova",
    created: instantOf(p[P.created], page.created_time)!,
    updated: normalizeInstant(page.last_edited_time),
    ...(tipo && { tipo }),
    ...(origem && { origem }),
    ...(temaId !== undefined && { temaId }),
  };
}

/**
 * Notas no banco Notas do Notion. Criar é criar-se-não-existir pelo ID (reenvio do Telegram não
 * duplica). Complementar só ACRESCENTA blocos ao fim da página: o que já está nela nunca é reescrito,
 * então edições suas no Notion nunca são perdidas. Nunca apaga.
 */
export class NotasRepository {
  constructor(
    private readonly client: NotionClient,
    private readonly databaseId: string,
    private readonly temas: TemaRepository,
  ) {}

  async create(input: NewNota): Promise<{ nota: Nota; created: boolean }> {
    const existing = await this.find(input.id);
    if (existing) return { nota: existing, created: false };

    const first = input.blocks.slice(0, MAX_BLOCKS_PER_REQUEST);
    const page: NotionPage = await this.client.request("POST", "/v1/pages", {
      parent: { database_id: this.databaseId },
      properties: {
        [P.name]: titleProp(input.title),
        [P.id]: textProp(input.id),
        [P.summary]: textProp(input.summary),
        [P.tema]: relationProp([input.temaPageId]),
        [P.tipo]: selectProp(input.tipo),
        [P.origem]: selectProp(input.origem),
        [P.estado]: selectProp("nova"),
        [P.created]: dateProp(input.createdAt),
      },
      children: first,
    });
    await this.append(page.id, input.blocks.slice(MAX_BLOCKS_PER_REQUEST));
    return { nota: await this.parsed(page), created: true };
  }

  async find(id: string, temas?: readonly Tema[]): Promise<Nota | null> {
    const hit = (await queryAll(this.client, this.databaseId, byIdProperty(id)))[0];
    return hit ? this.parsed(hit, temas) : null;
  }

  /** A nota de uma página do Notion (o link que o Renato enviou termina no ID da página). Null se não existe, não é do Renato ou não é uma nota. */
  async findByPageId(pageId: string, temas?: readonly Tema[]): Promise<Nota | null> {
    let page: NotionPage;
    try {
      page = await this.client.request("GET", `/v1/pages/${pageId}`);
    } catch (err) {
      if (err instanceof NotionApiError && (err.status === 404 || err.status === 400)) return null;
      throw err;
    }
    // Só páginas deste banco: o ID vem de um texto enviado pelo usuário.
    if ((page as { parent?: { database_id?: string } }).parent?.database_id?.replace(/-/g, "") !== this.databaseId.replace(/-/g, "")) return null;
    return (await this.parseAll([page], temas))[0] ?? null;
  }

  /** As notas mais recentemente alteradas (para dar contexto ao modelo). */
  async recent(limit: number, temas?: readonly Tema[]): Promise<Nota[]> {
    const res = await this.client.request("POST", `/v1/databases/${this.databaseId}/query`, {
      page_size: Math.min(Math.max(limit, 1), 100),
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
    });
    return this.parseAll(res.results as NotionPage[], temas);
  }

  /** Busca por trecho no título ou no resumo e/ou por temas (páginas do Notion; passe o tema e seus subtemas). */
  async search(query: { text?: string; temaPageIds?: string[]; limit?: number; temas?: readonly Tema[] }): Promise<Nota[]> {
    const and: unknown[] = [];
    const t = query.text?.trim();
    if (t) and.push({ or: [{ property: P.name, title: { contains: t } }, { property: P.summary, rich_text: { contains: t } }] });
    if (query.temaPageIds && query.temaPageIds.length > 0) {
      and.push({ or: query.temaPageIds.map((id) => ({ property: P.tema, relation: { contains: id } })) });
    }
    const res = await this.client.request("POST", `/v1/databases/${this.databaseId}/query`, {
      page_size: Math.min(Math.max(query.limit ?? 20, 1), 100),
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
      ...(and.length > 0 && { filter: { and } }),
    });
    return this.parseAll(res.results as NotionPage[], query.temas);
  }

  /** Acrescenta blocos ao fim da página (em lotes de 100). Não altera nada que já esteja nela. */
  async append(pageId: string, blocks: readonly Block[]): Promise<void> {
    for (let i = 0; i < blocks.length; i += MAX_BLOCKS_PER_REQUEST) {
      await this.client.request("PATCH", `/v1/blocks/${pageId}/children`, { children: blocks.slice(i, i + MAX_BLOCKS_PER_REQUEST) });
    }
  }

  /** Move a nota para outro tema (só a relação muda). */
  async setTema(id: string, temaPageId: string, temas?: readonly Tema[]): Promise<Nota> {
    const nota = await this.find(id);
    if (!nota) throw new NotaNotFound(id);
    const page: NotionPage = await this.client.request("PATCH", `/v1/pages/${nota.pageId}`, { properties: { [P.tema]: relationProp([temaPageId]) } });
    return this.parsed(page, temas);
  }

  private async parsed(page: NotionPage, temas?: readonly Tema[]): Promise<Nota> {
    const [nota] = await this.parseAll([page], temas);
    if (!nota) throw new Error(`Nota inválida no Notion (${page.id})`);
    return nota;
  }

  private async parseAll(pages: NotionPage[], temas?: readonly Tema[]): Promise<Nota[]> {
    const slugByPage = new Map((temas ?? (await this.temas.list())).map((t) => [t.pageId, t.id]));
    return pages.map((p) => parse(p, slugByPage)).filter((n): n is Nota => n !== null);
  }
}

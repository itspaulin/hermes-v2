import type { NotionClient } from "../../../shared/notion/client.js";
import {
  dateProp,
  instantOf,
  queryAll,
  relationIds,
  relationProp,
  text,
  textProp,
  titleProp,
  type NotionPage,
} from "../../../shared/notion/props.js";
import { slugify } from "./slug.js";

/** Nomes das propriedades do banco Temas (contrato com o Notion, docs/notion-contract.md). */
const P = { name: "Nome", id: "ID", parent: "Tema pai", created: "Criada" } as const;

export const INBOX_NAME = "Caixa de entrada";

export interface Tema {
  /** Slug do nome. Dois temas com o mesmo slug são o mesmo tema. */
  id: string;
  pageId: string;
  name: string;
  /** ID (slug) do tema pai. */
  parentId?: string;
  /** Página do Notion do tema pai. */
  parentPageId?: string;
  created: string;
}

export class TemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemaError";
  }
}

function parse(page: NotionPage, slugByPage: Map<string, string>): Tema | null {
  const name = text(page.properties[P.name]).trim();
  if (name === "") return null;
  let id = text(page.properties[P.id]).trim();
  if (id === "") {
    try {
      id = slugify(name);
    } catch {
      return null;
    }
  }
  const [parentPage] = relationIds(page.properties[P.parent]);
  const parentId = parentPage === undefined ? undefined : slugByPage.get(parentPage);
  return {
    id,
    pageId: page.id,
    name,
    created: instantOf(page.properties[P.created], page.created_time)!,
    ...(parentId !== undefined && { parentId }),
    ...(parentPage !== undefined && { parentPageId: parentPage }),
  };
}

/**
 * Temas no banco Temas do Notion. Dois temas não podem ter o mesmo nome: o ID é o slug do nome e
 * criar um nome que já existe devolve o existente (maiúsculas, acentos e espaços não distinguem).
 * Nunca apaga nem renomeia.
 */
export class TemaRepository {
  constructor(
    private readonly client: NotionClient,
    private readonly databaseId: string,
  ) {}

  /** Todos os temas (a lista é pequena), pais resolvidos. Linhas sem nome aproveitável são ignoradas. */
  async list(): Promise<Tema[]> {
    const pages = await queryAll(this.client, this.databaseId);
    const slugByPage = new Map<string, string>();
    for (const page of pages) {
      const t = parse(page, new Map());
      if (t) slugByPage.set(page.id, t.id);
    }
    const out: Tema[] = [];
    for (const page of pages) {
      const t = parse(page, slugByPage);
      if (t) out.push(t);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Procura por ID ou por nome (qualquer grafia que dê o mesmo slug). */
  async find(nameOrId: string): Promise<Tema | null> {
    return findIn(await this.list(), nameOrId);
  }

  /**
   * Devolve o tema com esse nome ou o cria (com `Tema pai` opcional, que precisa existir). A "Caixa de
   * entrada" nunca é pai de ninguém.
   */
  async ensure(name: string, createdAt: string, parentId?: string): Promise<{ tema: Tema; created: boolean }> {
    const clean = name.replace(/\s+/g, " ").trim();
    if (clean === "" || clean.length > 100) throw new TemaError("Nome de tema inválido (vazio ou longo demais)");
    let id: string;
    try {
      id = slugify(clean);
    } catch {
      throw new TemaError("Nome de tema sem letras ou números aproveitáveis");
    }

    const all = await this.list();
    const existing = all.find((t) => t.id === id);
    if (existing) return { tema: existing, created: false };

    let parent: Tema | undefined;
    if (parentId !== undefined) {
      parent = all.find((t) => t.id === parentId);
      if (!parent) throw new TemaError(`Tema pai não encontrado: ${parentId}`);
      if (parent.id === slugify(INBOX_NAME)) throw new TemaError("A Caixa de entrada não pode ter subtemas");
    }

    const page: NotionPage = await this.client.request("POST", "/v1/pages", {
      parent: { database_id: this.databaseId },
      properties: {
        [P.name]: titleProp(clean),
        [P.id]: textProp(id),
        [P.created]: dateProp(createdAt),
        ...(parent && { [P.parent]: relationProp([parent.pageId]) }),
      },
    });
    return { tema: { id, pageId: page.id, name: clean, created: createdAt, ...(parent && { parentId: parent.id, parentPageId: parent.pageId }) }, created: true };
  }

  /** Arquivar = lixeira do Notion (dá para restaurar de lá ou com `unarchive`). Nunca apaga de verdade. */
  async archive(pageId: string): Promise<void> {
    await this.client.request("PATCH", `/v1/pages/${pageId}`, { archived: true });
  }

  async unarchive(pageId: string): Promise<void> {
    await this.client.request("PATCH", `/v1/pages/${pageId}`, { archived: false });
  }

  /** Muda o tema pai (null = primeiro nível). Só a relação `Tema pai` é alterada. */
  async setParent(pageId: string, parentPageId: string | null): Promise<void> {
    await this.client.request("PATCH", `/v1/pages/${pageId}`, { properties: { [P.parent]: relationProp(parentPageId === null ? [] : [parentPageId]) } });
  }

  /** A "Caixa de entrada": existe sempre (criada na primeira vez). */
  async inbox(createdAt: string): Promise<Tema> {
    return (await this.ensure(INBOX_NAME, createdAt)).tema;
  }
}

export function findIn(temas: readonly Tema[], nameOrId: string): Tema | null {
  let slug: string;
  try {
    slug = slugify(nameOrId);
  } catch {
    return null;
  }
  return temas.find((t) => t.id === slug) ?? null;
}

/** "Programação > C#" — caminho do tema até a raiz. Protegido contra ciclos. */
export function temaPath(temas: readonly Tema[], tema: Tema): string {
  const names = [tema.name];
  const seen = new Set([tema.id]);
  let current = tema;
  while (current.parentId !== undefined && !seen.has(current.parentId)) {
    const parent = temas.find((t) => t.id === current.parentId);
    if (!parent) break;
    names.unshift(parent.name);
    seen.add(parent.id);
    current = parent;
  }
  return names.join(" > ");
}

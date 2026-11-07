import { META_STATUSES, type Meta, type MetaStatus } from "../domain/meta.js";
import {
  compareMetas,
  MetaNotFound,
  planMeta,
  type CreateMetaInput,
  type MetaListing,
  type MetaRepository,
} from "../domain/meta-repository.js";
import { isSlug, slugify } from "../vault/slug.js";
import type { NotionClient } from "./client.js";
import {
  byIdProperty,
  dateProp,
  instantOf,
  localDateOf,
  normalizeInstant,
  PROP,
  queryAll,
  selectName,
  selectProp,
  text,
  textProp,
  titleProp,
  withoutId,
  type NotionPage,
} from "./pages.js";

type Parsed = { ok: true; meta: Meta } | { ok: false; reason: string };

/** Página do banco Metas -> Meta. Linha sem ID/Criada/Status (criada à mão) é aceita, com valores derivados. */
function parseMeta(page: NotionPage): Parsed {
  const p = page.properties;
  const title = text(p[PROP.title]).trim();
  if (title === "") return { ok: false, reason: "meta sem título" };

  const status = selectName(p[PROP.status]) ?? "ativa";
  if (!(META_STATUSES as readonly string[]).includes(status)) return { ok: false, reason: `status inválido: ${status}` };

  let id = text(p[PROP.id]).trim();
  if (id === "") {
    try {
      id = slugify(title);
    } catch {
      return { ok: false, reason: "título sem letras ou números aproveitáveis" };
    }
  }
  if (!isSlug(id)) return { ok: false, reason: `ID inválido: ${id}` };

  let due;
  try {
    due = localDateOf(p[PROP.due]);
  } catch {
    return { ok: false, reason: "prazo inválido" };
  }
  return {
    ok: true,
    meta: {
      id,
      path: page.id,
      title,
      status: status as MetaStatus,
      created: instantOf(p[PROP.created], page.created_time)!,
      updated: normalizeInstant(page.last_edited_time),
      ...(due !== undefined && { due }),
    },
  };
}

/** Metas no banco Metas do Notion. Mesmo contrato do MetaRepository do Vault (docs/notion-contract.md). */
export class NotionMetaRepository implements MetaRepository {
  constructor(
    private readonly client: NotionClient,
    private readonly databaseId: string,
  ) {}

  async create(input: CreateMetaInput): Promise<{ meta: Meta; created: boolean }> {
    const { title, id, createdAt } = planMeta(input);
    const existing = await this.findRow(id, false);
    if (existing) return { meta: existing.meta, created: false };

    const page: NotionPage = await this.client.request("POST", "/v1/pages", {
      parent: { database_id: this.databaseId },
      properties: {
        [PROP.title]: titleProp(title),
        [PROP.id]: textProp(id),
        [PROP.status]: selectProp("ativa"),
        [PROP.created]: dateProp(createdAt),
        ...(input.due !== undefined && { [PROP.due]: dateProp(input.due) }),
      },
    });
    return { meta: this.parsed(page), created: true };
  }

  async find(id: string): Promise<Meta | null> {
    if (!isSlug(id)) return null;
    return (await this.findRow(id, true))?.meta ?? null;
  }

  async list(): Promise<MetaListing> {
    const metas: Meta[] = [];
    const skipped: MetaListing["skipped"] = [];
    for (const page of await queryAll(this.client, this.databaseId)) {
      const r = parseMeta(page);
      if (r.ok) metas.push(r.meta);
      else skipped.push({ path: page.id, reason: r.reason });
    }
    metas.sort(compareMetas);
    skipped.sort((a, b) => a.path.localeCompare(b.path));
    return { metas, skipped };
  }

  async setStatus(id: string, target: MetaStatus): Promise<{ meta: Meta; changed: boolean }> {
    const row = await this.findRow(id, true);
    if (!row) throw new MetaNotFound(id);
    if (row.meta.status === target) return { meta: row.meta, changed: false };
    const page: NotionPage = await this.client.request("PATCH", `/v1/pages/${row.page.id}`, {
      properties: { [PROP.status]: selectProp(target), ...(row.hasId ? {} : { [PROP.id]: textProp(id) }) },
    });
    return { meta: this.parsed(page), changed: true };
  }

  /** Metas com o ID da página do Notion (as tarefas guardam a relação pela página). */
  async withPages(): Promise<{ meta: Meta; pageId: string }[]> {
    const out: { meta: Meta; pageId: string }[] = [];
    for (const page of await queryAll(this.client, this.databaseId)) {
      const r = parseMeta(page);
      if (r.ok) out.push({ meta: r.meta, pageId: page.id });
    }
    return out;
  }

  /** Migração: cria a meta com todos os campos (status, datas), se o ID ainda não existe. */
  async importMeta(meta: Meta): Promise<"created" | "exists"> {
    if (await this.findRow(meta.id, false)) return "exists";
    await this.client.request("POST", "/v1/pages", {
      parent: { database_id: this.databaseId },
      properties: {
        [PROP.title]: titleProp(meta.title),
        [PROP.id]: textProp(meta.id),
        [PROP.status]: selectProp(meta.status),
        [PROP.created]: dateProp(meta.created),
        ...(meta.due !== undefined && { [PROP.due]: dateProp(meta.due) }),
      },
    });
    return "created";
  }

  private parsed(page: NotionPage): Meta {
    const r = parseMeta(page);
    if (!r.ok) throw new Error(`Meta inválida no Notion (${page.id}): ${r.reason}`);
    return r.meta;
  }

  /**
   * Linha pelo ID. Com `adoptManual`, também procura linhas criadas à mão (sem ID) cujo ID derivado
   * do título bate; a mais antiga vence.
   */
  private async findRow(id: string, adoptManual: boolean): Promise<{ page: NotionPage; meta: Meta; hasId: boolean } | null> {
    const hit = (await queryAll(this.client, this.databaseId, byIdProperty(id)))[0];
    if (hit) {
      const r = parseMeta(hit);
      return r.ok ? { page: hit, meta: r.meta, hasId: true } : null;
    }
    if (!adoptManual) return null;
    for (const page of await queryAll(this.client, this.databaseId, withoutId)) {
      const r = parseMeta(page);
      if (r.ok && r.meta.id === id) return { page, meta: r.meta, hasId: false };
    }
    return null;
  }
}

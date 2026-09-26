import {
  instantIsoOfEpochSeconds,
  nowIso,
  parseLocalDate,
  type Clock,
  type LocalDate,
} from "../time/index.js";
import { VaultConflict, VaultInvalidNote } from "../vault/errors.js";
import { parseNote, renderNote, serializeNote, setScalar } from "../vault/frontmatter.js";
import { isSlug, slugify } from "../vault/slug.js";
import type { VaultStore } from "../vault/store.js";
import {
  metaFromNote,
  metaPath,
  parseMeta,
  META_SCHEMA_VERSION,
  METAS_DIR,
  type Meta,
  type MetaStatus,
} from "./meta.js";

const MAX_ATTEMPTS = 3;
const MAX_TITLE_LENGTH = 200;
const READ_CONCURRENCY = 10;

/** Entrada inválida do usuário (título vazio, data ruim...). Não é falha de infraestrutura. */
export class MetaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetaValidationError";
  }
}

export class MetaNotFound extends Error {
  constructor(readonly id: string) {
    super(`Meta não encontrada: ${id}`);
    this.name = "MetaNotFound";
  }
}

export interface CreateMetaInput {
  title: string;
  /** Instante do EVENTO (ex.: message.date do Telegram), em epoch seconds. Define `created`. */
  eventEpochSeconds: number;
  due?: LocalDate;
}

export interface MetaListing {
  metas: Meta[];
  /** Notas que o Hermes não conseguiu interpretar. Ficam de fora, não derrubam a listagem. */
  skipped: { path: string; reason: string }[];
}

/**
 * Metas sobre um VaultStore, com o mesmo contrato das tarefas (docs/vault-contract.md):
 * criar-se-não-existir, alterar por set com lock otimista, corpo nunca tocado.
 * O ID é o slug do título (sem data): o mesmo título é a mesma meta.
 */
export class MetaRepository {
  constructor(
    private readonly store: VaultStore,
    private readonly clock: Clock,
  ) {}

  async create(input: CreateMetaInput): Promise<{ meta: Meta; created: boolean }> {
    const title = input.title.replace(/\s+/g, " ").trim();
    if (title === "") throw new MetaValidationError("Título vazio");
    if (title.length > MAX_TITLE_LENGTH) {
      throw new MetaValidationError(`Título longo demais (máximo ${MAX_TITLE_LENGTH} caracteres)`);
    }
    if (/[\u0000-\u001f\u007f]/.test(title)) throw new MetaValidationError("Título com caracteres de controle");
    let id: string;
    try {
      id = slugify(title);
    } catch {
      throw new MetaValidationError("Título sem letras ou números aproveitáveis");
    }
    if (input.due !== undefined) {
      try {
        parseLocalDate(input.due);
      } catch {
        throw new MetaValidationError(`Data inválida: ${input.due}`);
      }
    }
    let createdAt: string;
    try {
      createdAt = instantIsoOfEpochSeconds(input.eventEpochSeconds);
    } catch {
      throw new MetaValidationError("Instante do evento inválido");
    }

    const path = metaPath(id);
    const content = renderNote(
      {
        schema: META_SCHEMA_VERSION,
        id,
        type: "meta",
        title,
        status: "ativa",
        created: createdAt,
        updated: createdAt,
        ...(input.due !== undefined && { due: input.due }),
      },
      `\n# ${title}\n`,
    );

    if ((await this.store.create(path, content)) === "created") {
      return { meta: parseMeta(content, path), created: true };
    }
    const existing = await this.store.read(path);
    if (!existing) throw new VaultConflict(path);
    return { meta: parseMeta(existing.content, path), created: false };
  }

  async find(id: string): Promise<Meta | null> {
    if (!isSlug(id)) return null;
    const path = metaPath(id);
    const file = await this.store.read(path);
    return file ? parseMeta(file.content, path) : null;
  }

  /** Todas as metas legíveis (qualquer status), por ID. */
  async list(): Promise<MetaListing> {
    const paths = await this.store.list(METAS_DIR);
    const metas: Meta[] = [];
    const skipped: MetaListing["skipped"] = [];

    for (let i = 0; i < paths.length; i += READ_CONCURRENCY) {
      const results = await Promise.all(
        paths.slice(i, i + READ_CONCURRENCY).map(async (path) => {
          const file = await this.store.read(path);
          if (!file) return null;
          try {
            return parseMeta(file.content, path);
          } catch (err) {
            if (err instanceof VaultInvalidNote) {
              skipped.push({ path, reason: err.message });
              return null;
            }
            throw err;
          }
        }),
      );
      for (const m of results) if (m) metas.push(m);
    }

    metas.sort(compareMetas);
    skipped.sort((a, b) => a.path.localeCompare(b.path));
    return { metas, skipped };
  }

  /** Idempotente. `changed` = false se já estava no status pedido (nada é escrito). */
  async setStatus(id: string, target: MetaStatus): Promise<{ meta: Meta; changed: boolean }> {
    const path = metaPath(id);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const file = await this.store.read(path);
      if (!file) throw new MetaNotFound(id);

      const note = parseNote(file.content, path);
      const current = metaFromNote(note, path);
      if (current.status === target) return { meta: current, changed: false };

      setScalar(note, "status", target);
      setScalar(note, "updated", nowIso(this.clock));
      const next = serializeNote(note);

      if ((await this.store.update(path, file.sha, next)) === "ok") {
        return { meta: parseMeta(next, path), changed: true };
      }
    }
    throw new VaultConflict(path);
  }
}

/** Com prazo primeiro (mais cedo antes), sem prazo depois; desempate por ID. */
function compareMetas(a: Meta, b: Meta): number {
  if (a.due && b.due && a.due !== b.due) return a.due < b.due ? -1 : 1;
  if (a.due && !b.due) return -1;
  if (!a.due && b.due) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

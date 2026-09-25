import { parseLocalDate } from "../time/index.js";
import { VaultPathViolation } from "./errors.js";
import { isSlug } from "./slug.js";

/**
 * Guarda de caminhos do contrato Hermes-Vault (docs/vault-contract.md, seção 9).
 * Abordagem de lista de permissão: só passa o que casa com a gramática abaixo.
 * O token do GitHub não restringe por pasta; esta é a única barreira.
 *
 *   Hermes/metas/<slug>.md
 *   Hermes/tarefas/<AAAA-MM-DD>-<slug>.md
 *   Hermes/checkins/<AAAA>/<AAAA-MM-DD>-<checkin|metrics>.md
 *   Hermes/revisoes/<AAAA>-W<01..53>.md
 */
export const HERMES_ROOT = "Hermes";

const DATE_PREFIX_RE = /^(\d{4}-\d{2}-\d{2})-(.+)$/;
const CHECKIN_FILE_RE = /^(\d{4}-\d{2}-\d{2})-(checkin|metrics)\.md$/;
const REVIEW_FILE_RE = /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])\.md$/;
const YEAR_RE = /^\d{4}$/;
const MAX_PATH_LENGTH = 200;

function fail(path: unknown, reason: string): never {
  throw new VaultPathViolation(typeof path === "string" ? path : String(path), reason);
}

/** Validação estrutural comum a arquivos e diretórios. Devolve os segmentos. */
function segmentsOf(path: unknown): string[] {
  if (typeof path !== "string") return fail(path, "não é string");
  if (path === "" || path.length > MAX_PATH_LENGTH) return fail(path, "vazio ou longo demais");
  // Só ASCII imprimível sem espaço nem barra invertida: cobre unicode, controle, NUL e "\".
  if (!/^[\x21-\x7e]+$/.test(path)) return fail(path, "caracteres não permitidos");
  if (path.startsWith("/") || path.endsWith("/")) return fail(path, "barra nas pontas");
  const segments = path.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) {
    return fail(path, "segmento vazio, '.' ou '..'");
  }
  if (segments[0] !== HERMES_ROOT) return fail(path, "fora de Hermes/");
  return segments;
}

function assertDate(path: string, date: string): void {
  try {
    parseLocalDate(date);
  } catch {
    fail(path, "data inválida no nome");
  }
}

/** Valida um caminho de ARQUIVO. Deve ser chamada em toda leitura e escrita. */
export function assertHermesPath(path: unknown): asserts path is string {
  const segments = segmentsOf(path);
  const p = path as string;
  const [, folder, ...rest] = segments;

  switch (folder) {
    case "metas": {
      const m = /^(.+)\.md$/.exec(rest[0] ?? "");
      if (rest.length !== 1 || !m || !isSlug(m[1]!)) fail(p, "meta: esperado Hermes/metas/<slug>.md");
      return;
    }
    case "tarefas": {
      const m = /^(.+)\.md$/.exec(rest[0] ?? "");
      const parts = m ? DATE_PREFIX_RE.exec(m[1]!) : null;
      if (rest.length !== 1 || !parts || !isSlug(parts[2]!)) {
        fail(p, "tarefa: esperado Hermes/tarefas/<AAAA-MM-DD>-<slug>.md");
      }
      assertDate(p, parts![1]!);
      return;
    }
    case "checkins": {
      const year = rest[0];
      const m = CHECKIN_FILE_RE.exec(rest[1] ?? "");
      if (rest.length !== 2 || !year || !YEAR_RE.test(year) || !m) {
        fail(p, "checkin: esperado Hermes/checkins/<AAAA>/<AAAA-MM-DD>-<tipo>.md");
      }
      assertDate(p, m![1]!);
      if (!m![1]!.startsWith(`${year}-`)) fail(p, "checkin: ano do diretório difere da data");
      return;
    }
    case "revisoes": {
      if (rest.length !== 1 || !REVIEW_FILE_RE.test(rest[0]!)) {
        fail(p, "revisão: esperado Hermes/revisoes/<AAAA>-W<SS>.md");
      }
      return;
    }
    default:
      fail(p, "pasta desconhecida em Hermes/");
  }
}

/** Valida um caminho de DIRETÓRIO listável (sem barra final). */
export function assertHermesDir(dir: unknown): asserts dir is string {
  const segments = segmentsOf(dir);
  const d = dir as string;
  const [, folder, sub, ...extra] = segments;
  const ok =
    (segments.length === 2 && ["metas", "tarefas", "checkins", "revisoes"].includes(folder ?? "")) ||
    (segments.length === 3 && folder === "checkins" && YEAR_RE.test(sub ?? "") && extra.length === 0);
  if (!ok) fail(d, "diretório não listável");
}

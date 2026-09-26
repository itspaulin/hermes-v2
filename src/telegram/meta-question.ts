import { createHash } from "node:crypto";
import type { Meta } from "../domain/meta.js";
import { TASK_ID_RE } from "../domain/task-resolve.js";
import { parseLocalDate, type LocalDate } from "../time/index.js";
import { isSlug, slugify } from "../vault/slug.js";
import type { InlineKeyboard } from "./client.js";

/**
 * A pergunta "essa tarefa pertence a alguma meta?" SEM estado guardado em lugar nenhum.
 * Tudo que a resposta precisa está na própria mensagem do bot (que o Telegram devolve no
 * `callback_query.message` e no `reply_to_message`):
 *
 *   Tarefa: <título>
 *   Prazo: <AAAA-MM-DD>          (só se houver)
 *   ID: <id da tarefa>
 *
 *   Essa tarefa pertence a alguma meta?
 *
 *   1. <título da meta>
 *      ID: <id da meta>
 *   2. Nenhuma meta específica
 *
 * O número é só uma opção DESSA mensagem; quem grava no Vault é o ID da meta lido da lista
 * que o usuário viu. O botão leva só `tm:<tag>:<n>` (tag = hash curto do ID da tarefa, que
 * amarra o botão à tarefa da mensagem).
 */
export const QUESTION_HEADER = "Essa tarefa pertence a alguma meta?";
export const NONE_LABEL = "Nenhuma meta específica";
/** Depois disso o Hermes não aceita mais a resposta. */
export const QUESTION_TTL_SECONDS = 24 * 60 * 60;

export const INVALID_OPTION = 'Opção inválida. Responda com um número da lista ou "nenhuma".';
export const UNAVAILABLE_META = "A meta selecionada não está mais disponível. Escolha outra meta.";
export const EXPIRED_QUESTION = "Essa pergunta expirou. Envie /tarefa de novo.";

export interface PendingTask {
  id: string;
  title: string;
  due?: LocalDate;
}

export interface ParsedQuestion {
  task: PendingTask;
  /** ID da meta de cada opção, na ordem da lista (opção n = índice n-1). `null` = nenhuma meta. */
  options: (string | null)[];
}

const BUTTON_LABEL_MAX = 60;

export function questionText(task: PendingTask, metas: readonly Meta[]): string {
  const lines = [`Tarefa: ${task.title}`];
  if (task.due) lines.push(`Prazo: ${task.due}`);
  lines.push(`ID: ${task.id}`, "", QUESTION_HEADER, "");
  metas.forEach((m, i) => lines.push(`${i + 1}. ${m.title}`, `   ID: ${m.id}`, ""));
  lines.push(`${metas.length + 1}. ${NONE_LABEL}`, "", 'Toque em um botão, ou responda a esta mensagem com o número (ou "nenhuma").');
  return lines.join("\n");
}

export function questionKeyboard(task: PendingTask, metas: readonly Meta[]): InlineKeyboard {
  const labels = [...metas.map((m) => m.title), NONE_LABEL];
  return labels.map((label, i) => [
    { text: `${i + 1}. ${label}`.slice(0, BUTTON_LABEL_MAX), data: encodeChoice(task.id, i + 1) },
  ]);
}

/** Texto que substitui a pergunta depois de respondida, expirada ou trocada (sem botões). */
export function closedQuestionText(task: PendingTask, note: string): string {
  return `Tarefa: ${task.title}\n${note}`;
}

export function parseQuestion(text: string): ParsedQuestion | null {
  // Pode haver um aviso antes (ex.: "A meta selecionada não está mais disponível...").
  const all = text.split("\n");
  const start = all.findIndex((l) => l.startsWith("Tarefa: "));
  if (start === -1) return null;
  const lines = all.slice(start);
  const title = /^Tarefa: (.+)$/.exec(lines[0] ?? "")?.[1];
  if (!title) return null;

  let i = 1;
  let due: LocalDate | undefined;
  const dueRaw = /^Prazo: (\d{4}-\d{2}-\d{2})$/.exec(lines[i] ?? "")?.[1];
  if (dueRaw) {
    try {
      due = parseLocalDate(dueRaw);
    } catch {
      return null;
    }
    i++;
  }
  const id = /^ID: (\S+)$/.exec(lines[i++] ?? "")?.[1];
  if (!id || !TASK_ID_RE.test(id)) return null;
  let slug: string;
  try {
    slug = slugify(title);
  } catch {
    return null;
  }
  if (id.slice(11) !== slug) return null; // o ID tem que ser o do título mostrado
  try {
    parseLocalDate(id.slice(0, 10));
  } catch {
    return null;
  }

  if (lines[i++] !== "" || lines[i++] !== QUESTION_HEADER || lines[i++] !== "") return null;

  const options: (string | null)[] = [];
  for (;;) {
    const m = /^(\d+)\. (.+)$/.exec(lines[i] ?? "");
    if (!m || Number(m[1]) !== options.length + 1) return null;
    i++;
    const metaId = /^ {3}ID: (\S+)$/.exec(lines[i] ?? "")?.[1];
    if (metaId !== undefined) {
      if (!isSlug(metaId)) return null;
      options.push(metaId);
      i++;
      if (lines[i++] !== "") return null;
    } else if (m[2] === NONE_LABEL) {
      options.push(null);
      break;
    } else {
      return null;
    }
  }
  return { task: { id, title, ...(due !== undefined && { due }) }, options };
}

// ---------- callback_data ----------

export function bindTag(taskId: string): string {
  return createHash("sha256").update(taskId).digest("hex").slice(0, 8);
}

export function encodeChoice(taskId: string, n: number): string {
  return `tm:${bindTag(taskId)}:${n}`;
}

export function decodeChoice(data: string | undefined): { tag: string; n: number } | null {
  const m = /^tm:([0-9a-f]{8}):(\d{1,3})$/.exec(data ?? "");
  return m ? { tag: m[1]!, n: Number(m[2]) } : null;
}

// ---------- resposta por texto ----------

const NONE_WORDS = new Set(["nao", "não", "nenhuma", "nenhum", "nada"]);

/** "2" vira 2; "não"/"nenhuma" vira a última opção (nenhuma meta); o resto é inválido (null). */
export function parseTextChoice(text: string, optionCount: number): number | null {
  const t = text.trim().toLowerCase();
  if (NONE_WORDS.has(t)) return optionCount;
  return /^\d{1,3}$/.test(t) ? Number(t) : null;
}

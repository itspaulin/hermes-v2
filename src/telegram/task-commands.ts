import type { MetaRepository } from "../domain/meta-repository.js";
import { exactTaskId, matchPending } from "../domain/task-resolve.js";
import { TaskNotFound, TaskValidationError, type TaskRepository } from "../domain/task-repository.js";
import type { Task } from "../domain/task.js";
import { isSlug } from "../vault/slug.js";
import { parseLocalDate, type LocalDate } from "../time/index.js";

/**
 * Comandos de tarefa. Falam com o TaskRepository (domínio), nunca com GitHub.
 * Devolvem sempre o texto da resposta; erros de infraestrutura propagam para o webhook.
 *
 *   /tarefa <título>
 *   /tarefa <título> até AAAA-MM-DD
 *   /tarefa <título> [até AAAA-MM-DD] #<id-da-meta>
 *   /feita <id-ou-trecho>
 *   /cancelar <id-ou-trecho>
 */
export const TAREFA_USAGE = "Uso: /tarefa <título> [até AAAA-MM-DD] [#meta]";
const DATE_HELP = "Use AAAA-MM-DD (ex.: 2026-10-02).";
const MAX_CANDIDATES = 10;

const RELATIVE_WORDS = new Set([
  "hoje", "amanha", "amanhã", "depois", "segunda", "terca", "terça", "quarta", "quinta", "sexta",
  "sabado", "sábado", "domingo",
]);

export type ParsedTarefa = { title: string; due?: LocalDate; meta?: string } | { error: string };

/**
 * "título [até AAAA-MM-DD]", compartilhado por /tarefa e /meta. Só AAAA-MM-DD: datas
 * relativas são recusadas de propósito (fase 2).
 */
export function parseTitleAndDue(args: string, usage: string): { title: string; due?: LocalDate } | { error: string } {
  const s = args.replace(/\s+/g, " ").trim();
  if (s === "") return { error: usage };
  // "até" sem título: sozinho, ou seguido só de uma data/palavra relativa. "até logo" é um título.
  const bare = /^(?:até|ate)(?: (\S+))?$/i.exec(s);
  if (bare && (bare[1] === undefined || /^\d/.test(bare[1]) || RELATIVE_WORDS.has(bare[1].toLowerCase()))) {
    return { error: `O título é obrigatório. ${usage}` };
  }

  const m = /^(.*\S) (?:até|ate) (\S+)$/i.exec(s);
  if (!m) return { title: s };
  const [, title, when] = m as unknown as [string, string, string];

  if (/^\d/.test(when)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(when)) return { error: `Data inválida: ${when}. ${DATE_HELP}` };
    try {
      return { title, due: parseLocalDate(when) };
    } catch {
      return { error: `Data inexistente: ${when}. ${DATE_HELP}` };
    }
  }
  if (RELATIVE_WORDS.has(when.toLowerCase())) {
    return { error: `Datas relativas ainda não são suportadas ("${when}"). ${DATE_HELP}` };
  }
  return { title: s }; // "ir até padaria": o "até" faz parte do título
}

/** Aceita "#meta" só como ÚLTIMA palavra, para não confundir com o meio de um título. */
export function parseTarefaArgs(args: string): ParsedTarefa {
  const s = args.replace(/\s+/g, " ").trim();
  const m = /^(.*?) ?#(\S+)$/.exec(s);
  if (!m) return parseTitleAndDue(s, TAREFA_USAGE);

  const meta = m[2]!.toLowerCase();
  if (!isSlug(meta)) return { error: `ID de meta inválido: #${m[2]}. Veja os IDs em /metas.` };
  const rest = parseTitleAndDue(m[1]!, TAREFA_USAGE);
  return "error" in rest ? rest : { ...rest, meta };
}

export async function cmdTarefa(
  args: string,
  eventEpochSeconds: number | undefined,
  tasks: TaskRepository,
  metas: MetaRepository,
): Promise<string> {
  const parsed = parseTarefaArgs(args);
  if ("error" in parsed) return parsed.error;

  const meta = parsed.meta === undefined ? null : await metas.find(parsed.meta);
  if (parsed.meta !== undefined && !meta) return `Meta não encontrada: ${parsed.meta}. Veja os IDs em /metas.`;

  const { task, created } = await tasks.create({
    title: parsed.title,
    eventEpochSeconds: eventEpochSeconds as number, // ausente/ inválido vira TaskValidationError no repositório
    ...(parsed.due !== undefined && { due: parsed.due }),
    ...(meta && { meta: meta.id }),
  });

  const lines = [created ? `Tarefa criada: ${task.title}` : `Tarefa já existe: ${task.title}`, `ID: ${task.id}`];
  if (task.due) lines.push(`Prazo: ${task.due}`);
  if (task.meta) lines.push(`Meta: ${task.meta}`);
  if (!created && parsed.due !== undefined && parsed.due !== task.due) {
    lines.push("Obs.: o prazo pedido não foi alterado.");
  }
  if (!created && meta && meta.id !== task.meta) lines.push("Obs.: a meta pedida não foi alterada.");
  return lines.join("\n");
}

const LABELS = {
  feita: { verb: "complete", done: "Feita", already: "Já estava feita", usage: "Uso: /feita <id-ou-trecho>" },
  cancelada: { verb: "cancel", done: "Cancelada", already: "Já estava cancelada", usage: "Uso: /cancelar <id-ou-trecho>" },
} as const;

export async function cmdMudarStatus(
  target: "feita" | "cancelada",
  args: string,
  tasks: TaskRepository,
): Promise<string> {
  const label = LABELS[target];
  const ref = args.trim();
  if (ref === "") return label.usage;

  const chosen = await resolve(ref, tasks);
  if (typeof chosen === "string") return chosen;

  try {
    const { task, changed } =
      target === "feita" ? await tasks.complete(chosen.id) : await tasks.cancel(chosen.id);
    return `${changed ? label.done : label.already}: ${task.title}`;
  } catch (err) {
    if (err instanceof TaskNotFound) return "Tarefa não encontrada.";
    throw err;
  }
}

/** Devolve a tarefa escolhida, ou o texto da resposta (não encontrada, ambígua, uso). */
async function resolve(ref: string, tasks: TaskRepository): Promise<Task | string> {
  // ID completo: procura direto (permite repetir /feita numa tarefa já feita, que dá no-op).
  const id = exactTaskId(ref);
  if (id) {
    const t = await tasks.find(id);
    return t ?? "Tarefa não encontrada.";
  }

  let matches: Task[];
  try {
    matches = matchPending(ref, (await tasks.listPending()).tasks);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Título sem caracteres")) {
      throw new TaskValidationError("Referência sem letras ou números aproveitáveis.");
    }
    throw err;
  }
  if (matches.length === 0) return "Tarefa não encontrada.";
  if (matches.length === 1) return matches[0]!;

  const shown = matches.slice(0, MAX_CANDIDATES).map((t) => `- ${t.id} (${t.title})`);
  const more = matches.length > MAX_CANDIDATES ? [`...e mais ${matches.length - MAX_CANDIDATES}`] : [];
  return ["Mais de uma tarefa corresponde. Seja mais específico:", ...shown, ...more].join("\n");
}

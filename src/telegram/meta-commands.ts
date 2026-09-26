import type { Meta } from "../domain/meta.js";
import { MetaNotFound, type MetaRepository } from "../domain/meta-repository.js";
import type { TaskRepository } from "../domain/task-repository.js";
import { slugify } from "../vault/slug.js";
import type { LocalDate } from "../time/index.js";
import { parseTitleAndDue } from "./task-commands.js";

/**
 * Comandos de meta. Falam com MetaRepository/TaskRepository (domínio), nunca com GitHub.
 *
 *   /meta <título> [até AAAA-MM-DD]
 *   /metas
 *   /metafeita <id-ou-trecho>
 *   /metacancelar <id-ou-trecho>
 */
export const META_USAGE = "Uso: /meta <título> [até AAAA-MM-DD]";
const MAX_CANDIDATES = 10;

const br = (d: LocalDate): string => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export async function cmdMeta(
  args: string,
  eventEpochSeconds: number | undefined,
  metas: MetaRepository,
): Promise<string> {
  const parsed = parseTitleAndDue(args, META_USAGE);
  if ("error" in parsed) return parsed.error;

  const { meta, created } = await metas.create({
    title: parsed.title,
    eventEpochSeconds: eventEpochSeconds as number, // ausente/inválido vira MetaValidationError no repositório
    ...(parsed.due !== undefined && { due: parsed.due }),
  });

  const lines = [created ? `Meta criada: ${meta.title}` : `Meta já existe: ${meta.title}`, `ID: ${meta.id}`];
  if (meta.due) lines.push(`Prazo: ${meta.due}`);
  if (!created && parsed.due !== undefined && parsed.due !== meta.due) {
    lines.push("Obs.: o prazo pedido não foi alterado.");
  }
  if (!created && meta.status !== "ativa") lines.push(`Status: ${meta.status}`);
  return lines.join("\n");
}

export async function cmdMetas(metas: MetaRepository, tasks: TaskRepository): Promise<string> {
  const [{ metas: all, skipped: skippedMetas }, { tasks: pending, skipped: skippedTasks }] = await Promise.all([
    metas.list(),
    tasks.listPending(),
  ]);

  const active = all.filter((m) => m.status === "ativa");
  const paused = all.filter((m) => m.status === "pausada");
  const skipped = skippedMetas.length + skippedTasks.length;

  const lines: string[] = [];
  if (active.length === 0) {
    lines.push("Nenhuma meta ativa. Crie com /meta <título>.");
  } else {
    lines.push(`Metas ativas (${active.length}):`);
    for (const m of active) {
      const open = pending.filter((t) => t.meta === m.id).length;
      const due = m.due ? ` até ${br(m.due)}` : "";
      lines.push(`- ${m.title}${due}: ${count(open, "tarefa pendente", "tarefas pendentes")}`, `  #${m.id}`);
    }
  }
  if (paused.length) lines.push("", `${count(paused.length, "meta pausada", "metas pausadas")}: ${paused.map((m) => m.title).join(", ")}.`);
  if (skipped) lines.push("", `Obs.: ${count(skipped, "nota ignorada por estar inválida", "notas ignoradas por estarem inválidas")}.`);
  return lines.join("\n");
}

const LABELS = {
  concluida: { done: "Meta concluída", already: "Meta já estava concluída", usage: "Uso: /metafeita <id-ou-trecho>" },
  cancelada: { done: "Meta cancelada", already: "Meta já estava cancelada", usage: "Uso: /metacancelar <id-ou-trecho>" },
} as const;

export async function cmdMudarStatusMeta(
  target: "concluida" | "cancelada",
  args: string,
  metas: MetaRepository,
): Promise<string> {
  const label = LABELS[target];
  const ref = args.trim();
  if (ref === "") return label.usage;

  const chosen = await resolve(ref, metas);
  if (typeof chosen === "string") return chosen;

  try {
    const { meta, changed } = await metas.setStatus(chosen.id, target);
    return `${changed ? label.done : label.already}: ${meta.title}`;
  } catch (err) {
    if (err instanceof MetaNotFound) return "Meta não encontrada.";
    throw err;
  }
}

/** Devolve a meta escolhida, ou o texto da resposta (não encontrada, ambígua). */
async function resolve(ref: string, metas: MetaRepository): Promise<Meta | string> {
  let slug: string;
  try {
    slug = slugify(ref.replace(/^#/, ""));
  } catch {
    return "Referência sem letras ou números aproveitáveis.";
  }

  // ID completo: procura direto (permite repetir o comando numa meta já fechada, que dá no-op).
  const direct = await metas.find(slug);
  if (direct) return direct;

  // Trecho: entre as metas ainda abertas (ativas ou pausadas).
  const open = (await metas.list()).metas.filter((m) => m.status === "ativa" || m.status === "pausada");
  const matches = open.filter((m) => m.id.includes(slug));
  if (matches.length === 0) return "Meta não encontrada.";
  if (matches.length === 1) return matches[0]!;

  const shown = matches.slice(0, MAX_CANDIDATES).map((m) => `- ${m.id} (${m.title})`);
  const more = matches.length > MAX_CANDIDATES ? [`...e mais ${matches.length - MAX_CANDIDATES}`] : [];
  return ["Mais de uma meta corresponde. Seja mais específico:", ...shown, ...more].join("\n");
}

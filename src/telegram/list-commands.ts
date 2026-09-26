import type { TaskRepository } from "../domain/task-repository.js";
import type { Task } from "../domain/task.js";
import { currentWeek, today, weekdayOf, type Clock, type LocalDate } from "../time/index.js";

/**
 * Comandos de listagem. Só leem: /hoje e /semana mostram tarefas pendentes.
 * "Hoje" e "semana" vêm do Clock (src/time), nunca do Vault.
 */
const WEEKDAYS = ["", "segunda", "terça", "quarta", "quinta", "sexta", "sábado", "domingo"] as const;

const br = (d: LocalDate): string => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
const item = (t: Task): string => `- ${t.title}`;
const dated = (t: Task): string => `- ${t.title} (${br(t.due!)})`;
const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

function skippedNote(n: number): string[] {
  return n === 0 ? [] : ["", `Obs.: ${count(n, "nota ignorada por estar inválida", "notas ignoradas por estarem inválidas")}.`];
}

export async function cmdHoje(tasks: TaskRepository, clock: Clock): Promise<string> {
  const now = today(clock);
  const { tasks: pending, skipped } = await tasks.listPending();

  const overdue = pending.filter((t) => t.due && t.due < now);
  const dueToday = pending.filter((t) => t.due === now);
  const undated = pending.filter((t) => !t.due);
  const later = pending.length - overdue.length - dueToday.length - undated.length;

  const lines = [`Hoje, ${WEEKDAYS[weekdayOf(now)]} ${br(now)}`];
  if (overdue.length) lines.push("", `Atrasadas (${overdue.length}):`, ...overdue.map(dated));
  if (dueToday.length) lines.push("", `Para hoje (${dueToday.length}):`, ...dueToday.map(item));
  if (undated.length) lines.push("", `Sem prazo (${undated.length}):`, ...undated.map(item));
  if (!overdue.length && !dueToday.length) lines.push("", "Nada atrasado nem para hoje.");
  if (later > 0) lines.push("", `${count(later, "tarefa com prazo futuro", "tarefas com prazo futuro")}. Veja em /semana.`);
  return [...lines, ...skippedNote(skipped.length)].join("\n");
}

export async function cmdSemana(tasks: TaskRepository, clock: Clock): Promise<string> {
  const week = currentWeek(clock);
  const now = today(clock);
  const { tasks: pending, skipped } = await tasks.listPending();

  const overdue = pending.filter((t) => t.due && t.due < week.start);
  const undated = pending.filter((t) => !t.due);
  const after = pending.filter((t) => t.due && t.due > week.end).length;

  const lines = [`Semana ${br(week.start)} a ${br(week.end)}`];
  if (overdue.length) lines.push("", `Atrasadas (${overdue.length}):`, ...overdue.map(dated));
  for (const day of week.days) {
    const due = pending.filter((t) => t.due === day);
    if (!due.length) continue;
    lines.push("", `${WEEKDAYS[weekdayOf(day)]} ${br(day)}${day === now ? " (hoje)" : ""}:`, ...due.map(item));
  }
  if (undated.length) lines.push("", `Sem prazo (${undated.length}):`, ...undated.map(item));
  if (lines.length === 1) lines.push("", "Nada pendente nesta semana.");
  if (after > 0) lines.push("", `${count(after, "tarefa depois desta semana", "tarefas depois desta semana")}.`);
  return [...lines, ...skippedNote(skipped.length)].join("\n");
}

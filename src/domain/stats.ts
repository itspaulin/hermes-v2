import { addDays, localDateOfInstant, type LocalDate, type Week } from "../time/index.js";
import type { Meta } from "./meta.js";
import type { Task } from "./task.js";

/** Quantos dias à frente contam como "próximas". */
export const UPCOMING_DAYS = 7;

export interface DayContext {
  overdue: number;
  dueToday: number;
  upcoming: number;
}

/** Contagens do dia sobre as tarefas PENDENTES. "Hoje" vem de quem chama (Clock), nunca do Vault. */
export function dayContext(pending: readonly Task[], today: LocalDate): DayContext {
  const horizon = addDays(today, UPCOMING_DAYS);
  return {
    overdue: pending.filter((t) => t.due !== undefined && t.due < today).length,
    dueToday: pending.filter((t) => t.due === today).length,
    upcoming: pending.filter((t) => t.due !== undefined && t.due > today && t.due <= horizon).length,
  };
}

export interface MetaWeekStats {
  id: string;
  title: string;
  done: number;
  pending: number;
}

export interface WeekStats {
  created: number;
  done: number;
  /** Canceladas na semana: aproximado pelo `updated` da tarefa (o Vault não guarda a data do cancelamento). */
  cancelled: number;
  /** Pendentes agora, de qualquer prazo. */
  pending: number;
  /** Pendentes com prazo anterior a hoje. */
  overdue: number;
  /** Concluídas por dia, segunda a domingo, na ordem de `week.days`. */
  doneByDay: number[];
  /** Metas ativas (e as que tiveram conclusão na semana), com tarefas concluídas na semana e pendentes. */
  byMeta: MetaWeekStats[];
}

function dateOf(iso: string | undefined): LocalDate | undefined {
  return iso === undefined ? undefined : localDateOfInstant(iso);
}

const within = (d: LocalDate | undefined, week: Week): boolean => d !== undefined && d >= week.start && d <= week.end;

export function weekStats(tasks: readonly Task[], metas: readonly Meta[], week: Week, today: LocalDate): WeekStats {
  const doneInWeek = tasks.filter((t) => t.status === "feita" && within(dateOf(t.doneAt), week));
  const pending = tasks.filter((t) => t.status === "pendente");

  const byMeta: MetaWeekStats[] = [];
  for (const m of metas) {
    const done = doneInWeek.filter((t) => t.meta === m.id).length;
    const open = pending.filter((t) => t.meta === m.id).length;
    if (m.status === "ativa" || done > 0) byMeta.push({ id: m.id, title: m.title, done, pending: open });
  }

  return {
    created: tasks.filter((t) => within(dateOf(t.created), week)).length,
    done: doneInWeek.length,
    cancelled: tasks.filter((t) => t.status === "cancelada" && within(dateOf(t.updated), week)).length,
    pending: pending.length,
    overdue: pending.filter((t) => t.due !== undefined && t.due < today).length,
    doneByDay: week.days.map((day) => doneInWeek.filter((t) => dateOf(t.doneAt) === day).length),
    byMeta,
  };
}

import { PRODUCTIVITY } from "../config.js";
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
  /** Tarefas com prazo dentro da semana, exceto as canceladas: o que estava planejado. */
  planned: number;
  /** Dessas, quantas estão feitas. */
  plannedDone: number;
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
  const planned = tasks.filter((t) => t.status !== "cancelada" && within(t.due, week));

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
    planned: planned.length,
    plannedDone: planned.filter((t) => t.status === "feita").length,
    doneByDay: week.days.map((day) => doneInWeek.filter((t) => dateOf(t.doneAt) === day).length),
    byMeta,
  };
}

export type ProductivityLevel = "produtiva" | "razoavel" | "abaixo" | "sem_prazos" | "sem_atividade";

export interface Assessment {
  level: ProductivityLevel;
  /** plannedDone / planned, ou null se nada tinha prazo na semana. */
  rate: number | null;
  /** Uma linha pronta para mostrar. */
  text: string;
}

const pct = (r: number): string => `${Math.round(r * 100)}%`;
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * A avaliação da semana, por regra (sem IA): taxa de conclusão do que tinha prazo na semana,
 * comparada aos limites de PRODUCTIVITY. Sem nada com prazo, não há o que medir: só conta o feito.
 * Deve ser lida como fato calculado, não como julgamento de valor.
 */
export function assess(s: WeekStats): Assessment {
  if (s.planned === 0) {
    return s.done === 0
      ? { level: "sem_atividade", rate: null, text: "Sem atividade registrada na semana." }
      : {
          level: "sem_prazos",
          rate: null,
          text: `Nenhuma tarefa tinha prazo na semana, então não há taxa para medir. ${plural(s.done, "tarefa concluída", "tarefas concluídas")}.`,
        };
  }
  const rate = s.plannedDone / s.planned;
  const detail = `${s.plannedDone} de ${plural(s.planned, "tarefa planejada concluída", "tarefas planejadas concluídas")} (${pct(rate)})`;
  if (rate >= PRODUCTIVITY.productive) return { level: "produtiva", rate, text: `Semana produtiva: ${detail}.` };
  if (rate >= PRODUCTIVITY.reasonable) return { level: "razoavel", rate, text: `Semana razoável: ${detail}.` };
  return { level: "abaixo", rate, text: `Semana abaixo do planejado: ${detail}.` };
}

/** "8 concluídas, contra 5 na semana anterior (+3)." */
export function compareDone(done: number, previousDone: number): string {
  const diff = done - previousDone;
  const sign = diff > 0 ? `+${diff}` : diff < 0 ? `${diff}` : "igual";
  return `${done} concluídas, contra ${previousDone} na semana anterior (${sign}).`;
}

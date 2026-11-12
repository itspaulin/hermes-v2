import type { Checkin } from "../domain/checkin.js";
import type { Reminder } from "../domain/reminder.js";
import type { Task } from "../domain/task.js";
import { assess, compareDone, UPCOMING_DAYS, type DayContext, type WeekStats } from "../domain/stats.js";
import { weekdayOf, type LocalDate, type Week } from "../time/index.js";

/**
 * Textos dos check-ins agendados. Puro: recebe dados prontos, devolve strings.
 * O `body` vai para a nota do Vault (só na criação); o `message` vai para o Telegram.
 * A avaliação da semana é calculada por regra (assess, limites em src/config.ts), sem IA e sem
 * depender de nada que o usuário precise digitar; /metrica e /revisao são notas opcionais.
 */
const WEEKDAY_SHORT = ["", "seg", "ter", "qua", "qui", "sex", "sáb", "dom"] as const;
const br = (d: LocalDate): string => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

// ---------- Check-in diário ----------

const dayLines = (c: DayContext): string[] => [
  `Pendentes para hoje: ${c.dueToday}`,
  `Atrasadas: ${c.overdue}`,
  `Próximas (${UPCOMING_DAYS} dias): ${c.upcoming}`,
];

export function checkinBody(c: DayContext, date: LocalDate): string {
  return [`# Check-in ${br(date)}`, "", "## Contexto", "", ...dayLines(c).map((l) => `- ${l}`), "", "Resposta: campo `answer` acima (Telegram: /checkin)."].join("\n");
}

export function checkinMessage(c: DayContext, date: LocalDate): string {
  return [
    `Check-in de hoje (${WEEKDAY_SHORT[weekdayOf(date)]} ${br(date)})`,
    "",
    ...dayLines(c),
    "",
    "Como está indo hoje? O que você já fez e o que pretende fazer até o fim do dia?",
    "Responda com /checkin <texto>.",
  ].join("\n");
}

// ---------- Lembretes ----------

const MAX_REMINDER_TASKS = 10;

/** Texto do lembrete e, se ligado a uma meta, as pendências dela que vencem hoje ou estão atrasadas. */
export function reminderMessage(r: Reminder, due: readonly Task[], date: LocalDate): string {
  const lines = [`⏰ ${r.text}`];
  if (due.length > 0) {
    const sorted = [...due].sort((a, b) => (a.due! < b.due! ? -1 : a.due! > b.due! ? 1 : 0));
    lines.push("", `Pendências da meta ${r.meta} para hoje:`);
    for (const t of sorted.slice(0, MAX_REMINDER_TASKS)) {
      lines.push(`- ${t.title}${t.due! < date ? ` (atrasada, prazo ${br(t.due!)})` : ""}`);
    }
    if (sorted.length > MAX_REMINDER_TASKS) lines.push(`...e mais ${sorted.length - MAX_REMINDER_TASKS}`);
  }
  return lines.join("\n");
}

// ---------- Métricas (quinta) e revisão (sábado) ----------

function statLines(s: WeekStats, week: Week): string[] {
  const perDay = week.days.map((d, i) => `${WEEKDAY_SHORT[weekdayOf(d)]} ${s.doneByDay[i]}`).join(", ");
  const lines = [
    `Criadas: ${s.created}`,
    `Concluídas: ${s.done}`,
    `Canceladas: ${s.cancelled}`,
    `Pendentes: ${s.pending}`,
    `Atrasadas: ${s.overdue}`,
    `Concluídas por dia: ${perDay}`,
  ];
  return lines;
}

function metaLines(s: WeekStats): string[] {
  return s.byMeta.map((m) => `${m.title}: ${m.done} concluídas na semana, ${m.pending} pendentes`);
}

const period = (week: Week): string => `${br(week.start)} a ${br(week.end)}`;

/** Quinta-feira a semana ainda não acabou: mostra o andamento, sem veredito. */
function progressLines(s: WeekStats, previousDone: number): string[] {
  return [
    ...(s.planned > 0
      ? [`Andamento: ${s.plannedDone} de ${s.planned} ${s.planned === 1 ? "tarefa com prazo na semana concluída" : "tarefas com prazo na semana concluídas"} (${Math.round((s.plannedDone / s.planned) * 100)}%)`]
      : []),
    `Comparação: ${compareDone(s.done, previousDone)}`,
  ];
}

export function metricsBody(s: WeekStats, week: Week, previousDone: number): string {
  const metas = metaLines(s);
  return [
    `# Métricas da semana ${period(week)}`,
    "",
    "## Tarefas",
    "",
    ...statLines(s, week).map((l) => `- ${l}`),
    "",
    ...progressLines(s, previousDone),
    ...(metas.length ? ["", "## Metas", "", ...metas.map((l) => `- ${l}`)] : []),
    "",
    "Opcional: números que só você sabe (horas de estudo, candidaturas...) ficam no campo `answer` acima (Telegram: /metrica).",
  ].join("\n");
}

export function metricsMessage(s: WeekStats, week: Week, previousDone: number): string {
  const metas = metaLines(s);
  return [
    `Métricas da semana (${period(week)})`,
    "",
    ...statLines(s, week).map((l) => `• ${l}`),
    "",
    ...progressLines(s, previousDone),
    ...(metas.length ? ["", "Metas:", ...metas.map((l) => `• ${l}`)] : []),
    "",
    "Opcional, para o que só você sabe (horas de estudo, candidaturas...): /metrica 6h estudo, 7 candidaturas",
  ].join("\n");
}

export interface CheckinSummary {
  /** Check-ins diários da semana. */
  daily: Checkin[];
  metrics: Checkin | null;
}

export function reviewBody(s: WeekStats, week: Week, id: string, sum: CheckinSummary, previousDone: number): string {
  const answered = sum.daily.filter((c) => c.answer !== undefined);
  const metas = metaLines(s);
  return [
    `# Revisão semanal ${id}`,
    "",
    "## Período",
    "",
    period(week),
    "",
    "## Avaliação",
    "",
    assess(s).text,
    `Comparação: ${compareDone(s.done, previousDone)}`,
    "",
    "## Tarefas",
    "",
    ...statLines(s, week).map((l) => `- ${l}`),
    ...(metas.length ? ["", "## Metas", "", ...metas.map((l) => `- ${l}`)] : []),
    "",
    "## Check-ins",
    "",
    `${sum.daily.length} registrados, ${sum.daily.length - answered.length} sem resposta.`,
    ...answered.map((c) => `- ${br(c.date)}: ${c.answer}`),
    "",
    "## Métricas manuais",
    "",
    sum.metrics?.answer ?? "Sem registro.",
    "",
    "Opcional: uma nota sua sobre a semana fica no campo `answer` acima (Telegram: /revisao). O corpo abaixo é seu.",
  ].join("\n");
}

export function reviewMessage(s: WeekStats, week: Week, id: string, sum: CheckinSummary, previousDone: number): string {
  const answered = sum.daily.filter((c) => c.answer !== undefined).length;
  return [
    `Revisão semanal ${id} (${period(week)})`,
    "",
    assess(s).text,
    `Comparação: ${compareDone(s.done, previousDone)}`,
    "",
    `${s.done} concluídas, ${s.cancelled} canceladas, ${s.pending} pendentes e ${s.overdue} atrasadas.`,
    `Check-ins: ${answered} de ${sum.daily.length} respondidos.`,
    "",
    "A revisão completa está no Obsidian. Se quiser somar uma nota sua: /revisao <texto>",
  ].join("\n");
}

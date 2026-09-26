import type { Checkin } from "../domain/checkin.js";
import type { DayContext, WeekStats } from "../domain/stats.js";
import { UPCOMING_DAYS } from "../domain/stats.js";
import { weekdayOf, type LocalDate, type Week } from "../time/index.js";

/**
 * Textos dos check-ins agendados. Puro: recebe dados prontos, devolve strings.
 * O `body` vai para a nota do Vault (só na criação); o `message` vai para o Telegram.
 * O Hermes registra fatos; nunca avalia se a semana foi boa ou ruim.
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

export function metricsBody(s: WeekStats, week: Week): string {
  const metas = metaLines(s);
  return [
    `# Métricas da semana ${period(week)}`,
    "",
    "## Tarefas",
    "",
    ...statLines(s, week).map((l) => `- ${l}`),
    ...(metas.length ? ["", "## Metas", "", ...metas.map((l) => `- ${l}`)] : []),
    "",
    "Métricas manuais (horas de estudo, candidaturas...): campo `answer` acima (Telegram: /metrica).",
  ].join("\n");
}

export function metricsMessage(s: WeekStats, week: Week): string {
  const metas = metaLines(s);
  return [
    `Métricas da semana (${period(week)})`,
    "",
    ...statLines(s, week).map((l) => `• ${l}`),
    ...(metas.length ? ["", "Metas:", ...metas.map((l) => `• ${l}`)] : []),
    "",
    "Se quiser, registre as métricas que só você sabe (horas de estudo, candidaturas, conexões...):",
    "/metrica 6h estudo, 7 candidaturas",
  ].join("\n");
}

export interface CheckinSummary {
  /** Check-ins diários da semana. */
  daily: Checkin[];
  metrics: Checkin | null;
}

export function reviewBody(s: WeekStats, week: Week, id: string, sum: CheckinSummary): string {
  const answered = sum.daily.filter((c) => c.answer !== undefined);
  const metas = metaLines(s);
  return [
    `# Revisão semanal ${id}`,
    "",
    "## Período",
    "",
    period(week),
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
    "Sua revisão: campo `answer` acima (Telegram: /revisao). O corpo abaixo é seu.",
  ].join("\n");
}

export function reviewMessage(s: WeekStats, week: Week, id: string, sum: CheckinSummary): string {
  const answered = sum.daily.filter((c) => c.answer !== undefined).length;
  return [
    `Revisão semanal ${id} (${period(week)})`,
    "",
    `${s.done} concluídas, ${s.cancelled} canceladas, ${s.pending} pendentes e ${s.overdue} atrasadas.`,
    `Check-ins: ${answered} de ${sum.daily.length} respondidos.`,
    "",
    "A semana foi encerrada. O que você quer registrar sobre ela?",
    "Responda com /revisao <texto>.",
  ].join("\n");
}

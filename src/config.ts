import type { IsoWeekday, LocalTime } from "./time/index.js";

/**
 * Configuração dos horários do Hermes. Horários de parede em America/Sao_Paulo.
 * Alterar um horário = editar aqui, sem mexer na lógica.
 * Domingo é descanso: nenhuma entrada com weekday 7.
 */
export type ScheduleKind = "checkin" | "metrics" | "weekly_review";

export interface ScheduleEntry {
  kind: ScheduleKind;
  weekday: IsoWeekday;
  time: LocalTime;
}

const at = (weekday: IsoWeekday, time: string, kind: ScheduleKind): ScheduleEntry => ({
  kind,
  weekday,
  time: time as LocalTime,
});

export const SCHEDULES: readonly ScheduleEntry[] = [
  at(1, "14:00", "checkin"),
  at(2, "14:00", "checkin"),
  at(3, "14:00", "checkin"),
  at(4, "14:00", "metrics"),
  at(5, "14:00", "checkin"),
  at(6, "18:00", "weekly_review"),
];

/**
 * Como o Hermes avalia a semana (taxa = tarefas com prazo na semana que foram concluídas).
 * Alterar o rigor = editar aqui. Abaixo de `reasonable` a semana é "abaixo do planejado".
 */
export const PRODUCTIVITY = {
  /** Taxa mínima para "produtiva". */
  productive: 0.8,
  /** Taxa mínima para "razoável". */
  reasonable: 0.5,
} as const;

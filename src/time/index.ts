import { DateTime } from "luxon";
import type { Clock } from "./clock.js";

export { systemClock, fakeClock } from "./clock.js";
export type { Clock, FakeClock } from "./clock.js";

/**
 * Camada de tempo do Hermes. ÚNICO módulo autorizado a determinar
 * agora / hoje / amanhã / semana atual / datas derivadas.
 *
 * Regras:
 * - Timezone oficial é fixo: America/Sao_Paulo (nunca process.env.TZ).
 * - Instante = ISO 8601 com offset (ex.: 2026-09-25T14:30:00-03:00).
 * - Dia inteiro = LocalDate "YYYY-MM-DD", sem horário e sem fuso.
 * - Aritmética de LocalDate é feita em UTC, porque em zonas com horário de
 *   verão a meia-noite local pode não existir (o Brasil já teve isso).
 * - Datas vindas do Vault nunca definem "hoje": só o Clock define.
 */
export const TIMEZONE = "America/Sao_Paulo";

/** Data de calendário "YYYY-MM-DD". Crie via parseLocalDate ou funções deste módulo. */
export type LocalDate = string & { readonly __brand: "LocalDate" };

/** Horário de parede "HH:mm" (24h) no fuso oficial. */
export type LocalTime = string & { readonly __brand: "LocalTime" };

/** 1 = segunda ... 7 = domingo (ISO 8601). */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface Week {
  /** Segunda-feira. */
  start: LocalDate;
  /** Domingo (dia de descanso). */
  end: LocalDate;
  /** As 7 datas, segunda a domingo. */
  days: LocalDate[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// ---------- Agora / hoje / amanhã ----------

function nowInZone(clock: Clock): DateTime {
  const dt = DateTime.fromMillis(clock.nowMs(), { zone: TIMEZONE });
  if (!dt.isValid) throw new Error(`Clock inválido: ${clock.nowMs()}`);
  return dt;
}

/**
 * Instante atual como ISO 8601 com offset de America/Sao_Paulo, sempre com precisão de
 * segundos. (`suppressMilliseconds` do luxon só omite quando os ms são 0; por isso o
 * truncamento explícito, senão `updated`/`done_at` saíam com ".430" e `created` sem.)
 */
export function nowIso(clock: Clock): string {
  return nowInZone(clock).set({ millisecond: 0 }).toISO({ suppressMilliseconds: true })!;
}

/** Data de hoje em America/Sao_Paulo. */
export function today(clock: Clock): LocalDate {
  return nowInZone(clock).toISODate() as LocalDate;
}

export function tomorrow(clock: Clock): LocalDate {
  return addDays(today(clock), 1);
}

export function yesterday(clock: Clock): LocalDate {
  return addDays(today(clock), -1);
}

/** Horário de parede atual "HH:mm" em America/Sao_Paulo. */
export function timeOfDay(clock: Clock): LocalTime {
  return nowInZone(clock).toFormat("HH:mm") as LocalTime;
}

// ---------- LocalDate ----------

/** Valida e normaliza "YYYY-MM-DD". Rejeita datas inexistentes (ex.: 2026-02-30). */
export function parseLocalDate(input: string): LocalDate {
  if (!DATE_RE.test(input)) throw new Error(`Data inválida: ${input}`);
  const dt = DateTime.fromISO(input, { zone: "utc" });
  if (!dt.isValid || dt.toISODate() !== input) {
    throw new Error(`Data inexistente: ${input}`);
  }
  return input as LocalDate;
}

export function parseLocalTime(input: string): LocalTime {
  if (!TIME_RE.test(input)) throw new Error(`Horário inválido: ${input}`);
  return input as LocalTime;
}

function utcDate(date: LocalDate): DateTime {
  return DateTime.fromISO(parseLocalDate(date), { zone: "utc" });
}

export function addDays(date: LocalDate, days: number): LocalDate {
  return utcDate(date).plus({ days }).toISODate() as LocalDate;
}

/** Dias de calendário de a até b (b - a). */
export function diffDays(a: LocalDate, b: LocalDate): number {
  return Math.round(utcDate(b).diff(utcDate(a), "days").days);
}

export function weekdayOf(date: LocalDate): IsoWeekday {
  return utcDate(date).weekday as IsoWeekday;
}

export function isRestDay(date: LocalDate): boolean {
  return weekdayOf(date) === 7;
}

// ---------- Semana (segunda a domingo; domingo = descanso) ----------

export function weekOf(date: LocalDate): Week {
  const start = addDays(date, 1 - weekdayOf(date));
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  return { start, end: days[6]!, days };
}

/** Semana ISO 8601 da data, no formato dos arquivos de revisão: "2026-W39" (semana começa na segunda). */
export function isoWeekLabel(date: LocalDate): string {
  const dt = utcDate(date);
  return `${dt.weekYear}-W${String(dt.weekNumber).padStart(2, "0")}`;
}

export function currentWeek(clock: Clock): Week {
  return weekOf(today(clock));
}

// ---------- Instantes ----------

/**
 * Converte um instante de parede (data + horário em America/Sao_Paulo) em
 * ISO 8601 com offset. Falha se o horário não existir (lacuna de horário de verão).
 */
export function toInstantIso(date: LocalDate, time: LocalTime): string {
  parseLocalTime(time);
  const dt = DateTime.fromISO(`${parseLocalDate(date)}T${time}`, { zone: TIMEZONE });
  if (!dt.isValid || dt.toFormat("HH:mm") !== time) {
    throw new Error(`Horário inexistente em ${TIMEZONE}: ${date} ${time}`);
  }
  return dt.toISO({ suppressMilliseconds: true })!;
}

/** Segundos desde um instante em epoch seconds (ex.: message.date do Telegram). Negativo se estiver no futuro. */
export function secondsSince(clock: Clock, epochSeconds: number): number {
  return Math.floor(clock.nowMs() / 1000) - epochSeconds;
}

/** Data (em America/Sao_Paulo) de um instante ISO 8601 com offset. */
export function localDateOfInstant(iso: string): LocalDate {
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(iso)) {
    throw new Error(`Instante sem offset explícito: ${iso}`);
  }
  const dt = DateTime.fromISO(iso, { setZone: false }).setZone(TIMEZONE);
  if (!dt.isValid) throw new Error(`Instante inválido: ${iso}`);
  return dt.toISODate() as LocalDate;
}

// ---------- Tempo do evento (epoch do Telegram) ----------
//
// Distinção deliberada:
//   tempo do evento  = quando a mensagem foi enviada (message.date), vem de fora
//   tempo atual      = Clock (agora)
//   data civil       = LocalDate
// As funções abaixo são do primeiro grupo: NÃO recebem nem consultam o Clock.
// Um reenvio do mesmo update, horas depois, produz exatamente o mesmo resultado.

const MAX_EPOCH_SECONDS = 4_102_444_800; // 2100-01-01T00:00:00Z

function dateTimeOfEpochSeconds(epochSeconds: number): DateTime {
  if (!Number.isSafeInteger(epochSeconds) || epochSeconds < 0 || epochSeconds > MAX_EPOCH_SECONDS) {
    throw new Error(`Epoch em segundos inválido: ${epochSeconds}`);
  }
  return DateTime.fromSeconds(epochSeconds, { zone: TIMEZONE });
}

/** Data civil (America/Sao_Paulo) de um instante dado em epoch seconds. */
export function localDateOfEpochSeconds(epochSeconds: number): LocalDate {
  return dateTimeOfEpochSeconds(epochSeconds).toISODate() as LocalDate;
}

/** Instante ISO 8601 com offset de America/Sao_Paulo, dado em epoch seconds. */
export function instantIsoOfEpochSeconds(epochSeconds: number): string {
  return dateTimeOfEpochSeconds(epochSeconds).toISO({ suppressMilliseconds: true })!;
}

/** Valida um instante ISO 8601 com offset explícito e o devolve inalterado. */
export function parseInstantIso(iso: string): string {
  localDateOfInstant(iso); // lança se inválido ou sem offset
  return iso;
}

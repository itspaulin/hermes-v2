// Único ponto do Renato que lê o relógio do sistema e calcula datas.
export const TIMEZONE = "America/Sao_Paulo";

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function fixedClock(iso: string): Clock {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) throw new Error(`Instante inválido: ${iso}`);
  return { now: () => new Date(instant.getTime()) };
}

/** Instante em UTC, ex.: 2026-01-15T15:30:00.000Z */
export function utcIso(date: Date): string {
  return date.toISOString();
}

function partsInTimezone(date: Date): Record<string, string> {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "longOffset",
  });
  const out: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) out[p.type] = p.value;
  return out;
}

/** Data local (YYYY-MM-DD) em America/Sao_Paulo. */
export function localDate(date: Date): string {
  const p = partsInTimezone(date);
  return `${p.year}-${p.month}-${p.day}`;
}

/** ISO 8601 com offset de America/Sao_Paulo, ex.: 2026-01-15T12:30:00-03:00 */
export function localIso(date: Date): string {
  const p = partsInTimezone(date);
  const offset = (p.timeZoneName ?? "GMT").replace("GMT", "") || "+00:00";
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${offset}`;
}

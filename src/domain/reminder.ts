import { parseLocalTime, type IsoWeekday, type LocalTime } from "../time/index.js";
import { isSlug, slugify } from "../vault/slug.js";

/**
 * Lembrete recorrente definido pelo usuário: texto fixo em dias da semana e horário de parede
 * (America/Sao_Paulo). Pode ligar a uma meta: a mensagem traz as pendências dela que vencem
 * hoje ou estão atrasadas. Domingo é permitido (a regra de descanso vale para check-ins).
 */
export interface Reminder {
  /** Slug do texto; é também o nome do schedule. */
  id: string;
  /** Ordenados, sem repetição. */
  weekdays: IsoWeekday[];
  time: LocalTime;
  text: string;
  /** ID da meta ligada. */
  meta?: string;
}

export type ReminderDraft = Omit<Reminder, "id">;

export const MAX_REMINDERS = 20;
export const MAX_REMINDER_TEXT = 200;
const MAX_ID = 40;

/** Falha causada pelo pedido (limite, texto inválido...): vira resposta ao usuário. */
export class ReminderValidationError extends Error {
  override name = "ReminderValidationError";
}

/** Permissão/configuração do Scheduler: reenviar não adianta. */
export class ReminderApiError extends Error {
  override name = "ReminderApiError";
}

/** Scheduler indisponível ou limitando: vale tentar de novo. */
export class ReminderUnavailable extends Error {
  override name = "ReminderUnavailable";
}

/** O que o resto do Hermes precisa dos lembretes. Implementação: EventBridge Scheduler. */
export interface ReminderStore {
  list(): Promise<Reminder[]>;
  /** Cria com o id já escolhido (único). */
  create(reminder: Reminder): Promise<void>;
  /** false se não existia. */
  delete(id: string): Promise<boolean>;
}

const isWeekday = (v: unknown): v is IsoWeekday => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 7;

/** Normaliza e valida os campos de um lembrete. Null se inválido. */
export function reminderDraft(raw: unknown): ReminderDraft | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { weekdays, time, text, meta } = raw as Record<string, unknown>;
  if (!Array.isArray(weekdays) || weekdays.length === 0 || !weekdays.every(isWeekday)) return null;
  if (typeof time !== "string" || typeof text !== "string") return null;
  let t: LocalTime;
  try {
    t = parseLocalTime(time.length === 4 ? `0${time}` : time);
  } catch {
    return null;
  }
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean === "" || clean.length > MAX_REMINDER_TEXT || clean.startsWith("/")) return null;
  const days = [...new Set(weekdays)].sort((a, b) => a - b);
  if (meta === undefined || meta === null || meta === "") return { weekdays: days, time: t, text: clean };
  if (typeof meta !== "string" || meta.length > 60) return null;
  return { weekdays: days, time: t, text: clean, meta };
}

/** Lembrete completo (com id válido), ou null. Usado ao ler de volta o que foi gravado. */
export function parseReminder(raw: unknown): Reminder | null {
  const draft = reminderDraft(raw);
  const id = (raw as { id?: unknown } | null)?.id;
  if (!draft || typeof id !== "string" || !isSlug(id) || id.length > MAX_ID) return null;
  if (draft.meta !== undefined && !isSlug(draft.meta)) return null;
  return { id, ...draft };
}

/** Id novo a partir do texto, sem colidir com os existentes. */
export function reminderId(text: string, taken: readonly string[]): string {
  let base: string;
  try {
    base = slugify(text).slice(0, MAX_ID - 3).replace(/-+$/g, "");
  } catch {
    base = "lembrete";
  }
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) if (!taken.includes(`${base}-${n}`)) return `${base}-${n}`;
}

const sameDays = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((d, i) => d === b[i]);
const norm = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Mesmo texto, dias e horário: pedir de novo não cria outro (ex.: reenvio do Telegram). */
export function sameReminder(a: ReminderDraft, b: ReminderDraft): boolean {
  return norm(a.text) === norm(b.text) && a.time === b.time && sameDays(a.weekdays, b.weekdays) && a.meta === b.meta;
}

const CRON_DAYS = ["", "MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] as const;

/** Expressão do EventBridge Scheduler, no fuso oficial: cron(0 10 ? * TUE,THU,FRI *). */
export function cronOf(r: Pick<Reminder, "weekdays" | "time">): string {
  const [h, m] = r.time.split(":").map(Number);
  const days = r.weekdays.length === 7 ? "*" : r.weekdays.map((d) => CRON_DAYS[d]).join(",");
  return `cron(${m} ${h} ? * ${days} *)`;
}

const DAY_NAMES = ["", "seg", "ter", "qua", "qui", "sex", "sáb", "dom"] as const;

/** "ter, qui e sex às 10:00", "todo dia às 08:00", "seg a sex às 07:30". */
export function scheduleText(r: Pick<Reminder, "weekdays" | "time">): string {
  const d = r.weekdays;
  let days: string;
  if (d.length === 7) days = "todo dia";
  else if (sameDays(d, [1, 2, 3, 4, 5])) days = "seg a sex";
  else {
    const names = d.map((n) => DAY_NAMES[n]);
    days = names.length === 1 ? `${d[0]! >= 6 ? "todo" : "toda"} ${names[0]}` :`${names.slice(0, -1).join(", ")} e ${names.at(-1)}`;
  }
  return `${days} às ${r.time}`;
}

/** Uma linha para listas e confirmações. */
export function describeReminder(r: Reminder): string {
  return `${scheduleText(r)}: ${r.text}${r.meta ? ` (meta ${r.meta})` : ""} [${r.id}]`;
}

/** Lembretes cujo id ou texto contém o trecho. Id idêntico vence. */
export function matchReminders(ref: string, all: readonly Reminder[]): Reminder[] {
  const q = norm(ref.trim());
  if (q === "") return [];
  const exact = all.filter((r) => r.id === q);
  if (exact.length > 0) return exact;
  let slug = "";
  try {
    slug = slugify(ref);
  } catch {
    // sem letras/números: só o texto conta
  }
  return all.filter((r) => norm(r.text).includes(q) || (slug !== "" && r.id.includes(slug)));
}

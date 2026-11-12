import type { MetaRepository } from "../domain/meta-repository.js";
import {
  describeReminder,
  matchReminders,
  MAX_REMINDERS,
  reminderId,
  sameReminder,
  type ReminderDraft,
  type ReminderStore,
} from "../domain/reminder.js";
import { slugify } from "../vault/slug.js";

/**
 * Lembretes: criar (pela conversa), listar (/lembretes) e apagar (/apagarlembrete <trecho>).
 * Erros do Scheduler propagam e são classificados no webhook, como os do Notion.
 */
export const REMINDERS_OFF = "Lembretes não estão configurados neste ambiente.";

export interface ReminderDeps {
  reminders?: ReminderStore;
  metas: MetaRepository;
}

/** Resolve a meta pelo trecho entre as ativas. Devolve o ID, ou o texto da resposta. */
async function resolveMeta(ref: string, metas: MetaRepository): Promise<{ id: string } | string> {
  let slug: string;
  try {
    slug = slugify(ref.replace(/^#/, ""));
  } catch {
    return "Não entendi qual meta ligar ao lembrete.";
  }
  const active = (await metas.list()).metas.filter((m) => m.status === "ativa");
  const exact = active.filter((m) => m.id === slug);
  const matches = exact.length > 0 ? exact : active.filter((m) => m.id.includes(slug));
  if (matches.length === 1) return { id: matches[0]!.id };
  if (matches.length === 0) return `Não achei a meta "${ref}" entre as ativas. Nada foi criado.`;
  return [`Mais de uma meta corresponde a "${ref}". Nada foi criado. Qual delas?`, ...matches.map((m) => `- ${m.id} (${m.title})`)].join("\n");
}

export async function createReminder(draft: ReminderDraft, { reminders, metas }: ReminderDeps): Promise<string> {
  if (!reminders) return REMINDERS_OFF;
  let d = draft;
  if (draft.meta !== undefined) {
    const meta = await resolveMeta(draft.meta, metas);
    if (typeof meta === "string") return meta;
    d = { ...draft, meta: meta.id };
  }
  const all = await reminders.list();
  const same = all.find((r) => sameReminder(r, d));
  if (same) return `Esse lembrete já existe: ${describeReminder(same)}`;
  if (all.length >= MAX_REMINDERS) return `Você já tem ${all.length} lembretes (o máximo). Apague algum antes com /apagarlembrete <trecho>.`;

  const r = { id: reminderId(d.text, all.map((x) => x.id)), ...d };
  await reminders.create(r);
  return `Lembrete criado: ${describeReminder(r)}`;
}

export async function cmdLembretes({ reminders }: Pick<ReminderDeps, "reminders">): Promise<string> {
  if (!reminders) return REMINDERS_OFF;
  const all = await reminders.list();
  if (all.length === 0) return "Nenhum lembrete. Peça na conversa, por exemplo: \"toda segunda às 18h me lembra de revisar o inglês\".";
  return [`Lembretes (${all.length}):`, ...all.map((r) => `- ${describeReminder(r)}`), "", "Para apagar: /apagarlembrete <trecho>"].join("\n");
}

export async function cmdApagarLembrete(ref: string, { reminders }: Pick<ReminderDeps, "reminders">): Promise<string> {
  if (!reminders) return REMINDERS_OFF;
  if (ref.trim() === "") return "Uso: /apagarlembrete <id-ou-trecho>";
  const matches = matchReminders(ref, await reminders.list());
  if (matches.length === 0) return "Não achei esse lembrete. Veja a lista com /lembretes.";
  if (matches.length > 1) {
    return ["Mais de um lembrete corresponde. Seja mais específico:", ...matches.map((r) => `- ${describeReminder(r)}`)].join("\n");
  }
  const r = matches[0]!;
  const deleted = await reminders.delete(r.id);
  return deleted ? `Lembrete apagado: ${describeReminder(r)}` : "Esse lembrete já não existia.";
}

import type { CheckinRepository } from "../domain/checkin-repository.js";
import type { MetaRepository } from "../domain/meta-repository.js";
import type { ReviewRepository } from "../domain/review-repository.js";
import { dayContext, weekStats } from "../domain/stats.js";
import type { TaskRepository } from "../domain/task-repository.js";
import { SCHEDULES, type ScheduleKind } from "../config.js";
import type { TelegramClient } from "../telegram/client.js";
import { currentWeek, isoWeekLabel, today, weekdayOf, type Clock } from "../time/index.js";
import {
  checkinBody,
  checkinMessage,
  metricsBody,
  metricsMessage,
  reviewBody,
  reviewMessage,
  type CheckinSummary,
} from "./render.js";

/** Evento do EventBridge Scheduler (Input estático definido no template.yaml). */
export interface ScheduledEvent {
  kind: ScheduleKind;
  /** Só para teste manual: ignora o calendário de SCHEDULES. */
  force?: boolean;
}

export interface ScheduleDeps {
  clock: Clock;
  tasks: TaskRepository;
  metas: MetaRepository;
  checkins: CheckinRepository;
  reviews: ReviewRepository;
  client: Pick<TelegramClient, "sendMessage">;
  chatIds: readonly number[];
}

const KINDS: readonly string[] = ["checkin", "metrics", "weekly_review"] satisfies ScheduleKind[];

/** Reconhece o evento do Scheduler. Null se não for (ex.: evento do API Gateway). */
export function parseScheduledEvent(event: unknown): ScheduledEvent | null {
  if (typeof event !== "object" || event === null) return null;
  const { kind, force } = event as { kind?: unknown; force?: unknown };
  if (typeof kind !== "string" || !KINDS.includes(kind)) return null;
  return { kind: kind as ScheduleKind, ...(force === true && { force: true }) };
}

/**
 * Cria a nota do slot (criar-se-não-existir) e avisa no Telegram. Devolve o resultado para o log.
 * Falha de Vault ou de Telegram propaga: o Scheduler tenta de novo, e como criar é idempotente,
 * a nova tentativa só reenvia a mensagem. Slot já respondido: não reenvia.
 */
export async function runScheduled(ev: ScheduledEvent, deps: ScheduleDeps): Promise<string> {
  const { clock, tasks, metas, checkins, reviews } = deps;
  const date = today(clock);

  // Calendário: só SCHEDULES manda. Domingo não tem entrada, logo nada automático acontece.
  if (!ev.force && !SCHEDULES.some((s) => s.kind === ev.kind && s.weekday === weekdayOf(date))) {
    return `ignorado: ${ev.kind} não está agendado para ${date}`;
  }

  const send = async (text: string): Promise<void> => {
    for (const chat of deps.chatIds) await deps.client.sendMessage(chat, text);
  };

  switch (ev.kind) {
    case "checkin": {
      const { tasks: pending } = await tasks.listPending();
      const ctx = dayContext(pending, date);
      const { checkin } = await checkins.open({ kind: "checkin", date, body: checkinBody(ctx, date) });
      if (checkin.answer !== undefined) return `check-in ${checkin.id} já respondido`;
      await send(checkinMessage(ctx, date));
      return `check-in ${checkin.id} enviado`;
    }
    case "metrics": {
      const week = currentWeek(clock);
      const [{ tasks: all }, { metas: allMetas }] = await Promise.all([tasks.listAll(), metas.list()]);
      const stats = weekStats(all, allMetas, week, date);
      const { checkin } = await checkins.open({ kind: "metrics", date, body: metricsBody(stats, week) });
      if (checkin.answer !== undefined) return `métricas ${checkin.id} já respondidas`;
      await send(metricsMessage(stats, week));
      return `métricas ${checkin.id} enviadas`;
    }
    case "weekly_review": {
      const week = currentWeek(clock);
      const [{ tasks: all }, { metas: allMetas }, { checkins: weekCheckins }] = await Promise.all([
        tasks.listAll(),
        metas.list(),
        checkins.listBetween(week.start, week.end),
      ]);
      const stats = weekStats(all, allMetas, week, date);
      const id = isoWeekLabel(week.start);
      const summary: CheckinSummary = {
        daily: weekCheckins.filter((c) => c.kind === "checkin"),
        metrics: weekCheckins.find((c) => c.kind === "metrics") ?? null,
      };
      const { review } = await reviews.open({ weekStart: week.start, body: reviewBody(stats, week, id, summary) });
      if (review.answer !== undefined) return `revisão ${review.id} já respondida`;
      await send(reviewMessage(stats, week, id, summary));
      return `revisão ${review.id} enviada`;
    }
  }
}

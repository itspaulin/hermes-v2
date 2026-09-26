import type { CheckinRepository } from "../domain/checkin-repository.js";
import type { CheckinKind } from "../domain/checkin.js";
import type { ReviewRepository } from "../domain/review-repository.js";
import { today, type Clock, type LocalDate } from "../time/index.js";

/**
 * Respostas aos check-ins agendados. A intenção é explícita no comando, então o Hermes
 * nunca adivinha a que documento você responde:
 *
 *   /checkin <texto>   check-in diário mais recente sem resposta (últimos 7 dias)
 *   /metrica <texto>   métricas da quinta mais recentes sem resposta
 *   /revisao <texto>   revisão da semana (atual ou anterior) sem resposta
 */
const br = (d: LocalDate): string => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

const CHECKIN_LABELS = {
  checkin: { usage: "Uso: /checkin <texto>", name: "Check-in", none: "Nenhum check-in aguardando resposta." },
  metrics: { usage: "Uso: /metrica <texto>", name: "Métricas", none: "Nenhuma métrica aguardando resposta." },
} as const;

export async function cmdResponderCheckin(
  kind: CheckinKind,
  args: string,
  checkins: CheckinRepository,
  clock: Clock,
): Promise<string> {
  const label = CHECKIN_LABELS[kind];
  if (args.trim() === "") return label.usage;

  const target = await checkins.targetFor(kind, today(clock), args);
  if (!target) return label.none;

  const { checkin, changed } = await checkins.answer(target, args);
  return `${label.name} de ${br(checkin.date)} ${changed ? "registrado" : "já estava registrado"}.`;
}

export async function cmdRevisao(args: string, reviews: ReviewRepository, clock: Clock): Promise<string> {
  if (args.trim() === "") return "Uso: /revisao <texto>";

  const target = await reviews.targetFor(today(clock), args);
  if (!target) return "Nenhuma revisão aguardando resposta.";

  const { review, changed } = await reviews.answer(target, args);
  return `Revisão ${review.id} ${changed ? "registrada" : "já estava registrada"}.`;
}

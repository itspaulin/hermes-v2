import type { CheckinRepository } from "../domain/checkin-repository.js";
import type { ReviewRepository } from "../domain/review-repository.js";
import type { MetaRepository } from "../domain/meta-repository.js";
import type { TaskRepository } from "../domain/task-repository.js";
import { nowIso, type Clock } from "../time/index.js";
import type { HermesConversation } from "../ai/hermes.js";
import { answerByText } from "./meta-answer.js";
import { asReply, type RouteResult } from "./reply.js";
import type { TelegramMessage } from "./types.js";
import { cmdHoje, cmdSemana } from "./list-commands.js";
import { cmdResponderCheckin, cmdRevisao } from "./report-commands.js";
import { cmdMeta, cmdMetas, cmdMudarStatusMeta } from "./meta-commands.js";
import { cmdMudarStatus, cmdTarefa } from "./task-commands.js";

export interface RouterDeps {
  clock: Clock;
  tasks: TaskRepository;
  metas: MetaRepository;
  checkins: CheckinRepository;
  reviews: ReviewRepository;
  /** Conversa natural para texto solto. Ausente = IA desligada: o texto solto recebe só a ajuda. */
  converse?: HermesConversation;
  /** Chat da mensagem, para a memória da conversa. */
  chatId?: number;
}

const COMMANDS_HELP = "Comandos: /tarefa, /feita, /cancelar, /hoje, /semana, /meta, /metas, /metafeita, /metacancelar, /checkin, /metrica, /revisao, /ping";
const COMMAND_RE = /^\/([a-zA-Z0-9_]+)(?:@[a-zA-Z0-9_]+)?(?:\s+([\s\S]*))?$/;

/** Comando e argumentos de um texto "/comando args", ou null se não começa com "/comando". */
export function parseCommandLine(text: string): { name: string; args: string } | null {
  const m = COMMAND_RE.exec(text.trim());
  return m ? { name: m[1]!.toLowerCase(), args: (m[2] ?? "").trim() } : null;
}

/** Nome do comando em minúsculas, ou null se o texto não começa com "/comando". */
export function parseCommand(text: string): string | null {
  return parseCommandLine(text)?.name ?? null;
}

/**
 * Devolve a resposta para um texto recebido (`replyTo`: a mensagem à qual ele responde, se houver). `eventEpochSeconds` é o `message.date` do
 * Telegram: define a data das tarefas (nunca o relógio). Erros de infraestrutura propagam.
 */
export async function routeMessage(
  text: string,
  eventEpochSeconds: number | undefined,
  { clock, tasks, metas, checkins, reviews, converse, chatId }: RouterDeps,
  replyTo?: TelegramMessage,
  inBatch = false,
): Promise<RouteResult> {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  if (!inBatch && lines.length > 1 && lines.every((l) => parseCommandLine(l) !== null)) {
    // Vários comandos colados na mesma mensagem: cada linha é um comando. Em lote não há pergunta de meta.
    const deps = { clock, tasks, metas, checkins, reviews };
    const texts: string[] = [];
    for (const line of lines) texts.push(asReply(await routeMessage(line, eventEpochSeconds, deps, undefined, true)).text);
    return texts.join("\n\n");
  }

  const cmd = parseCommandLine(text);
  if (!cmd) {
    // Texto solto só tem contexto se for resposta (reply) a uma pergunta do próprio Hermes.
    const answered = replyTo ? await answerByText(text, replyTo, { clock, tasks, metas }) : null;
    if (answered) return answered;
    return converse ? converse(text, eventEpochSeconds, chatId) : `Envie um comando. ${COMMANDS_HELP}`;
  }

  switch (cmd.name) {
    case "start":
      return [
        "Hermes online.",
        "",
        "Tarefas: /tarefa <título> [até AAAA-MM-DD], /feita, /cancelar, /hoje, /semana",
        "Metas: /meta <título> [até AAAA-MM-DD], /metas, /metafeita, /metacancelar",
        "Respostas: /checkin, /metrica, /revisao",
        "Conexão: /ping",
      ].join("\n");
    case "ping":
      return `pong ${nowIso(clock)}`;
    case "tarefa":
      return cmdTarefa(cmd.args, eventEpochSeconds, { tasks, metas }, !inBatch);
    case "feita":
      return cmdMudarStatus("feita", cmd.args, tasks);
    case "cancelar":
      return cmdMudarStatus("cancelada", cmd.args, tasks);
    case "meta":
      return cmdMeta(cmd.args, eventEpochSeconds, metas);
    case "metas":
      return cmdMetas(metas, tasks);
    case "metafeita":
      return cmdMudarStatusMeta("concluida", cmd.args, metas);
    case "metacancelar":
      return cmdMudarStatusMeta("cancelada", cmd.args, metas);
    case "checkin":
      return cmdResponderCheckin("checkin", cmd.args, checkins, clock);
    case "metrica":
      return cmdResponderCheckin("metrics", cmd.args, checkins, clock);
    case "revisao":
      return cmdRevisao(cmd.args, reviews, clock);
    case "hoje":
      return cmdHoje(tasks, metas, clock);
    case "semana":
      return cmdSemana(tasks, metas, clock);
    default:
      return `Comando desconhecido: /${cmd.name}. ${COMMANDS_HELP}`;
  }
}

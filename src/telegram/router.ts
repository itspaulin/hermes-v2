import type { TaskRepository } from "../domain/task-repository.js";
import { nowIso, type Clock } from "../time/index.js";
import { cmdMudarStatus, cmdTarefa } from "./task-commands.js";

export interface RouterDeps {
  clock: Clock;
  tasks: TaskRepository;
}

const COMMANDS_HELP = "Comandos: /tarefa, /feita, /cancelar, /ping";
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
 * Devolve a resposta para um texto recebido. `eventEpochSeconds` é o `message.date` do
 * Telegram: define a data das tarefas (nunca o relógio). Erros de infraestrutura propagam.
 */
export async function routeMessage(
  text: string,
  eventEpochSeconds: number | undefined,
  { clock, tasks }: RouterDeps,
): Promise<string> {
  const cmd = parseCommandLine(text);
  if (!cmd) return `Envie um comando. ${COMMANDS_HELP}`;

  switch (cmd.name) {
    case "start":
      return "Hermes online.\n\nUse /ping para testar a conexão.";
    case "ping":
      return `pong ${nowIso(clock)}`;
    case "tarefa":
      return cmdTarefa(cmd.args, eventEpochSeconds, tasks);
    case "feita":
      return cmdMudarStatus("feita", cmd.args, tasks);
    case "cancelar":
      return cmdMudarStatus("cancelada", cmd.args, tasks);
    default:
      return `Comando desconhecido: /${cmd.name}. ${COMMANDS_HELP}`;
  }
}

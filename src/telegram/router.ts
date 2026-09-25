import { nowIso, type Clock } from "../time/index.js";

const COMMAND_RE = /^\/([a-zA-Z0-9_]+)(?:@[a-zA-Z0-9_]+)?(?:\s|$)/;

/** Nome do comando em minúsculas, ou null se o texto não começa com "/comando". */
export function parseCommand(text: string): string | null {
  const m = COMMAND_RE.exec(text.trim());
  return m ? m[1]!.toLowerCase() : null;
}

/** Devolve a resposta para um texto recebido. Puro: sem I/O. */
export function routeText(text: string, clock: Clock): string {
  const command = parseCommand(text);
  switch (command) {
    case null:
      return "Envie um comando. Disponíveis: /start, /ping";
    case "start":
      return "Hermes online.\n\nUse /ping para testar a conexão.";
    case "ping":
      return `pong ${nowIso(clock)}`;
    default:
      return `Comando desconhecido: /${command}. Disponíveis: /start, /ping`;
  }
}

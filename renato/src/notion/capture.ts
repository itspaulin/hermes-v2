import { localIso } from "../clock.js";
import { paragraph, MAX_BLOCKS_PER_REQUEST } from "./blocks.js";
import type { NotasRepository } from "./notas.js";
import type { TemaRepository } from "./temas.js";
import type { TurnInput } from "./assistant.js";

/**
 * Captura sem modelo: o texto exato do usuário vira uma nota na Caixa de entrada (`/anotar <texto>`, ou
 * qualquer texto quando a IA está desligada). Título = primeira linha. Idempotente pelo ID da mensagem.
 */
export function createVerbatimCapture({ temas, notas }: { temas: TemaRepository; notas: NotasRepository }) {
  return async ({ text, chatId, messageId, epochSeconds }: TurnInput): Promise<string> => {
    const createdAt = localIso(new Date(epochSeconds * 1000));
    const inbox = await temas.inbox(createdAt);
    const firstLine = text.split(/\r?\n/).find((l) => l.trim() !== "") ?? "Nota";
    const title = firstLine.replace(/\s+/g, " ").trim().slice(0, 80) || "Nota";
    const blocks = text.split(/\r?\n/).map((l) => paragraph(l === "" ? " " : l)).slice(0, MAX_BLOCKS_PER_REQUEST * 5);
    const { nota, created } = await notas.create({
      id: `telegram-${chatId}-${messageId}`,
      title,
      summary: "",
      tipo: "resumo",
      origem: "texto",
      temaPageId: inbox.pageId,
      createdAt,
      blocks,
    });
    return `${created ? "Anotei na Caixa de entrada" : "Essa nota já existia"}: ${nota.title}${nota.url ? `\n${nota.url}` : ""}`;
  };
}

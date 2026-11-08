import { localIso } from "../clock.js";
import { NotionApiError } from "../../../shared/notion/errors.js";
import { imageBlock, paragraph, MAX_BLOCKS_PER_REQUEST } from "./blocks.js";
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

/**
 * Captura de imagem sem modelo: `/guardar` na legenda (ou qualquer imagem quando a IA está desligada).
 * A imagem vai para a Caixa de entrada; título = primeira linha da legenda, ou "Imagem DD/MM/AAAA".
 */
export function createImageCapture({ temas, notas, upload }: { temas: TemaRepository; notas: NotasRepository; upload: (filename: string, contentType: string, bytes: Uint8Array) => Promise<string> }) {
  return async ({ text, image, chatId, messageId, epochSeconds }: TurnInput): Promise<string> => {
    if (!image) return "Não recebi nenhuma imagem.";
    const createdAt = localIso(new Date(epochSeconds * 1000));
    const id = `telegram-${chatId}-${messageId}`;
    const existing = await notas.find(id);
    if (existing) return `Essa nota já existia: ${existing.title}${existing.url ? `\n${existing.url}` : ""}`;

    const inbox = await temas.inbox(createdAt);
    const caption = text.trim();
    const title = (caption.split(/\r?\n/)[0] ?? "").replace(/\s+/g, " ").trim().slice(0, 80) || `Imagem ${createdAt.slice(8, 10)}/${createdAt.slice(5, 7)}/${createdAt.slice(0, 4)}`;
    let uploadId: string | undefined;
    let notice = "";
    try {
      uploadId = await upload(image.filename, image.contentType, image.bytes);
    } catch (err) {
      if (!(err instanceof NotionApiError)) throw err;
      notice = "\nNão consegui anexar a imagem na página (o Notion recusou o arquivo).";
    }
    const blocks = [...(uploadId ? [imageBlock(uploadId)] : []), ...(caption === "" ? [] : caption.split(/\r?\n/).map((l) => paragraph(l === "" ? " " : l)))];
    const { nota } = await notas.create({ id, title, summary: "", tipo: "resumo", origem: "imagem", temaPageId: inbox.pageId, createdAt, blocks });
    return `Guardei a imagem na Caixa de entrada: ${nota.title}${notice}${nota.url ? `\n${nota.url}` : ""}`;
  };
}

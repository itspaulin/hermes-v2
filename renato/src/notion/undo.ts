import type { NotasRepository } from "./notas.js";
import type { TemaRepository } from "./temas.js";

/**
 * O que o Renato fez e como desfazer. Cada ação do modelo que muda o Notion grava UMA entrada; "desfaz"
 * desfaz a mais recente. Desfazer nunca apaga de verdade: páginas e blocos vão para a lixeira do Notion.
 */
export type UndoEntry =
  | { kind: "create_note"; pageId: string; title: string; /** tema criado junto com a nota, se foi o caso */ temaPageId?: string }
  | { kind: "append"; pageId: string; title: string; blockIds: string[] }
  | { kind: "create_tema"; pageId: string; name: string }
  | { kind: "move_note"; noteId: string; title: string; fromTemaPageId: string; /** tema criado junto, se foi o caso */ temaPageId?: string }
  | { kind: "delete_tema"; pageId: string; name: string; movedNoteIds: string[]; subtemaPageIds: string[] }
  | { kind: "delete_note"; pageId: string; title: string };

/** Registro das ações desfazíveis (Neon). Falha aberta: sem registro, o Renato age normalmente mas não consegue desfazer. */
export interface UndoLog {
  /** Já registrei uma ação para esta mensagem? (reenvio do Telegram não repete complemento nem exclusão) */
  has(chatId: number, messageId: number): Promise<boolean>;
  record(chatId: number, messageId: number, entry: UndoEntry): Promise<void>;
  /**
   * A entrada mais recente (últimas 24 h), removendo-a do registro. `repeat`: esta mesma mensagem já
   * desfez algo (reenvio do Telegram): nunca desfaz uma segunda ação por causa de um retry.
   */
  pop(chatId: number, messageId: number): Promise<{ status: "entry"; entry: UndoEntry } | { status: "empty" } | { status: "repeat" }>;
}

/** Desfaz uma entrada e devolve o texto da resposta ao usuário. */
export async function undoEntry(entry: UndoEntry, { temas, notas }: { temas: TemaRepository; notas: NotasRepository }): Promise<string> {
  switch (entry.kind) {
    case "create_note": {
      await notas.archive(entry.pageId);
      const extra = await dropEmptyTema(entry.temaPageId);
      return `Desfiz: a nota "${entry.title}" foi para a lixeira do Notion.${extra}`;
    }
    case "append":
      await notas.deleteBlocks(entry.blockIds);
      return `Desfiz: tirei o complemento que acrescentei na nota "${entry.title}".`;
    case "create_tema": {
      const kept = await temaStillUsed(entry.pageId);
      if (kept) return `O tema ${entry.name} já tem notas ou subtemas, então não o removi. Se quiser, peça para excluir.`;
      await temas.archive(entry.pageId);
      return `Desfiz: o tema ${entry.name} foi para a lixeira do Notion.`;
    }
    case "move_note": {
      await notas.setTema(entry.noteId, entry.fromTemaPageId);
      const extra = await dropEmptyTema(entry.temaPageId);
      return `Desfiz: devolvi a nota "${entry.title}" ao tema de antes.${extra}`;
    }
    case "delete_tema": {
      await temas.unarchive(entry.pageId);
      for (const sub of entry.subtemaPageIds) await temas.setParent(sub, entry.pageId);
      for (const noteId of entry.movedNoteIds) await notas.setTema(noteId, entry.pageId);
      return `Desfiz: o tema ${entry.name} voltou${entry.movedNoteIds.length > 0 ? `, com ${entry.movedNoteIds.length} nota(s)` : ""}.`;
    }
    case "delete_note":
      await notas.unarchive(entry.pageId);
      return `Desfiz: a nota "${entry.title}" voltou.`;
  }

  async function temaStillUsed(pageId: string): Promise<boolean> {
    const [inTema, all] = await Promise.all([notas.search({ temaPageIds: [pageId], limit: 1 }), temas.list()]);
    return inTema.length > 0 || all.some((t) => t.parentPageId === pageId);
  }
  /** Tema criado junto com a ação que está sendo desfeita: some se ficou vazio. */
  async function dropEmptyTema(pageId: string | undefined): Promise<string> {
    if (pageId === undefined || (await temaStillUsed(pageId))) return "";
    await temas.archive(pageId);
    return " O tema que ela tinha criado, vazio, também foi para a lixeira.";
  }
}

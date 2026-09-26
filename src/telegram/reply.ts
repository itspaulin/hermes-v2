import type { InlineKeyboard } from "./client.js";

/** Resposta a uma mensagem. Texto simples para a maioria dos comandos. */
export interface Reply {
  text: string;
  /** Botões da resposta (inline keyboard). */
  keyboard?: InlineKeyboard;
  /** Mensagem anterior do bot a reescrever (some com os botões dela). Melhor esforço. */
  closes?: { messageId: number; text: string };
}

/** O que um comando devolve: só o texto, ou uma resposta com botões. */
export type RouteResult = string | Reply;

export const asReply = (r: RouteResult): Reply => (typeof r === "string" ? { text: r } : r);

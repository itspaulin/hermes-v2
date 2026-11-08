import { localIso } from "../clock.js";
import type { TurnInput } from "./assistant.js";
import { descendants, listNotas, temaTree } from "./format.js";
import type { NotasRepository } from "./notas.js";
import { INBOX_NAME, TemaError, findIn, temaPath, type TemaRepository } from "./temas.js";

export const TEMA_USAGE = "Uso: /tema <nome> cria o tema (ou /tema Pai > Filho para um subtema). Respondendo à mensagem de uma nota, move a nota para esse tema.";
export const NOTAS_USAGE = "Uso: /notas lista as recentes; /notas <tema> lista as notas do tema; /notas <texto> busca no título e no resumo.";

/** ID da página do Notion no fim de um link ("…-<32 hex>"), ou null. */
export function pageIdFromText(text: string | undefined): string | null {
  const m = text ? /notion\.(?:so|com)\/\S*?([0-9a-f]{32})(?:[?#\s]|$)/i.exec(text) : null;
  return m ? m[1]!.toLowerCase() : null;
}

export interface NotionCommands {
  /** `replyText`: texto da mensagem à qual o usuário respondeu, se houver. */
  tema(turn: TurnInput, args: string, replyText?: string): Promise<string>;
  notas(args: string): Promise<string>;
}

/**
 * Comandos sem modelo. `/tema` cria temas e, em resposta a uma mensagem com o link de uma nota, move a
 * nota. `/notas` lista as recentes, as de um tema (com subtemas) ou busca por texto.
 */
export function createNotionCommands({ temas: temaRepo, notas }: { temas: TemaRepository; notas: NotasRepository }): NotionCommands {
  return {
    async tema(turn, args, replyText) {
      const createdAt = localIso(new Date(turn.epochSeconds * 1000));
      const names = args.split(">").map((n) => n.replace(/\s+/g, " ").trim());
      if (args.trim() === "") {
        const all = await temaRepo.list();
        return all.length === 0 ? `Ainda não há temas. ${TEMA_USAGE}` : ["Temas:", ...temaTree(all), "", TEMA_USAGE].join("\n");
      }
      if (names.some((n) => n === "")) return TEMA_USAGE;

      try {
        // "Pai > Filho > Neto": cada nível nasce dentro do anterior. A Caixa de entrada nunca é pai.
        let parentId: string | undefined;
        const created: string[] = [];
        let tema;
        for (const name of names) {
          const r = await temaRepo.ensure(name, createdAt, parentId);
          if (r.created) created.push(r.tema.name);
          tema = r.tema;
          parentId = r.tema.id;
        }
        const all = await temaRepo.list();
        const path = temaPath(all, tema!);
        const lines = [created.length > 0 ? `Criei o tema ${path}.` : `O tema ${path} já existia.`];

        const pageId = pageIdFromText(replyText);
        if (pageId !== null) {
          const nota = await notas.findByPageId(pageId, all);
          if (nota === null) lines.push("Não reconheci a nota da mensagem que você respondeu, então não movi nada.");
          else if (nota.temaId === tema!.id) lines.push(`A nota "${nota.title}" já está nesse tema.`);
          else {
            await notas.setTema(nota.id, tema!.pageId, all);
            lines.push(`Movi "${nota.title}" para esse tema.`);
          }
        }
        return lines.join("\n");
      } catch (err) {
        if (err instanceof TemaError) return err.message;
        throw err;
      }
    },

    async notas(args) {
      const temas = await temaRepo.list();
      const query = args.trim();
      if (query === "") {
        const recent = await notas.recent(10, temas);
        return recent.length === 0 ? "Você ainda não tem notas." : listNotas(temas, recent);
      }
      const tema = findIn(temas, query);
      const found = tema
        ? await notas.search({ temaPageIds: descendants(temas, tema).map((t) => t.pageId), limit: 11, temas })
        : await notas.search({ text: query, limit: 11, temas });
      if (found.length > 0) return listNotas(temas, found);
      return tema ? `Não há notas no tema ${temaPath(temas, tema)}.` : `Não achei nada para "${query}". ${tema === null && query.length < 2 ? NOTAS_USAGE : ""}`.trim();
    },
  };
}

export { INBOX_NAME };

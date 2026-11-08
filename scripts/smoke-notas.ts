import { createNotionClient } from "../shared/notion/client.js";
import { complementBlocks, noteBlocks } from "../renato/src/notion/blocks.js";
import { normalizeDiagram, normalizeMindMap } from "../renato/src/notion/diagram.js";
import { NotasRepository } from "../renato/src/notion/notas.js";
import { TemaRepository } from "../renato/src/notion/temas.js";
import { createSsmReader } from "../src/ssm.js";

/**
 * Teste REAL contra os bancos Temas e Notas: cria tema, subtema e uma nota (com diagrama e mapa
 * mental em Mermaid), complementa, busca, move de tema, e ARQUIVA o que criou (lixeira do Notion).
 * Deixa as páginas abertas se KEEP=1, para você ver como o Notion renderiza o Mermaid.
 *   NOTION_TEMAS_DB=... NOTION_NOTAS_DB=... [KEEP=1] npm run smoke:notas
 */
const need = (k: string): string => {
  const v = process.env[k]?.trim();
  if (!v) throw new Error(`Defina ${k}`);
  return v;
};
const token = await createSsmReader().get(process.env.NOTION_TOKEN_PARAM ?? "/hermes/prod/notion/token");
const client = createNotionClient({ token });
const temas = new TemaRepository(client, need("NOTION_TEMAS_DB"));
const notas = new NotasRepository(client, need("NOTION_NOTAS_DB"), temas);

const run = `smoke-${Date.now().toString(36)}`;
const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
const created: string[] = [];
const ok = (cond: boolean, what: string) => {
  console.log(`${cond ? "ok  " : "FALHOU"} ${what}`);
  if (!cond) process.exitCode = 1;
};

try {
  const pai = await temas.ensure(`Tema ${run}`, now);
  const filho = await temas.ensure(`Subtema ${run}`, now, pai.tema.id);
  created.push(pai.tema.pageId, filho.tema.pageId);
  ok(pai.created && filho.created && filho.tema.parentId === pai.tema.id, "cria tema e subtema (relação com o pai)");
  ok(!(await temas.ensure(`tema   ${run.toUpperCase()}`, now)).created, "mesmo nome em outra grafia não duplica");

  const blocks = noteBlocks("Resumo de teste.", {
    topicos: [{ titulo: "Tópico", pontos: ["ponto 1", "ponto 2"] }],
    conceitos: [{ termo: "Termo", definicao: "definição" }],
    diagrama: normalizeDiagram({
      nos: [{ id: "c", rotulo: "Cliente" }, { id: "a", rotulo: "API", forma: "redondo" }, { id: "b", rotulo: "Banco", forma: "banco" }],
      ligacoes: [{ de: "c", para: "a", rotulo: "HTTPS" }, { de: "a", para: "b" }],
      grupos: [{ titulo: "Backend", nos: ["a", "b"] }],
    }),
    mapaMental: normalizeMindMap({ raiz: "Teste", ramos: [{ rotulo: "Ramo A", filhos: [{ rotulo: "Folha 1" }] }, { rotulo: "Ramo B" }] }),
    lacunas: ["Pergunta em aberto?"],
    transcricao: "linha 1\nlinha 2",
  });
  const n = await notas.create({ id: `${run}-1`, title: `Nota ${run}`, summary: "Resumo de teste.", tipo: "diagrama", origem: "texto", temaPageId: filho.tema.pageId, createdAt: now, blocks });
  created.push(n.nota.pageId);
  ok(n.created && n.nota.temaId === filho.tema.id && n.nota.url !== undefined, `cria nota no subtema (${n.nota.url})`);
  ok(!(await notas.create({ id: `${run}-1`, title: "x", summary: "x", tipo: "ideia", origem: "texto", temaPageId: filho.tema.pageId, createdAt: now, blocks: [] })).created, "mesmo ID não duplica");

  const blockIds = await notas.append(n.nota.pageId, complementBlocks("hoje", { topicos: [{ titulo: "Novo tópico", pontos: ["ponto novo"] }], conceitos: [], lacunas: [] }));
  ok(blockIds.length >= 2, `complemento acrescentado (${blockIds.length} blocos com ID, para desfazer)`);
  await notas.deleteBlocks(blockIds);
  const left = await client.request("GET", `/v1/blocks/${n.nota.pageId}/children?page_size=100`);
  ok(!(left.results as { id: string }[]).some((b) => blockIds.includes(b.id)), "desfazer o complemento remove só os blocos acrescentados");

  await temas.setParent(filho.tema.pageId, null);
  ok((await temas.list()).find((t) => t.id === filho.tema.id)?.parentId === undefined, "tema sobe para o primeiro nível (Tema pai vazio)");
  await temas.setParent(filho.tema.pageId, pai.tema.pageId);
  ok((await temas.list()).find((t) => t.id === filho.tema.id)?.parentId === pai.tema.id, "tema volta a ter o pai");

  await notas.archive(n.nota.pageId);
  ok((await notas.find(`${run}-1`)) === null, "arquivar tira a nota das consultas");
  await notas.unarchive(n.nota.pageId);
  ok((await notas.find(`${run}-1`)) !== null, "restaurar traz a nota de volta");
  ok((await notas.search({ text: run })).some((x) => x.id === `${run}-1`), "search por texto");
  ok((await notas.search({ temaPageIds: [filho.tema.pageId] })).length === 1, "search por tema");
  ok((await notas.recent(5)).some((x) => x.id === `${run}-1`), "recent");
  ok((await notas.setTema(`${run}-1`, pai.tema.pageId)).temaId === pai.tema.id, "move para o tema pai");
} finally {
  if (process.env.KEEP === "1") console.log("KEEP=1: páginas de teste mantidas.");
  else {
    for (const id of created) await client.request("PATCH", `/v1/pages/${id}`, { archived: true });
    console.log(`Arquivadas ${created.length} páginas de teste.`);
  }
}

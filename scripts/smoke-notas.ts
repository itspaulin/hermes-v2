import { createNotionClient } from "../shared/notion/client.js";
import { complementBlocks, noteBlocks } from "../renato/src/notion/blocks.js";
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
    diagrama: "flowchart LR\n  Cliente --> API\n  API --> Banco[(Banco)]",
    mapaMental: "mindmap\n  root((Teste))\n    Ramo A\n      Folha 1\n    Ramo B",
    lacunas: ["Pergunta em aberto?"],
    transcricao: "linha 1\nlinha 2",
  });
  const n = await notas.create({ id: `${run}-1`, title: `Nota ${run}`, summary: "Resumo de teste.", tipo: "diagrama", origem: "texto", temaPageId: filho.tema.pageId, createdAt: now, blocks });
  created.push(n.nota.pageId);
  ok(n.created && n.nota.temaId === filho.tema.id && n.nota.url !== undefined, `cria nota no subtema (${n.nota.url})`);
  ok(!(await notas.create({ id: `${run}-1`, title: "x", summary: "x", tipo: "ideia", origem: "texto", temaPageId: filho.tema.pageId, createdAt: now, blocks: [] })).created, "mesmo ID não duplica");

  await notas.append(n.nota.pageId, complementBlocks("hoje", { topicos: [{ titulo: "Novo tópico", pontos: ["ponto novo"] }], conceitos: [], lacunas: [] }));
  ok(true, "complemento acrescentado");
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

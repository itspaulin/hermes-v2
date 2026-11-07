import { notionFromEnv } from "./notion-env.js";

/**
 * Teste REAL contra os bancos do Notion: cria uma meta e uma tarefa de teste, exercita o ciclo todo e
 * ARQUIVA o que criou (vai para a lixeira do Notion). Não toca em nenhuma outra linha.
 *   NOTION_TASKS_DB=... NOTION_METAS_DB=... npm run smoke:notion
 */
const { client, metas, tasks } = await notionFromEnv();
const run = `smoke-${Date.now().toString(36)}`;
const epoch = Math.floor(Date.now() / 1000);
const created: string[] = [];
const ok = (cond: boolean, what: string) => {
  console.log(`${cond ? "ok  " : "FALHOU"} ${what}`);
  if (!cond) process.exitCode = 1;
};

try {
  const m = await metas.create({ title: `Meta ${run}`, eventEpochSeconds: epoch });
  created.push(m.meta.path);
  ok(m.created && m.meta.status === "ativa", "cria meta");
  ok(!(await metas.create({ title: `Meta ${run}`, eventEpochSeconds: epoch })).created, "meta repetida não duplica");

  const t = await tasks.create({ title: `Tarefa ${run}`, eventEpochSeconds: epoch, due: "2030-01-02" as never, meta: m.meta.id });
  created.push(t.task.path);
  ok(t.created && t.task.due === "2030-01-02" && t.task.meta === m.meta.id, "cria tarefa com prazo e meta (relação)");
  ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(t.task.created), `criação com horário e offset (${t.task.created})`);
  ok(!(await tasks.create({ title: `Tarefa ${run}`, eventEpochSeconds: epoch })).created, "tarefa repetida não duplica");

  ok((await tasks.setDue(t.task.id, "2030-01-03" as never)).task.due === "2030-01-03", "muda o prazo");
  ok((await tasks.listPending()).tasks.some((x) => x.id === t.task.id), "aparece em listPending");
  const done = await tasks.complete(t.task.id);
  ok(done.task.status === "feita" && done.task.doneAt !== undefined, "conclui com Feita em");
  ok(!(await tasks.listPending()).tasks.some((x) => x.id === t.task.id), "some de listPending");
  ok((await metas.setStatus(m.meta.id, "concluida")).meta.status === "concluida", "muda status da meta");
} finally {
  for (const id of created) await client.request("PATCH", `/v1/pages/${id}`, { archived: true });
  console.log(`Arquivadas ${created.length} páginas de teste.`);
}

import { createSsmReader } from "../src/ssm.js";
import { createNotionClient } from "../shared/notion/client.js";
import { loadNotionConfig } from "../src/notion/config.js";
import { NotionMetaRepository } from "../src/notion/meta-repository.js";
import { NotionTaskRepository } from "../src/notion/task-repository.js";
import { systemClock } from "../src/time/index.js";

/** Repositórios do Notion para scripts. Token do SSM (nunca por argumento); IDs dos bancos por variável de ambiente. */
export async function notionFromEnv() {
  const cfg = await loadNotionConfig(createSsmReader(), {
    NOTION_TOKEN_PARAM: process.env.NOTION_TOKEN_PARAM ?? "/hermes/prod/notion/token",
    NOTION_TASKS_DB: process.env.NOTION_TASKS_DB,
    NOTION_METAS_DB: process.env.NOTION_METAS_DB,
  });
  if (!cfg) throw new Error("Defina NOTION_TASKS_DB e NOTION_METAS_DB (IDs dos bancos, 32 caracteres).");
  const client = createNotionClient({ token: cfg.token });
  const metas = new NotionMetaRepository(client, cfg.metasDatabaseId);
  const tasks = new NotionTaskRepository(client, cfg.tasksDatabaseId, metas, systemClock);
  return { client, metas, tasks };
}

import type { ParameterReader } from "../ssm.js";

export interface NotionConfig {
  token: string;
  tasksDatabaseId: string;
  metasDatabaseId: string;
}

/**
 * Config do Notion. Os IDs dos bancos não são segredo (env vars); o token vem do SSM (SecureString),
 * e a Lambda recebe só o NOME do parâmetro. Sem NOTION_TASKS_DB e NOTION_METAS_DB o Hermes continua
 * no Vault (devolve null). Só um dos dois IDs preenchido é erro de configuração.
 *   NOTION_TOKEN_PARAM=/hermes/prod/notion/token   NOTION_TASKS_DB=<32 hex>   NOTION_METAS_DB=<32 hex>
 */
export async function loadNotionConfig(
  ssm: ParameterReader,
  env: Record<string, string | undefined>,
): Promise<NotionConfig | null> {
  const tasks = env.NOTION_TASKS_DB?.trim() ?? "";
  const metas = env.NOTION_METAS_DB?.trim() ?? "";
  if (tasks === "" && metas === "") return null;
  if (tasks === "" || metas === "") throw new Error("Configure NOTION_TASKS_DB e NOTION_METAS_DB juntos (ou nenhum)");
  const param = env.NOTION_TOKEN_PARAM?.trim();
  if (!param) throw new Error("Variável ausente: NOTION_TOKEN_PARAM");
  const id = (v: string, name: string): string => {
    const hex = v.replace(/-/g, "").toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error(`${name} deve ter 32 caracteres hexadecimais`);
    return hex;
  };
  return { token: await ssm.get(param), tasksDatabaseId: id(tasks, "NOTION_TASKS_DB"), metasDatabaseId: id(metas, "NOTION_METAS_DB") };
}

import { createNotionClient, type NotionClient } from "../../../shared/notion/client.js";
import { NotasRepository } from "./notas.js";
import { TemaRepository } from "./temas.js";

type Env = Record<string, string | undefined>;

export interface RenatoNotion {
  client: NotionClient;
  temas: TemaRepository;
  notas: NotasRepository;
}

const hex32 = (v: string, name: string): string => {
  const h = v.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(h)) throw new Error(`${name} deve ter 32 caracteres hexadecimais`);
  return h;
};

/**
 * Notion do Renato, ou null se desligado (sem NOTION_TEMAS_DB e NOTION_NOTAS_DB: o Renato segue no Vault).
 * Token no SSM (só o NOME do parâmetro vem do ambiente); IDs dos bancos não são segredo. Só um dos
 * dois IDs é erro de configuração.
 */
export async function loadRenatoNotion(env: Env, readParameter: (name: string) => Promise<string>): Promise<RenatoNotion | null> {
  const temasDb = env.NOTION_TEMAS_DB?.trim() ?? "";
  const notasDb = env.NOTION_NOTAS_DB?.trim() ?? "";
  if (temasDb === "" && notasDb === "") return null;
  if (temasDb === "" || notasDb === "") throw new Error("Configure NOTION_TEMAS_DB e NOTION_NOTAS_DB juntos (ou nenhum)");
  const param = env.NOTION_TOKEN_PARAM?.trim();
  if (!param) throw new Error("Variável ausente: NOTION_TOKEN_PARAM");
  const temasId = hex32(temasDb, "NOTION_TEMAS_DB");
  const notasId = hex32(notasDb, "NOTION_NOTAS_DB");
  const client = createNotionClient({ token: await readParameter(param) });
  const temas = new TemaRepository(client, temasId);
  return { client, temas, notas: new NotasRepository(client, notasId, temas) };
}

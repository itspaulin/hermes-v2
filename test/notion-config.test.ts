import { describe, expect, it } from "vitest";
import { loadNotionConfig } from "../src/notion/config.js";

const ssm = { get: async (name: string) => (name === "/p/token" ? "tok" : Promise.reject(new Error("param inesperado"))) };
const HEX_A = "41163ec9e8d280399748f76f2289889f";
const HEX_B = "41163ec9e8d280aebc30ca47983a1a8b";

describe("loadNotionConfig", () => {
  it("sem os IDs dos bancos o Notion fica desligado (Vault) e o token nem é lido", async () => {
    const reads: string[] = [];
    const spy = { get: async (n: string) => (reads.push(n), "x") };
    expect(await loadNotionConfig(spy, {})).toBeNull();
    expect(await loadNotionConfig(spy, { NOTION_TASKS_DB: " ", NOTION_METAS_DB: "" })).toBeNull();
    expect(reads).toEqual([]);
  });

  it("com os dois IDs devolve token e IDs normalizados (sem hífens, minúsculos)", async () => {
    const cfg = await loadNotionConfig(ssm, {
      NOTION_TOKEN_PARAM: "/p/token",
      NOTION_TASKS_DB: HEX_B.toUpperCase(),
      NOTION_METAS_DB: "41163ec9-e8d2-8039-9748-f76f2289889f",
    });
    expect(cfg).toEqual({ token: "tok", tasksDatabaseId: HEX_B, metasDatabaseId: HEX_A });
  });

  it.each([
    [{ NOTION_TASKS_DB: HEX_A }, /juntos/],
    [{ NOTION_METAS_DB: HEX_A }, /juntos/],
    [{ NOTION_TASKS_DB: HEX_A, NOTION_METAS_DB: HEX_B }, /NOTION_TOKEN_PARAM/],
    [{ NOTION_TOKEN_PARAM: "/p/token", NOTION_TASKS_DB: "curto", NOTION_METAS_DB: HEX_B }, /NOTION_TASKS_DB/],
  ])("configuração errada falha cedo: %j", async (env, msg) => {
    await expect(loadNotionConfig(ssm, env)).rejects.toThrow(msg);
  });
});

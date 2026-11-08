import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNeonHistory, type Sql } from "../shared/ai/history.js";

type Call = { text: string; values: unknown[] };

function fakeSql(rows: Record<string, unknown>[] = [], fail?: (text: string) => boolean) {
  const calls: Call[] = [];
  const sql: Sql = async (strings, ...values) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    calls.push({ text, values });
    if (fail?.(text)) throw Object.assign(new Error("segredo na mensagem"), { name: "NeonDbError" });
    return text.startsWith("SELECT") ? rows : [];
  };
  return { sql, calls };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("histórico no Neon", () => {
  it("cria a tabela uma vez e devolve os turnos do mais antigo para o mais novo", async () => {
    const { sql, calls } = fakeSql([
      { role: "assistant", text: "Quer que eu crie?" },
      { role: "user", text: "quero fazer 2 apps" },
    ]);
    const h = createNeonHistory("postgres://x", { table: "hermes_chat_history", maxMessages: 6 }, sql);
    expect(await h.load(111)).toEqual([
      { role: "user", text: "quero fazer 2 apps" },
      { role: "assistant", text: "Quer que eu crie?" },
    ]);
    await h.load(111);
    expect(calls.filter((c) => c.text.startsWith("CREATE TABLE"))).toHaveLength(1);
    const select = calls.find((c) => c.text.startsWith("SELECT"))!;
    expect(select.values).toEqual([111, 120, 6]);
  });

  it("append grava cada turno e apaga o que passou da retenção", async () => {
    const { sql, calls } = fakeSql();
    await createNeonHistory("postgres://x", { table: "hermes_chat_history" }, sql).append(111, [
      { role: "user", text: "oi" },
      { role: "assistant", text: "e aí" },
    ]);
    const inserts = calls.filter((c) => c.text.startsWith("INSERT"));
    expect(inserts.map((c) => c.values)).toEqual([[111, "user", "oi"], [111, "assistant", "e aí"]]);
    expect(calls.at(-1)!.text).toMatch(/^DELETE FROM hermes_chat_history/);
  });

  it("falha do banco não propaga: load devolve vazio, append é silencioso, e o log não traz a mensagem do erro", async () => {
    const { sql } = fakeSql([], () => true);
    const h = createNeonHistory("postgres://x", { table: "hermes_chat_history" }, sql);
    expect(await h.load(1)).toEqual([]);
    await expect(h.append(1, [{ role: "user", text: "texto privado" }])).resolves.toBeUndefined();
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).toContain("NeonDbError");
    expect(logged).not.toContain("segredo");
    expect(logged).not.toContain("texto privado");
  });

  it("se a criação da tabela falhar, a próxima chamada tenta de novo", async () => {
    let failCreate = true;
    const { sql, calls } = fakeSql([], (t) => failCreate && t.startsWith("CREATE TABLE"));
    const h = createNeonHistory("postgres://x", { table: "hermes_chat_history" }, sql);
    await h.load(1);
    failCreate = false;
    await h.load(1);
    expect(calls.filter((c) => c.text.startsWith("CREATE TABLE"))).toHaveLength(2);
  });
});

describe("tabela por assistente", () => {
  it("usa a tabela pedida em todas as consultas (os valores continuam parametrizados) e corta o texto no limite", async () => {
    const { sql, calls } = fakeSql();
    const h = createNeonHistory("postgres://x", { table: "renato_chat_history", maxChars: 5 }, sql);
    await h.append(7, [{ role: "user", text: "abcdefghij" }]);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.text).toContain("renato_chat_history");
      expect(c.text).not.toContain("hermes_chat_history");
      expect(c.text).not.toContain("__T__");
    }
    expect(calls.find((c) => c.text.startsWith("INSERT"))!.values).toEqual([7, "user", "abcde"]);
  });

  it("recusa nome de tabela que não seja só letras minúsculas e _", () => {
    for (const table of ["x; DROP TABLE y", "Tabela", "a-b", "", "x".repeat(41)]) {
      expect(() => createNeonHistory("postgres://x", { table }, fakeSql().sql)).toThrow(/tabela/i);
    }
  });
});

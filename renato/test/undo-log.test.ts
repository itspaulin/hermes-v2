import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "../../shared/ai/history.js";
import { createNeonUndoLog } from "../src/notion/undo-log.js";
import type { UndoEntry } from "../src/notion/undo.js";

const entry: UndoEntry = { kind: "create_note", pageId: "p1", title: "T" };

function fakeSql(handler: (text: string, values: unknown[]) => Record<string, unknown>[] | Error = () => []) {
  const calls: { text: string; values: unknown[] }[] = [];
  const sql: Sql = async (strings, ...values) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    calls.push({ text, values });
    const r = handler(text, values);
    if (r instanceof Error) throw r;
    return r;
  };
  return { sql, calls };
}

beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

describe("registro de ações no Neon", () => {
  it("cria as tabelas uma vez; record grava JSON com valores parametrizados e limpa o antigo", async () => {
    const { sql, calls } = fakeSql();
    const log = createNeonUndoLog("postgres://x", sql);
    await log.record(7, 42, entry);
    await log.record(7, 43, entry);
    expect(calls.filter((c) => c.text.startsWith("CREATE TABLE IF NOT EXISTS renato_undo ("))).toHaveLength(1);
    expect(calls.filter((c) => c.text.includes("renato_undo_seen") && c.text.startsWith("CREATE"))).toHaveLength(1);
    const insert = calls.find((c) => c.text.startsWith("INSERT INTO renato_undo "))!;
    expect(insert.values).toEqual([7, 42, JSON.stringify(entry)]);
    expect(insert.text).toContain("ON CONFLICT (chat_id, message_id) DO NOTHING");
    expect(calls.some((c) => c.text.startsWith("DELETE FROM renato_undo WHERE chat_id"))).toBe(true);
  });

  it("has consulta por chat e mensagem", async () => {
    const yes = createNeonUndoLog("postgres://x", fakeSql((t) => (t.startsWith("SELECT") ? [{ x: 1 }] : [])).sql);
    const no = createNeonUndoLog("postgres://x", fakeSql().sql);
    expect(await yes.has(7, 42)).toBe(true);
    expect(await no.has(7, 42)).toBe(false);
  });

  it("pop devolve a entrada mais recente; mensagem repetida devolve 'repeat'; sem nada, 'empty'", async () => {
    const stored = fakeSql((t) => {
      if (t.startsWith("INSERT INTO renato_undo_seen")) return [{ message_id: 1 }];
      if (t.startsWith("DELETE FROM renato_undo WHERE id")) return [{ entry: JSON.stringify(entry) }];
      return [];
    });
    expect(await createNeonUndoLog("postgres://x", stored.sql).pop(7, 99)).toEqual({ status: "entry", entry });

    const repeat = fakeSql((t) => (t.startsWith("INSERT INTO renato_undo_seen") ? [] : []));
    expect(await createNeonUndoLog("postgres://x", repeat.sql).pop(7, 99)).toEqual({ status: "repeat" });
    expect(repeat.calls.some((c) => c.text.startsWith("DELETE FROM renato_undo WHERE id"))).toBe(false); // nada foi desfeito

    const empty = fakeSql((t) => (t.startsWith("INSERT INTO renato_undo_seen") ? [{ message_id: 1 }] : []));
    expect(await createNeonUndoLog("postgres://x", empty.sql).pop(7, 99)).toEqual({ status: "empty" });
  });

  it("entrada com tipo desconhecido ou JSON ruim não vira ação", async () => {
    for (const bad of [JSON.stringify({ kind: "apagar_tudo" }), "não é json"]) {
      const s = fakeSql((t) => (t.startsWith("INSERT INTO renato_undo_seen") ? [{ message_id: 1 }] : t.startsWith("DELETE FROM renato_undo WHERE id") ? [{ entry: bad }] : []));
      expect(await createNeonUndoLog("postgres://x", s.sql).pop(7, 1)).toEqual({ status: "empty" });
    }
  });

  it("falha do banco não propaga e o log traz só o nome do erro", async () => {
    const err = Object.assign(new Error("conteúdo privado"), { name: "NeonDbError" });
    const log = createNeonUndoLog("postgres://x", fakeSql(() => err).sql);
    await expect(log.record(7, 1, entry)).resolves.toBeUndefined();
    expect(await log.has(7, 1)).toBe(false);
    expect(await log.pop(7, 1)).toEqual({ status: "empty" });
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).toContain("NeonDbError");
    expect(logged).not.toContain("privado");
  });
});

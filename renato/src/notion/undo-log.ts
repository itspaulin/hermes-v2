import { neon } from "@neondatabase/serverless";
import type { Sql } from "../../../shared/ai/history.js";
import type { UndoEntry, UndoLog } from "./undo.js";

const TABLE_SQL = `CREATE TABLE IF NOT EXISTS renato_undo (
  id BIGSERIAL PRIMARY KEY,
  chat_id BIGINT NOT NULL,
  message_id BIGINT NOT NULL,
  entry TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (chat_id, message_id)
)`;
const SEEN_SQL = `CREATE TABLE IF NOT EXISTS renato_undo_seen (
  chat_id BIGINT NOT NULL,
  message_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_id, message_id)
)`;
const RECENT_HOURS = 24;
const RETENTION_DAYS = 7;
const QUERY_TIMEOUT_MS = 3000;

function withTimeout<T>(p: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), QUERY_TIMEOUT_MS);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

const KINDS = new Set(["create_note", "append", "create_tema", "move_note", "delete_tema", "delete_note"]);

/** Registro de ações desfazíveis no Neon (tabela `renato_undo`). Erros viram log com o nome do erro, nunca com conteúdo. */
export function createNeonUndoLog(connectionString: string, sql: Sql = neon(connectionString) as unknown as Sql): UndoLog {
  let ready: Promise<void> | undefined;
  const ensure = (): Promise<void> => {
    ready ??= sql([TABLE_SQL] as unknown as TemplateStringsArray)
      .then(() => sql([SEEN_SQL] as unknown as TemplateStringsArray))
      .then(() => undefined)
      .catch((err) => {
        ready = undefined;
        throw err;
      });
    return ready;
  };
  const fail = (what: string, err: unknown): void => console.error(`[undo] falha ao ${what}: ${err instanceof Error ? err.name : "erro"}`);

  return {
    async has(chatId, messageId) {
      try {
        await withTimeout(ensure());
        return (await withTimeout(sql`SELECT 1 AS x FROM renato_undo WHERE chat_id = ${chatId} AND message_id = ${messageId} LIMIT 1`)).length > 0;
      } catch (err) {
        fail("consultar", err);
        return false;
      }
    },
    async record(chatId, messageId, entry) {
      try {
        await withTimeout(ensure());
        await withTimeout(sql`INSERT INTO renato_undo (chat_id, message_id, entry) VALUES (${chatId}, ${messageId}, ${JSON.stringify(entry)}) ON CONFLICT (chat_id, message_id) DO NOTHING`);
        await withTimeout(sql`DELETE FROM renato_undo WHERE chat_id = ${chatId} AND created_at < now() - make_interval(days => ${RETENTION_DAYS})`);
      } catch (err) {
        fail("gravar", err);
      }
    },
    async pop(chatId, messageId) {
      try {
        await withTimeout(ensure());
        // Marca esta mensagem como processada ANTES de desfazer: um retry nunca desfaz uma segunda ação.
        const first = await withTimeout(sql`INSERT INTO renato_undo_seen (chat_id, message_id) VALUES (${chatId}, ${messageId}) ON CONFLICT DO NOTHING RETURNING message_id`);
        if (first.length === 0) return { status: "repeat" as const };
        await withTimeout(sql`DELETE FROM renato_undo_seen WHERE created_at < now() - make_interval(days => ${RETENTION_DAYS})`);
        const rows = await withTimeout(sql`
          DELETE FROM renato_undo WHERE id = (
            SELECT id FROM renato_undo WHERE chat_id = ${chatId} AND created_at > now() - make_interval(hours => ${RECENT_HOURS}) ORDER BY id DESC LIMIT 1
          ) RETURNING entry`);
        const raw = rows[0]?.entry;
        if (typeof raw !== "string") return { status: "empty" as const };
        const parsed = JSON.parse(raw) as { kind?: unknown };
        return typeof parsed.kind === "string" && KINDS.has(parsed.kind) ? { status: "entry" as const, entry: parsed as unknown as UndoEntry } : { status: "empty" as const };
      } catch (err) {
        fail("ler", err);
        return { status: "empty" as const };
      }
    },
  };
}

import { neon } from "@neondatabase/serverless";
import type { ConversationTurn } from "./types.js";

/**
 * Memória curta da conversa. Só texto trocado com o modelo (a mensagem do usuário e o que o assistente
 * respondeu), por chat. Cada assistente usa a SUA tabela (`hermes_chat_history`, `renato_chat_history`):
 * nunca compartilham conversa. Falha de armazenamento nunca derruba o bot: sem histórico a conversa
 * continua, só sem contexto. Logs nunca incluem o conteúdo das mensagens.
 */
export interface ChatHistory {
  /** Últimos turnos recentes do chat, do mais antigo para o mais novo. */
  load(chatId: number): Promise<ConversationTurn[]>;
  append(chatId: number, turns: readonly ConversationTurn[]): Promise<void>;
}

/** Função de consulta no estilo do driver do Neon: template tag que devolve as linhas. */
export type Sql = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>;

export interface HistoryOptions {
  /** Nome da tabela (só letras minúsculas e "_"; entra no SQL como texto, então é validado). */
  table: string;
  /** Mensagens devolvidas por consulta. */
  maxMessages?: number;
  /** Cada mensagem é cortada a este tamanho ao gravar (notas longas não inflam o contexto). */
  maxChars?: number;
}

/** Mensagens mais antigas que isto não entram no contexto (a conversa "esfriou"). */
const RECENT_WINDOW_MINUTES = 120;
/** Mensagens mais antigas que isto são apagadas. */
const RETENTION_HOURS = 24;
const QUERY_TIMEOUT_MS = 3000;

function withTimeout<T>(p: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), QUERY_TIMEOUT_MS);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export function createNeonHistory(connectionString: string, options: HistoryOptions, sql: Sql = neon(connectionString) as unknown as Sql): ChatHistory {
  const { table, maxMessages = 6, maxChars = 2000 } = options;
  if (!/^[a-z_]{1,40}$/.test(table)) throw new Error("Nome de tabela inválido");
  /** Mesma consulta, com `__T__` trocado pelo nome (validado) da tabela; os VALORES continuam parametrizados. */
  const q: Sql = (strings, ...values) => {
    const mapped = strings.map((s) => s.replaceAll("__T__", table));
    return sql(Object.assign(mapped, { raw: mapped }) as unknown as TemplateStringsArray, ...values);
  };

  let ready: Promise<void> | undefined;
  // Cria a tabela uma vez por cold start. Falha não é cacheada.
  const ensureTable = (): Promise<void> => {
    ready ??= q`
      CREATE TABLE IF NOT EXISTS __T__ (
        id BIGSERIAL PRIMARY KEY,
        chat_id BIGINT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        text TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`
      .then(() => q`CREATE INDEX IF NOT EXISTS __T___chat_idx ON __T__ (chat_id, id DESC)`)
      .then(() => undefined)
      .catch((err) => {
        ready = undefined;
        throw err;
      });
    return ready;
  };

  return {
    async load(chatId) {
      try {
        await withTimeout(ensureTable());
        const rows = await withTimeout(q`
          SELECT role, text FROM __T__
          WHERE chat_id = ${chatId} AND created_at > now() - make_interval(mins => ${RECENT_WINDOW_MINUTES})
          ORDER BY id DESC LIMIT ${maxMessages}`);
        return rows
          .reverse()
          .filter((r) => (r.role === "user" || r.role === "assistant") && typeof r.text === "string")
          .map((r) => ({ role: r.role as "user" | "assistant", text: r.text as string }));
      } catch (err) {
        console.error(`[history] falha ao ler: ${err instanceof Error ? err.name : "erro"}`);
        return [];
      }
    },

    async append(chatId, turns) {
      if (turns.length === 0) return;
      try {
        await withTimeout(ensureTable());
        for (const t of turns) {
          await withTimeout(q`INSERT INTO __T__ (chat_id, role, text) VALUES (${chatId}, ${t.role}, ${t.text.slice(0, maxChars)})`);
        }
        await withTimeout(q`DELETE FROM __T__ WHERE chat_id = ${chatId} AND created_at < now() - make_interval(hours => ${RETENTION_HOURS})`);
      } catch (err) {
        console.error(`[history] falha ao gravar: ${err instanceof Error ? err.name : "erro"}`);
      }
    },
  };
}

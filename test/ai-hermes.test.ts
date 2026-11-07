import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHermesAi, createHermesConversation, pendingContext, AI_UNAVAILABLE_TEXT, SYSTEM_PROMPT } from "../src/ai/hermes.js";
import type { ChatHistory } from "../src/ai/history.js";
import type { ConversationTurn } from "../shared/ai/types.js";
import { routeMessage } from "../src/telegram/router.js";
import type { Converse } from "../shared/ai/bedrock.js";
import type { AiConfig } from "../shared/ai/types.js";
import { InMemoryVaultStore } from "../src/vault/memory-store.js";
import { guardVaultStore } from "../src/vault/store.js";
import { fakeClock } from "../src/time/index.js";
import { makeRepos } from "./support/repos.js";

const clock = fakeClock("2026-09-25T17:30:00Z");
const config: AiConfig = { modelId: "m", region: "us-east-1", apiKeyParam: "/p/key", maxHistoryMessages: 4, maxInputChars: 500, maxOutputTokens: 100, timeoutMs: 1000 };
const EVENT = Math.floor(Date.parse("2026-09-25T17:30:00Z") / 1000);

function setup(converse: Converse, history?: ChatHistory) {
  const repos = makeRepos(guardVaultStore(new InMemoryVaultStore()), clock);
  const conv = createHermesConversation(createHermesAi(config, converse), { clock, tasks: repos.tasks, metas: repos.metas, ...(history && { history }) });
  return { repos, deps: { clock, ...repos, converse: conv, chatId: 111 }, converse };
}

function memoryHistory(initial: ConversationTurn[] = []) {
  const store: ConversationTurn[] = [...initial];
  const history: ChatHistory = {
    load: vi.fn(async () => [...store]),
    append: vi.fn(async (_chat, turns) => void store.push(...turns)),
  };
  return { history, store };
}
const json = (o: unknown): Converse => vi.fn(async () => ({ text: JSON.stringify(o) }));

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("Hermes: conversa natural", () => {
  it("saudação recebe resposta natural, sem lista de comandos nem tarefa criada", async () => {
    const { deps, repos } = setup(json({ type: "reply", message: "Oi! Como posso ajudar?" }));
    expect(await routeMessage("Oi, Hermes!", EVENT, deps)).toBe("Oi! Como posso ajudar?");
    expect((await repos.tasks.listPending()).tasks).toHaveLength(0);
  });

  it("show_today usa a funcionalidade existente com dados reais", async () => {
    const { deps, repos } = setup(json({ type: "action", action: "show_today", input: {} }));
    await routeMessage("/tarefa Estudar inglês", EVENT, { ...deps, converse: undefined });
    const direct = await routeMessage("/hoje", EVENT, { ...deps, converse: undefined });
    expect(await routeMessage("O que tenho para fazer hoje?", EVENT, deps)).toBe(direct);
    expect(repos).toBeDefined();
  });

  it("create_task só cria após a ação validada e confirma pelo resultado real", async () => {
    const { deps, repos } = setup(json({ type: "action", action: "create_task", input: { title: "Estudar inglês", due: "2026-09-30" } }));
    const out = await routeMessage("cria a tarefa estudar inglês até 30/09", EVENT, deps);
    expect(JSON.stringify(out)).toContain("Estudar inglês");
    const { tasks } = await repos.tasks.listPending();
    expect(tasks.map((t) => t.title)).toEqual(["Estudar inglês"]);
  });

  it.each([
    { title: "" },
    { title: "x".repeat(121) },
    { title: "tarefa #meta-qualquer" },
    { title: "/feita tudo" },
    { title: "ok", due: "amanhã" },
    { title: "ok", due: "2026-02-31" },
    { title: 5 },
  ])("create_task com input inválido não cria nada: %j", async (input) => {
    const { deps, repos } = setup(json({ type: "action", action: "create_task", input }));
    expect(await routeMessage("cria uma tarefa", EVENT, deps)).toBe(AI_UNAVAILABLE_TEXT);
    expect((await repos.tasks.listPending()).tasks).toHaveLength(0);
  });

  it("ação fora da allowlist ou saída malformada não executa nada", async () => {
    for (const converse of [json({ type: "action", action: "complete_task", input: { ids: ["x"] } }), vi.fn(async () => ({ text: "bla" }))]) {
      const { deps, repos } = setup(converse);
      expect(await routeMessage("faça algo", EVENT, deps)).toBe(AI_UNAVAILABLE_TEXT);
      expect((await repos.tasks.listPending()).tasks).toHaveLength(0);
    }
  });

  it("Bedrock indisponível: texto solto recebe aviso, comandos seguem funcionando e sem chamar o modelo", async () => {
    const converse = vi.fn(async () => Promise.reject(Object.assign(new Error("x"), { name: "ThrottlingException" })));
    const { deps } = setup(converse);
    expect(await routeMessage("oi", EVENT, deps)).toBe(AI_UNAVAILABLE_TEXT);
    converse.mockClear();
    expect(await routeMessage("/ping", EVENT, deps)).toMatch(/^pong/);
    expect(String(await routeMessage("/tarefa Teste", EVENT, deps))).toContain("Teste");
    expect(converse).not.toHaveBeenCalled();
  });

  it("IA desligada (sem converse): texto solto mantém a ajuda original", async () => {
    const { deps } = setup(json({ type: "reply", message: "x" }));
    expect(await routeMessage("oi", EVENT, { ...deps, converse: undefined })).toMatch(/^Envie um comando\./);
  });

  it("o prompt do Hermes não fala do Renato", () => {
    expect(SYSTEM_PROMPT).toContain("Hermes");
    expect(SYSTEM_PROMPT).not.toMatch(/Renato|capture_note/);
  });
});

describe("Hermes: várias tarefas e prazo", () => {
  it("create_tasks cria todas e a resposta é um texto só", async () => {
    const { deps, repos } = setup(json({ type: "action", action: "create_tasks", input: { tasks: [{ title: "Ideia de 2 apps" }, { title: "Identidade da Somisfy" }, { title: "Ideias de prospecção" }] } }));
    const out = await routeMessage("quero fazer umas coisas no fim de semana", EVENT, deps);
    expect(typeof out).toBe("string");
    expect((await repos.tasks.listPending()).tasks.map((t) => t.title).sort()).toEqual(["Ideia de 2 apps", "Ideias de prospecção", "Identidade da Somisfy"]);
  });

  it("create_tasks com metas ativas cria sem meta, sem pergunta", async () => {
    const { deps, repos } = setup(json({ type: "action", action: "create_tasks", input: { tasks: [{ title: "A" }, { title: "B" }] } }));
    await repos.metas.create({ title: "Meta ativa", eventEpochSeconds: EVENT });
    const out = await routeMessage("faz duas tarefas", EVENT, deps);
    expect(typeof out).toBe("string");
    const { tasks } = await repos.tasks.listPending();
    expect(tasks).toHaveLength(2);
    expect(tasks.every((t) => t.meta === undefined)).toBe(true);
  });

  it("set_task_due muda o prazo de tarefas existentes e não cria tarefa nova", async () => {
    const ids = ["2026-09-25-tarefa-um", "2026-09-25-tarefa-dois"];
    const { deps, repos } = setup(json({ type: "action", action: "set_task_due", input: { ids, due: "2026-11-08" } }));
    for (const t of ["Tarefa um", "Tarefa dois"]) await repos.tasks.create({ title: t, eventEpochSeconds: EVENT });
    const out = await routeMessage("data limite até 8/11", EVENT, deps);
    expect(String(out)).toContain("Prazo definido: Tarefa um");
    const { tasks } = await repos.tasks.listPending();
    expect(tasks).toHaveLength(2);
    expect(tasks.every((t) => t.due === "2026-11-08")).toBe(true);
  });

  it("set_task_due com ID que o modelo inventou não altera nada", async () => {
    const { deps, repos } = setup(json({ type: "action", action: "set_task_due", input: { ids: ["2026-09-25-nao-existe"], due: "2026-11-08" } }));
    await repos.tasks.create({ title: "Real", eventEpochSeconds: EVENT });
    expect(String(await routeMessage("prazo", EVENT, deps))).toContain("Não achei");
    expect((await repos.tasks.listPending()).tasks[0]!.due).toBeUndefined();
  });

  it.each([
    { ids: [], due: "2026-11-08" },
    { ids: ["a"], due: "amanhã" },
    { ids: ["a"], due: "2026-02-31" },
    { ids: [5], due: "2026-11-08" },
    { due: "2026-11-08" },
  ])("set_task_due com input inválido não executa: %j", async (input) => {
    const { deps } = setup(json({ type: "action", action: "set_task_due", input }));
    expect(await routeMessage("prazo", EVENT, deps)).toBe(AI_UNAVAILABLE_TEXT);
  });

  it("create_tasks com item inválido não cria nenhuma", async () => {
    const { deps, repos } = setup(json({ type: "action", action: "create_tasks", input: { tasks: [{ title: "ok" }, { title: "/feita x" }] } }));
    expect(await routeMessage("faz", EVENT, deps)).toBe(AI_UNAVAILABLE_TEXT);
    expect((await repos.tasks.listPending()).tasks).toHaveLength(0);
  });

  it("o modelo recebe as tarefas pendentes (com ID, hora e prazo) no contexto", async () => {
    const converse = vi.fn(async () => ({ text: JSON.stringify({ type: "reply", message: "ok" }) }));
    const { deps, repos } = setup(converse);
    await repos.tasks.create({ title: "Estudar inglês", eventEpochSeconds: EVENT, due: "2026-09-30" as never });
    await routeMessage("essa tarefa tem prazo", EVENT, deps);
    const sent = JSON.stringify((converse.mock.calls as unknown as unknown[][])[0]![0]);
    expect(sent).toContain("2026-09-25-estudar-ingles");
    expect(sent).toContain("prazo 2026-09-30");
    expect(sent).toContain("14:30");
  });

  it("pendingContext: sem tarefas, mais recente primeiro e limite", () => {
    expect(pendingContext([], "2026-09-25")).toContain("nenhuma");
    const mk = (n: number) => ({ id: `t${n}`, path: "p", title: `T${n}`, status: "pendente" as const, created: `2026-09-25T10:${String(n).padStart(2, "0")}:00-03:00` });
    const ctx = pendingContext(Array.from({ length: 45 }, (_, i) => mk(i)), "2026-09-25");
    expect(ctx.indexOf("id=t44")).toBeLessThan(ctx.indexOf("id=t43"));
    expect(ctx).not.toContain("id=t4 ");
    expect(ctx).toContain("e mais 5 antigas");
  });
});

describe("Hermes: memória da conversa", () => {
  it("envia o histórico ao modelo e grava a mensagem e a resposta real depois", async () => {
    const { history, store } = memoryHistory([
      { role: "user", text: "quero fazer 2 apps no fim de semana" },
      { role: "assistant", text: "Quer que eu crie uma tarefa?" },
    ]);
    const converse = vi.fn(async () => ({ text: JSON.stringify({ type: "action", action: "create_task", input: { title: "Ideia de 2 apps" } }) }));
    const { deps } = setup(converse, history);
    await routeMessage("pode criar", EVENT, deps);

    const request = (converse.mock.calls[0] as unknown as [{ messages: { role: string; text: string }[] }])[0];
    expect(request.messages.map((m) => m.text)).toEqual(["quero fazer 2 apps no fim de semana", "Quer que eu crie uma tarefa?", "pode criar"]);
    expect(history.load).toHaveBeenCalledWith(111);
    expect(store.slice(-2)).toMatchObject([{ role: "user", text: "pode criar" }, { role: "assistant" }]);
    expect(store.at(-1)!.text).toContain("Tarefa criada: Ideia de 2 apps");
  });

  it("sem histórico configurado ou sem chatId, a conversa funciona igual", async () => {
    const { deps } = setup(json({ type: "reply", message: "oi!" }));
    expect(await routeMessage("oi", EVENT, deps)).toBe("oi!");
    const { history } = memoryHistory();
    const { deps: d2 } = setup(json({ type: "reply", message: "oi!" }), history);
    expect(await routeMessage("oi", EVENT, { ...d2, chatId: undefined })).toBe("oi!");
    expect(history.append).not.toHaveBeenCalled();
  });

  it("falha do modelo não grava histórico", async () => {
    const { history } = memoryHistory();
    const { deps } = setup(vi.fn(async () => ({ text: "bla" })), history);
    await routeMessage("oi", EVENT, deps);
    expect(history.append).not.toHaveBeenCalled();
  });
});

describe("Hermes: webhook", () => {
  it("chat não autorizado nunca chega ao modelo", async () => {
    const { handleWebhook } = await import("../src/telegram/webhook.js");
    const converse = vi.fn(async () => ({ text: "{}" }));
    const { repos } = setup(converse);
    const conv = vi.fn(async () => "x");
    const send = vi.fn(async () => {});
    const event = { headers: { "x-telegram-bot-api-secret-token": "s" }, body: JSON.stringify({ update_id: 1, message: { message_id: 1, chat: { id: 999, type: "private" }, text: "oi" } }), isBase64Encoded: false } as never;
    const res = await handleWebhook(event, {
      config: { botToken: "t", webhookSecret: "s", allowedChatIds: [111] },
      client: { sendMessage: send, answerCallbackQuery: async () => {}, editMessageText: async () => {} },
      clock,
      ...repos,
      converse: conv,
    });
    expect(res).toMatchObject({ statusCode: 200 });
    expect(conv).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});

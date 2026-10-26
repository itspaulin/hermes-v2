import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHermesAi, createHermesConversation, AI_UNAVAILABLE_TEXT, SYSTEM_PROMPT } from "../src/ai/hermes.js";
import { routeMessage } from "../src/telegram/router.js";
import type { Converse } from "../shared/ai/bedrock.js";
import type { AiConfig } from "../shared/ai/types.js";
import { InMemoryVaultStore } from "../src/vault/memory-store.js";
import { guardVaultStore } from "../src/vault/store.js";
import { fakeClock } from "../src/time/index.js";
import { makeRepos } from "./support/repos.js";

const clock = fakeClock("2026-09-25T17:30:00Z");
const config: AiConfig = { modelId: "m", region: "us-east-1", maxHistoryMessages: 4, maxInputChars: 500, maxOutputTokens: 100, timeoutMs: 1000 };
const EVENT = Math.floor(Date.parse("2026-09-25T17:30:00Z") / 1000);

function setup(converse: Converse) {
  const repos = makeRepos(guardVaultStore(new InMemoryVaultStore()), clock);
  const conv = createHermesConversation(createHermesAi(config, converse), { clock, tasks: repos.tasks, metas: repos.metas });
  return { repos, deps: { clock, ...repos, converse: conv }, converse };
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
    for (const converse of [json({ type: "action", action: "complete_task", input: { id: "x" } }), vi.fn(async () => ({ text: "bla" }))]) {
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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Converse } from "../../shared/ai/bedrock.js";
import type { AiConfig } from "../../shared/ai/types.js";
import { FakeNotion } from "../../test/support/fake-notion.js";
import { AI_UNAVAILABLE_TEXT, buildContext, createNotionAi, createNotionAssistant, SYSTEM_PROMPT, TOO_LONG_TEXT } from "../src/notion/assistant.js";
import { NotasRepository } from "../src/notion/notas.js";
import { TemaRepository } from "../src/notion/temas.js";

const config: AiConfig = { modelId: "m", region: "us-east-1", apiKeyParam: "/p", maxHistoryMessages: 4, maxInputChars: 500, maxOutputTokens: 100, timeoutMs: 1000 };
const EPOCH = Date.parse("2026-11-07T21:23:00Z") / 1000; // 18:23 em SP
const T0 = "2026-11-07T18:23:00-03:00";
const TEMAS_DB = "db-temas";
const NOTAS_DB = "db-notas";

const content = { topicos: [{ titulo: "Consistência", pontos: ["todos veem o mesmo dado"] }], conceitos: [], lacunas: ["E a latência?"] };
const action = (name: string, input: unknown) => ({ type: "action", action: name, input });
const json = (o: unknown): Converse => vi.fn(async () => ({ text: JSON.stringify(o) }));

let notion: FakeNotion;
let temas: TemaRepository;
let notas: NotasRepository;

function assistant(converse: Converse) {
  const run = createNotionAssistant({ ai: createNotionAi(config, converse), temas, notas });
  let message = 100;
  return (text: string, id = ++message) => run({ text, chatId: 7, messageId: id, epochSeconds: EPOCH });
}
const notasRows = () => notion.pages.filter((p) => p.database === NOTAS_DB);
const temasRows = () => notion.pages.filter((p) => p.database === TEMAS_DB);
const names = () => temasRows().map((p) => p.properties.Nome.title[0].plain_text).sort();

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  notion = new FakeNotion();
  temas = new TemaRepository(notion, TEMAS_DB);
  notas = new NotasRepository(notion, NOTAS_DB, temas);
});
afterEach(() => vi.restoreAllMocks());

describe("save_note", () => {
  it("guarda a nota no tema existente; a transcrição é a mensagem ORIGINAL, não o que o modelo escreveu", async () => {
    await temas.ensure("Princípios de System Design", T0);
    const say = assistant(json(action("save_note", { titulo: "CAP theorem", resumo: "Escolha 2 de 3.", tipo: "conceito", tema: { existente: "principios-de-system-design" }, conteudo: { ...content, transcricao: "TEXTO INVENTADO PELO MODELO" } })));
    const reply = await say("li sobre CAP: consistência, disponibilidade e partição");

    expect(reply).toContain("Anotei: CAP theorem");
    expect(reply).toContain("Tema: Princípios de System Design");
    expect(reply).toContain("notion.so");
    expect(names()).toEqual(["Princípios de System Design"]); // nenhum tema criado
    const [page] = notasRows();
    const body = JSON.stringify(page!.children);
    expect(body).toContain("li sobre CAP: consistência, disponibilidade e partição");
    expect(body).not.toContain("INVENTADO");
    expect(page!.properties.Origem.select.name).toBe("texto");
    expect(page!.properties.ID.rich_text[0].plain_text).toBe("telegram-7-101");
  });

  it("tema novo com pai cria o subtema e avisa; o pai precisa existir na lista", async () => {
    await temas.ensure("Programação", T0);
    const reply = await assistant(json(action("save_note", { titulo: "LINQ", resumo: "Consultas.", tipo: "conceito", tema: { novo: "C#", pai: "programacao" }, conteudo: content })))("estudando LINQ");
    expect(reply).toContain("Criei o tema Programação > C#.");
    expect(reply).toContain("Tema: Programação > C#");
    expect(names()).toEqual(["C#", "Programação"]);
  });

  it("sem tema vai para a Caixa de entrada, que é criada uma vez", async () => {
    const say = assistant(json(action("save_note", { titulo: "Ideia", resumo: "x", tipo: "ideia", conteudo: content })));
    expect(await say("uma ideia")).toContain("Tema: Caixa de entrada");
    await say("outra ideia");
    expect(names()).toEqual(["Caixa de entrada"]);
    expect(notasRows()).toHaveLength(2);
  });

  it("tema existente inventado pelo modelo cai na Caixa de entrada com aviso, sem criar tema", async () => {
    const reply = await assistant(json(action("save_note", { titulo: "X", resumo: "x", tipo: "resumo", tema: { existente: "nao-existe" }, conteudo: content })))("algo");
    expect(reply).toContain('Não achei o tema "nao-existe"');
    expect(reply).toContain("Tema: Caixa de entrada");
    expect(names()).toEqual(["Caixa de entrada"]);
  });

  it("'novo' com nome que já existe em outra grafia não duplica o tema", async () => {
    await temas.ensure("System Design", T0);
    const reply = await assistant(json(action("save_note", { titulo: "X", resumo: "x", tipo: "resumo", tema: { novo: "system   DESIGN" }, conteudo: content })))("algo");
    expect(reply).not.toContain("Criei o tema");
    expect(names()).toEqual(["System Design"]);
  });

  it("diagrama e mapa mental viram blocos mermaid gerados pelo código", async () => {
    await assistant(json(action("save_note", {
      titulo: "Arquitetura", resumo: "x", tipo: "diagrama",
      conteudo: { ...content, diagrama: { nos: [{ id: "a", rotulo: "Cliente" }, { id: "b", rotulo: "API" }], ligacoes: [{ de: "a", para: "b" }] }, mapaMental: { raiz: "Arq", ramos: [{ rotulo: "Cliente" }] } },
    })))("desenho");
    const body = JSON.stringify(notasRows()[0]!.children);
    expect(body).toContain('"language":"mermaid"');
    expect(body).toContain('n1[\\"Cliente\\"]');
    expect(body).toContain('r0((\\"Arq\\"))');
  });

  it("repetir a mesma mensagem (reenvio do Telegram) não duplica a nota", async () => {
    const say = assistant(json(action("save_note", { titulo: "A", resumo: "x", tipo: "resumo", conteudo: content })));
    expect(await say("texto", 555)).toContain("Anotei: A");
    expect(await say("texto", 555)).toContain("Essa nota já existia: A");
    expect(notasRows()).toHaveLength(1);
  });
});

describe("append_to_note", () => {
  it("acrescenta uma seção datada na nota existente, sem criar outra nem mexer no que havia", async () => {
    const inbox = await temas.inbox(T0);
    const { nota } = await notas.create({ id: "n-1", title: "CAP theorem", summary: "r", tipo: "conceito", origem: "texto", temaPageId: inbox.pageId, createdAt: T0, blocks: [{ type: "paragraph", paragraph: { rich_text: [] } }] });
    const before = structuredClone(notasRows()[0]!.children);

    const reply = await assistant(json(action("append_to_note", { id: "n-1", conteudo: content })))("e sobre consistência eventual: ...");
    expect(reply).toContain('Acrescentei na nota "CAP theorem"');
    expect(notasRows()).toHaveLength(1);
    const after = notasRows()[0]!.children!;
    expect(after.slice(0, before!.length)).toEqual(before);
    expect(JSON.stringify(after.slice(before!.length))).toContain("Complemento, 07/11/2026");
    expect(JSON.stringify(after.slice(before!.length))).toContain("e sobre consistência eventual");
    expect(nota.id).toBe("n-1");
  });

  it("ID que não existe: avisa e não escreve nada", async () => {
    const reply = await assistant(json(action("append_to_note", { id: "inventado", conteudo: content })))("mais coisas");
    expect(reply).toContain("Não achei essa nota");
    expect(notasRows()).toHaveLength(0);
  });
});

describe("find_notes e move_note", () => {
  beforeEach(async () => {
    const sd = await temas.ensure("System Design", T0);
    const cs = await temas.ensure("C#", T0);
    await notas.create({ id: "n-1", title: "CAP theorem", summary: "sistemas distribuídos", tipo: "conceito", origem: "texto", temaPageId: sd.tema.pageId, createdAt: T0, blocks: [] });
    await notas.create({ id: "n-2", title: "LINQ", summary: "consultas", tipo: "conceito", origem: "texto", temaPageId: cs.tema.pageId, createdAt: T0, blocks: [] });
  });

  it("lista por texto, com tema e link", async () => {
    const reply = await assistant(json(action("find_notes", { texto: "cap" })))("o que eu tenho sobre CAP?");
    expect(reply).toContain("Achei 1:");
    expect(reply).toContain("1. CAP theorem (System Design)");
    expect(reply).toContain("notion.so");
    expect(reply).not.toContain("LINQ");
  });

  it("lista por tema, incluindo subtemas", async () => {
    await temas.ensure("Genéricos", T0, "c-sharp");
    const cs = (await temas.list()).find((t) => t.id === "genericos")!;
    await notas.create({ id: "n-3", title: "Variância", summary: "x", tipo: "conceito", origem: "texto", temaPageId: cs.pageId, createdAt: T0, blocks: [] });
    const reply = await assistant(json(action("find_notes", { tema: "C#" })))("notas de c#");
    expect(reply).toContain("Achei 2:");
    expect(reply).toContain("LINQ");
    expect(reply).toContain("Variância");
    expect(reply).not.toContain("CAP");
  });

  it("nada encontrado e tema inexistente têm respostas claras", async () => {
    expect(await assistant(json(action("find_notes", { texto: "zzz" })))("x")).toBe("Não achei nenhuma nota com isso.");
    expect(await assistant(json(action("find_notes", { tema: "Culinária" })))("x")).toBe('Não achei o tema "Culinária".');
  });

  it("move a nota para outro tema (e cria o tema se pedido)", async () => {
    const reply = await assistant(json(action("move_note", { id: "n-2", tema: { novo: "Banco de dados", pai: "system-design" } })))("move LINQ para banco de dados");
    expect(reply).toContain('Movi "LINQ" para System Design > Banco de dados.');
    expect(reply).toContain("Criei o tema System Design > Banco de dados.");
    expect((await notas.find("n-2"))!.temaId).toBe("banco-de-dados");
    expect(await assistant(json(action("move_note", { id: "n-2", tema: { existente: "banco-de-dados" } })))("de novo")).toContain("já está em");
    expect(await assistant(json(action("move_note", { id: "zzz", tema: { existente: "c-sharp" } })))("x")).toBe("Não achei essa nota.");
  });
});

describe("conversa, contexto e falhas", () => {
  it("reply e clarify passam direto, sem escrever no Notion", async () => {
    expect(await assistant(json({ type: "reply", message: "Oi!" }))("oi")).toBe("Oi!");
    expect(await assistant(json({ type: "clarify", message: "Qual tema: 1) A ou 2) B?" }))("anota isso")).toBe("Qual tema: 1) A ou 2) B?");
    expect(notasRows()).toHaveLength(0);
    expect(temasRows()).toHaveLength(0);
  });

  it("o modelo recebe a árvore de temas e as notas recentes (a mais recente primeiro)", async () => {
    const pai = await temas.ensure("Programação", T0);
    const filho = await temas.ensure("C#", T0, "programacao");
    await notas.create({ id: "n-1", title: "Primeira", summary: "r1", tipo: "conceito", origem: "texto", temaPageId: pai.tema.pageId, createdAt: T0, blocks: [] });
    await notas.create({ id: "n-2", title: "Segunda", summary: "r2", tipo: "conceito", origem: "texto", temaPageId: filho.tema.pageId, createdAt: T0, blocks: [] });
    const converse = vi.fn(async () => ({ text: JSON.stringify({ type: "reply", message: "ok" }) }));
    await assistant(converse)("oi");
    const system = (converse.mock.calls[0] as unknown as [{ system: string }])[0].system;
    expect(system).toContain("- Programação (id=programacao)\n  - C# (id=c-sharp)");
    expect(system.indexOf("id=n-2")).toBeLessThan(system.indexOf("id=n-1"));
    expect(system).toContain('"Segunda" | tema: Programação > C# | r2');
    expect(system).toContain("Data de hoje: 2026-11-07");
  });

  it("buildContext sem nada ainda", () => {
    expect(buildContext([], [], "2026-11-07")).toContain("(nenhum ainda");
  });

  it("falha do modelo ou saída inválida não grava nada", async () => {
    for (const converse of [
      vi.fn(async () => ({ text: "bla" })),
      vi.fn(async () => Promise.reject(Object.assign(new Error("x"), { name: "ThrottlingException" }))),
      json(action("save_note", { titulo: "x", resumo: "x", conteudo: { topicos: [{ titulo: "" }] } })), // sem conteúdo aproveitável
      json(action("save_note", { titulo: "x", resumo: "x", tema: { novo: "" }, conteudo: content })),
      json(action("apagar_tudo", {})),
      json(action("move_note", { id: "a", tema: null })),
    ]) {
      expect(await assistant(converse)("texto")).toBe(AI_UNAVAILABLE_TEXT);
    }
    expect(notion.pages).toHaveLength(0);
  });

  it("mensagem longa demais tem aviso próprio", async () => {
    expect(await assistant(json({ type: "reply", message: "x" }))("x".repeat(501))).toBe(TOO_LONG_TEXT);
  });

  it("tipo inválido vira 'resumo'; conteúdo torto é limpo em vez de recusar a nota", async () => {
    await assistant(json(action("save_note", { titulo: "T", resumo: "r", tipo: "qualquer", conteudo: { topicos: [{ titulo: "ok", pontos: ["a", 5, "", "b"] }, 7], diagrama: "flowchart LR", lacunas: [null, "q?"] } })))("t");
    const page = notasRows()[0]!;
    expect(page.properties.Tipo.select.name).toBe("resumo");
    const body = JSON.stringify(page.children);
    expect(body).toContain("q?");
    expect(body).not.toContain("flowchart");
  });

  it("o prompt não fala do Hermes", () => {
    expect(SYSTEM_PROMPT).not.toMatch(/Hermes/);
    expect(SYSTEM_PROMPT).toContain("Nunca escreva código Mermaid");
  });
});

describe("memória da conversa", () => {
  it("envia o histórico ao modelo e grava a mensagem e o que o usuário viu; falha do modelo não entra", async () => {
    const store: { role: "user" | "assistant"; text: string }[] = [
      { role: "user", text: "anota isso" },
      { role: "assistant", text: "Qual tema: 1) A ou 2) B?" },
    ];
    const history = { load: vi.fn(async () => [...store]), append: vi.fn(async (_c: number, turns: readonly { role: "user" | "assistant"; text: string }[]) => void store.push(...turns)) };
    const converse = vi.fn(async () => ({ text: JSON.stringify(action("save_note", { titulo: "T", resumo: "r", tipo: "resumo", tema: { novo: "A" }, conteudo: content })) }));
    const run = createNotionAssistant({ ai: createNotionAi(config, converse), temas, notas, history });
    const reply = await run({ text: "1", chatId: 7, messageId: 900, epochSeconds: EPOCH });

    const request = (converse.mock.calls[0] as unknown as [{ messages: { text: string }[] }])[0];
    expect(request.messages.map((m) => m.text)).toEqual(["anota isso", "Qual tema: 1) A ou 2) B?", "1"]);
    expect(history.load).toHaveBeenCalledWith(7);
    expect(store.slice(-2)).toEqual([{ role: "user", text: "1" }, { role: "assistant", text: reply }]);
    expect(reply).toContain("Anotei: T");

    history.append.mockClear();
    const bad = createNotionAssistant({ ai: createNotionAi(config, vi.fn(async () => ({ text: "bla" }))), temas, notas, history });
    expect(await bad({ text: "x", chatId: 7, messageId: 901, epochSeconds: EPOCH })).toBe(AI_UNAVAILABLE_TEXT);
    expect(history.append).not.toHaveBeenCalled();
  });
});

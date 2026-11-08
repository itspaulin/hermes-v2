import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Converse } from "../../shared/ai/bedrock.js";
import { NotionApiError } from "../../shared/notion/errors.js";
import type { AiConfig } from "../../shared/ai/types.js";
import { FakeNotion } from "../../test/support/fake-notion.js";
import { AI_UNAVAILABLE_TEXT, createNotionAi, createNotionAssistant } from "../src/notion/assistant.js";
import { NotasRepository } from "../src/notion/notas.js";
import { TemaRepository } from "../src/notion/temas.js";
import type { UndoEntry, UndoLog } from "../src/notion/undo.js";

const config: AiConfig = { modelId: "m", region: "us-east-1", apiKeyParam: "/p", maxHistoryMessages: 4, maxInputChars: 500, maxOutputTokens: 100, timeoutMs: 1000 };
const EPOCH = Date.parse("2026-11-07T21:23:00Z") / 1000;
const T0 = "2026-11-07T18:23:00-03:00";
const content = { topicos: [{ titulo: "A", pontos: ["b"] }], conceitos: [], lacunas: [] };
const action = (name: string, input: unknown) => ({ type: "action", action: name, input });
const json = (o: unknown): Converse => vi.fn(async () => ({ text: JSON.stringify(o) }));

/** Registro em memória com a mesma semântica do Neon (um por mensagem; pop atômico e idempotente por mensagem). */
function memoryUndo() {
  const entries: { chatId: number; messageId: number; entry: UndoEntry }[] = [];
  const seen = new Set<string>();
  const log: UndoLog = {
    has: async (c, m) => entries.some((e) => e.chatId === c && e.messageId === m),
    record: async (c, m, entry) => void (entries.some((e) => e.chatId === c && e.messageId === m) || entries.push({ chatId: c, messageId: m, entry })),
    pop: async (c, m) => {
      if (seen.has(`${c}:${m}`)) return { status: "repeat" };
      seen.add(`${c}:${m}`);
      const i = entries.map((e) => e.chatId).lastIndexOf(c);
      if (i < 0) return { status: "empty" };
      return { status: "entry", entry: entries.splice(i, 1)[0]!.entry };
    },
  };
  return { log, entries };
}

let notion: FakeNotion;
let temas: TemaRepository;
let notas: NotasRepository;
let undo: ReturnType<typeof memoryUndo>;
let counter = 1000;

/** Um turno por chamada: cada `say` simula uma mensagem nova (messageId novo), com o modelo respondendo `out`. */
const say = (out: unknown, text = "mensagem", opts: { messageId?: number; undoLog?: UndoLog | null } = {}) =>
  createNotionAssistant({ ai: createNotionAi(config, json(out)), temas, notas, ...(opts.undoLog !== null && { undoLog: opts.undoLog ?? undo.log }) })({ text, chatId: 7, messageId: opts.messageId ?? ++counter, epochSeconds: EPOCH });
const rows = (db: string) => notion.pages.filter((p) => p.database === db && !p.archived);
const temaNames = () => rows("db-temas").map((p) => p.properties.Nome.title[0].plain_text).sort();
const mk = async (id: string, title: string, temaPageId: string) => notas.create({ id, title, summary: "", tipo: "conceito", origem: "texto", temaPageId, createdAt: T0, blocks: [] });

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  notion = new FakeNotion();
  temas = new TemaRepository(notion, "db-temas");
  notas = new NotasRepository(notion, "db-notas", temas);
  undo = memoryUndo();
});
afterEach(() => vi.restoreAllMocks());

describe("listar sem comando", () => {
  it("find_notes sem filtro lista as mais recentes (limite pedido, no máximo 20)", async () => {
    const inbox = await temas.inbox(T0);
    for (let i = 1; i <= 12; i++) await mk(`n-${i}`, `Nota ${i}`, inbox.pageId);
    const ten = await say(action("find_notes", {}), "lista pra mim os 10 mais recentes");
    expect(ten).toContain("Achei 10:"); // pede as 10 mais recentes
    expect(ten.match(/^\d+\. /gm)).toHaveLength(10);
    const three = await say(action("find_notes", { limite: 3 }));
    expect(three.match(/^\d+\. /gm)).toHaveLength(3);
    expect(three.indexOf("Nota 12")).toBeLessThan(three.indexOf("Nota 11"));
    expect(await say(action("find_notes", { limite: 999 }))).toContain("Nota 12");
  });
  it("sem notas avisa", async () => {
    expect(await say(action("find_notes", null))).toBe("Você ainda não tem notas.");
  });
});

describe("criar tema por conversa", () => {
  it("cria o tema pedido e o subtema; repetir não duplica", async () => {
    expect(await say(action("create_tema", { nome: "Redes" }), "cria o tema Redes")).toBe("Criei o tema Redes.");
    expect(await say(action("create_tema", { nome: "TCP", pai: "redes" }))).toBe("Criei o tema Redes > TCP.");
    expect(await say(action("create_tema", { nome: "redes" }))).toBe("O tema Redes já existia.");
    expect(await say(action("create_tema", { nome: "X", pai: "nao-existe" }))).toContain("Não achei o tema");
    expect(temaNames()).toEqual(["Redes", "TCP"]);
  });
});

describe("excluir tema por conversa", () => {
  it("tema vazio é excluído direto (lixeira do Notion)", async () => {
    await temas.ensure("Redes", T0);
    const reply = await say(action("delete_tema", { tema: "Redes" }), "exclui o tema Redes");
    expect(reply).toContain("Excluí o tema Redes");
    expect(temaNames()).toEqual([]);
    expect(notion.pages.find((p) => p.database === "db-temas")!.archived).toBe(true); // arquivado, não apagado
  });

  it("com notas ou subtemas pergunta antes; só com confirmar move as notas para o pai (ou Caixa de entrada) e sobe os subtemas", async () => {
    const prog = await temas.ensure("Programação", T0);
    const cs = await temas.ensure("C#", T0, "programacao");
    await temas.ensure("Genéricos", T0, "c-sharp");
    await mk("n-1", "LINQ", cs.tema.pageId);

    const ask = await say(action("delete_tema", { tema: "C#", confirmar: false }), "exclui o tema C#");
    expect(ask).toContain("tem 1 nota(s) e 1 subtema(s)");
    expect(ask).toContain("Confirma?");
    expect(temaNames()).toContain("C#"); // nada mudou

    const done = await say(action("delete_tema", { tema: "C#", confirmar: true }), "sim");
    expect(done).toContain("Excluí o tema Programação > C#");
    expect(done).toContain("Movi 1 nota(s) para Programação");
    expect((await notas.find("n-1"))!.temaId).toBe("programacao");
    const generics = (await temas.list()).find((t) => t.id === "genericos")!;
    expect(generics.parentId).toBe("programacao");
    expect(temaNames()).toEqual(["Genéricos", "Programação"]);
    expect(prog.tema.id).toBe("programacao");
  });

  it("tema de primeiro nível com notas manda as notas para a Caixa de entrada", async () => {
    const redes = await temas.ensure("Redes", T0);
    await mk("n-1", "TCP", redes.tema.pageId);
    const reply = await say(action("delete_tema", { tema: "Redes", confirmar: true }));
    expect(reply).toContain("Movi 1 nota(s) para Caixa de entrada");
    expect((await notas.find("n-1"))!.temaId).toBe("caixa-de-entrada");
  });

  it("a Caixa de entrada não é excluída; tema inexistente avisa", async () => {
    await temas.inbox(T0);
    expect(await say(action("delete_tema", { tema: "Caixa de entrada", confirmar: true }))).toBe("A Caixa de entrada não pode ser excluída.");
    expect(await say(action("delete_tema", { tema: "Culinária" }))).toBe('Não achei o tema "Culinária".');
  });

  it("reenvio do Telegram da mesma exclusão não repete", async () => {
    await temas.ensure("Redes", T0);
    await say(action("delete_tema", { tema: "Redes" }), "x", { messageId: 77 });
    expect(await say(action("delete_tema", { tema: "Redes" }), "x", { messageId: 77 })).toContain("Não achei o tema"); // já foi
    expect(undo.entries).toHaveLength(1);
  });
});

describe("excluir nota por conversa", () => {
  it("arquiva a nota; ID inexistente avisa", async () => {
    const inbox = await temas.inbox(T0);
    await mk("n-1", "CAP", inbox.pageId);
    expect(await say(action("delete_note", { id: "n-1" }), "exclui a nota CAP")).toContain('Excluí a nota "CAP"');
    expect(rows("db-notas")).toHaveLength(0);
    expect(await say(action("delete_note", { id: "zzz" }))).toBe("Não achei essa nota.");
  });
});

describe("desfaz", () => {
  it("desfaz a nota criada (e o tema que ela criou, se ficou vazio)", async () => {
    await say(action("save_note", { titulo: "CAP", resumo: "r", tipo: "conceito", tema: { novo: "System Design" }, conteudo: content }), "texto");
    expect(rows("db-notas")).toHaveLength(1);
    expect(temaNames()).toContain("System Design");
    const reply = await say(action("undo", {}), "desfaz");
    expect(reply).toContain('Desfiz: a nota "CAP" foi para a lixeira');
    expect(reply).toContain("tema que ela tinha criado");
    expect(rows("db-notas")).toHaveLength(0);
    expect(temaNames()).toEqual([]);
  });

  it("desfaz o complemento: remove só os blocos acrescentados", async () => {
    const inbox = await temas.inbox(T0);
    await notas.create({ id: "n-1", title: "CAP", summary: "r", tipo: "conceito", origem: "texto", temaPageId: inbox.pageId, createdAt: T0, blocks: [{ type: "paragraph", paragraph: { rich_text: [] } }] });
    await say(action("append_to_note", { id: "n-1", conteudo: content }), "mais coisas");
    const before = notion.pages.find((p) => p.database === "db-notas")!.children!.length;
    expect(before).toBeGreaterThan(1);
    expect(await say(action("undo", {}))).toContain("tirei o complemento");
    const after = notion.pages.find((p) => p.database === "db-notas")!.children!;
    expect(after).toHaveLength(1);
    expect(after[0]).toEqual({ type: "paragraph", paragraph: { rich_text: [] } });
  });

  it("desfaz a criação de tema, a mudança de tema da nota e a exclusão de tema e de nota", async () => {
    // criar tema
    await say(action("create_tema", { nome: "Redes" }));
    expect(await say(action("undo", {}))).toContain("o tema Redes foi para a lixeira");
    expect(temaNames()).toEqual([]);

    // mover nota
    const a = await temas.ensure("A", T0);
    const b = await temas.ensure("B", T0);
    await mk("n-1", "Nota", a.tema.pageId);
    await say(action("move_note", { id: "n-1", tema: { existente: "b" } }));
    expect((await notas.find("n-1"))!.temaId).toBe("b");
    expect(await say(action("undo", {}))).toContain("devolvi a nota");
    expect((await notas.find("n-1"))!.temaId).toBe("a");

    // excluir tema com nota: undo traz tema e nota de volta
    await say(action("delete_tema", { tema: "A", confirmar: true }));
    expect(temaNames()).toEqual(["B", "Caixa de entrada"]); // as notas foram para a Caixa de entrada
    expect(await say(action("undo", {}))).toContain("o tema A voltou, com 1 nota(s)");
    expect(temaNames()).toEqual(["A", "B", "Caixa de entrada"]);
    expect((await notas.find("n-1"))!.temaId).toBe("a");

    // excluir nota
    await say(action("delete_note", { id: "n-1" }));
    expect(rows("db-notas")).toHaveLength(0);
    expect(await say(action("undo", {}))).toContain('a nota "Nota" voltou');
    expect(rows("db-notas")).toHaveLength(1);
    expect(b.tema.id).toBe("b");
  });

  it("desfaz em ordem (a mais recente primeiro) e avisa quando não há mais nada", async () => {
    await say(action("create_tema", { nome: "Um" }));
    await say(action("create_tema", { nome: "Dois" }));
    await say(action("undo", {}));
    expect(temaNames()).toEqual(["Um"]);
    await say(action("undo", {}));
    expect(temaNames()).toEqual([]);
    expect(await say(action("undo", {}))).toBe("Não tenho nada recente para desfazer.");
  });

  it("reenvio do Telegram do próprio 'desfaz' não desfaz uma segunda ação", async () => {
    await say(action("create_tema", { nome: "Um" }));
    await say(action("create_tema", { nome: "Dois" }));
    expect(await say(action("undo", {}), "desfaz", { messageId: 9001 })).toContain("Dois");
    expect(await say(action("undo", {}), "desfaz", { messageId: 9001 })).toBe("Já desfiz isso.");
    expect(temaNames()).toEqual(["Um"]);
  });

  it("não remove tema que já ganhou notas depois", async () => {
    await say(action("create_tema", { nome: "Redes" }));
    const redes = (await temas.list()).find((t) => t.id === "redes")!;
    await mk("n-1", "TCP", redes.pageId);
    expect(await say(action("undo", {}))).toContain("já tem notas ou subtemas, então não o removi");
    expect(temaNames()).toEqual(["Redes"]);
  });

  it("sem registro de ações avisa que não consegue desfazer, mas as ações funcionam", async () => {
    expect(await say(action("create_tema", { nome: "Redes" }), "x", { undoLog: null })).toBe("Criei o tema Redes.");
    expect(await say(action("undo", {}), "desfaz", { undoLog: null })).toContain("registro das minhas ações está desligado");
  });

  it("Notion recusando o desfazer vira uma resposta clara, não erro", async () => {
    await say(action("create_tema", { nome: "Redes" }));
    notion.failWith = (m, p) => (m === "PATCH" && p.startsWith("/v1/pages/") ? new NotionApiError(404, "object_not_found", "x") : undefined);
    expect(await say(action("undo", {}))).toContain("Não consegui desfazer");
  });

  it("reenvio do mesmo complemento não acrescenta duas vezes", async () => {
    const inbox = await temas.inbox(T0);
    await mk("n-1", "CAP", inbox.pageId);
    await say(action("append_to_note", { id: "n-1", conteudo: content }), "mais", { messageId: 5 });
    const n = notion.pages.find((p) => p.database === "db-notas")!.children!.length;
    expect(await say(action("append_to_note", { id: "n-1", conteudo: content }), "mais", { messageId: 5 })).toContain("já está na nota");
    expect(notion.pages.find((p) => p.database === "db-notas")!.children!.length).toBe(n);
  });
});

describe("validação das ações novas", () => {
  it.each([
    action("create_tema", {}),
    action("delete_tema", {}),
    action("delete_note", { id: "" }),
    action("find_notes", "texto solto"),
  ])("input inválido não executa nada: %j", async (out) => {
    expect(await say(out)).toBe(AI_UNAVAILABLE_TEXT);
    expect(notion.pages).toHaveLength(0);
  });
});

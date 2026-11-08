import { beforeEach, describe, expect, it } from "vitest";
import { FakeNotion } from "../../test/support/fake-notion.js";
import { complementBlocks, mermaid, noteBlocks, type NoteContent } from "../src/notion/blocks.js";
import { NotaNotFound, NotasRepository } from "../src/notion/notas.js";
import { slugify } from "../src/notion/slug.js";
import { INBOX_NAME, TemaError, TemaRepository, temaPath } from "../src/notion/temas.js";

const TEMAS_DB = "db-temas";
const NOTAS_DB = "db-notas";
const T0 = "2026-11-07T18:23:00-03:00";

const t = (s: string) => ({ title: [{ text: { content: s } }] });
const rt = (s: string) => ({ rich_text: [{ text: { content: s } }] });

let notion: FakeNotion;
let temas: TemaRepository;
let notas: NotasRepository;

beforeEach(() => {
  notion = new FakeNotion();
  temas = new TemaRepository(notion, TEMAS_DB);
  notas = new NotasRepository(notion, NOTAS_DB, temas);
});

const nova = (over: Partial<Parameters<NotasRepository["create"]>[0]> = {}) => ({
  id: "telegram-1-10",
  title: "CAP theorem",
  summary: "Consistência, disponibilidade e partição.",
  tipo: "conceito" as const,
  origem: "texto" as const,
  temaPageId: "",
  createdAt: T0,
  blocks: [] as Record<string, unknown>[],
  ...over,
});

describe("slugify", () => {
  it("não confunde C, C# e C++", () => {
    expect(new Set([slugify("C"), slugify("C#"), slugify("C++")]).size).toBe(3);
    expect(slugify("C#")).toBe("c-sharp");
    expect(slugify("Princípios de System Design")).toBe("principios-de-system-design");
  });
});

describe("TemaRepository", () => {
  it("cria tema com ID (slug) e criação; mesmo nome em outra grafia devolve o existente", async () => {
    const a = await temas.ensure("Princípios de System Design", T0);
    expect(a).toMatchObject({ created: true, tema: { id: "principios-de-system-design", name: "Princípios de System Design" } });
    const b = await temas.ensure("  principios  de SYSTEM design ", T0);
    expect(b.created).toBe(false);
    expect(b.tema.pageId).toBe(a.tema.pageId);
    expect(notion.pages).toHaveLength(1);
  });

  it("C# e C++ são temas diferentes", async () => {
    await temas.ensure("C#", T0);
    expect((await temas.ensure("C++", T0)).created).toBe(true);
    expect((await temas.list()).map((x) => x.id).sort()).toEqual(["c-plus-plus", "c-sharp"]);
  });

  it("subtema aponta para o pai; pai inexistente falha; Caixa de entrada não tem subtemas", async () => {
    await temas.ensure("Programação", T0);
    const child = await temas.ensure("C#", T0, "programacao");
    expect(child.tema.parentId).toBe("programacao");
    const listed = await temas.list();
    expect(listed.find((x) => x.id === "c-sharp")!.parentId).toBe("programacao");
    expect(temaPath(listed, listed.find((x) => x.id === "c-sharp")!)).toBe("Programação > C#");
    await expect(temas.ensure("X", T0, "nao-existe")).rejects.toBeInstanceOf(TemaError);
    await temas.inbox(T0);
    await expect(temas.ensure("Y", T0, "caixa-de-entrada")).rejects.toBeInstanceOf(TemaError);
  });

  it("a Caixa de entrada é criada uma vez só", async () => {
    const a = await temas.inbox(T0);
    const b = await temas.inbox(T0);
    expect(a.name).toBe(INBOX_NAME);
    expect(b.pageId).toBe(a.pageId);
    expect(notion.pages).toHaveLength(1);
  });

  it("find por nome ou ID; nome inválido não cria", async () => {
    await temas.ensure("Inglês", T0);
    expect((await temas.find("ingles"))?.name).toBe("Inglês");
    expect((await temas.find("INGLÊS"))?.name).toBe("Inglês");
    expect(await temas.find("???")).toBeNull();
    await expect(temas.ensure("   ", T0)).rejects.toBeInstanceOf(TemaError);
    await expect(temas.ensure("###".replace(/#/g, "!"), T0)).rejects.toBeInstanceOf(TemaError);
  });

  it("linha criada à mão no Notion (sem ID) é aceita com ID derivado", async () => {
    notion.addManual(TEMAS_DB, { Nome: t("Inglês") });
    expect((await temas.list())[0]).toMatchObject({ id: "ingles", name: "Inglês" });
    expect((await temas.ensure("ingles", T0)).created).toBe(false);
  });
});

describe("NotasRepository", () => {
  it("cria com propriedades e corpo, ligada ao tema; repetir o mesmo ID não duplica", async () => {
    const tema = await temas.ensure("System Design", T0);
    const blocks = noteBlocks("Resumo.", { topicos: [{ titulo: "A", pontos: ["b"] }], conceitos: [], lacunas: [] });
    const r = await notas.create(nova({ temaPageId: tema.tema.pageId, blocks }));
    expect(r.created).toBe(true);
    expect(r.nota).toMatchObject({ id: "telegram-1-10", title: "CAP theorem", tipo: "conceito", origem: "texto", estado: "nova", temaId: "system-design", created: T0 });
    expect(r.nota.url).toContain("notion.so");
    expect(notion.pages.find((p) => p.database === NOTAS_DB)!.children).toHaveLength(blocks.length);

    const again = await notas.create(nova({ temaPageId: tema.tema.pageId, title: "Outro título" }));
    expect(again.created).toBe(false);
    expect(again.nota.title).toBe("CAP theorem");
    expect(notion.pages.filter((p) => p.database === NOTAS_DB)).toHaveLength(1);
  });

  it("corpo com mais de 100 blocos é enviado em lotes", async () => {
    const tema = await temas.inbox(T0);
    const many = Array.from({ length: 230 }, (_, i) => ({ type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: `p${i}` } }] } }));
    await notas.create(nova({ temaPageId: tema.pageId, blocks: many }));
    expect(notion.pages.find((p) => p.database === NOTAS_DB)!.children).toHaveLength(230);
  });

  it("recent devolve as mais recentemente alteradas primeiro; find acha por ID", async () => {
    const tema = await temas.inbox(T0);
    await notas.create(nova({ id: "n-1", title: "Primeira", temaPageId: tema.pageId }));
    await notas.create(nova({ id: "n-2", title: "Segunda", temaPageId: tema.pageId }));
    await notas.append(notion.pages.find((p) => p.properties.ID?.rich_text?.[0]?.plain_text === "n-1")!.id, []);
    expect((await notas.recent(10)).map((n) => n.title)).toEqual(["Segunda", "Primeira"]);
    expect((await notas.recent(1))).toHaveLength(1);
    expect((await notas.find("n-1"))?.title).toBe("Primeira");
    expect(await notas.find("n-9")).toBeNull();
  });

  it("search por trecho do título ou do resumo, e por tema (com subtemas)", async () => {
    const sd = await temas.ensure("System Design", T0);
    const cs = await temas.ensure("C#", T0);
    await notas.create(nova({ id: "n-1", title: "CAP theorem", summary: "teorema de sistemas distribuídos", temaPageId: sd.tema.pageId }));
    await notas.create(nova({ id: "n-2", title: "LINQ", summary: "consultas em coleções", temaPageId: cs.tema.pageId }));
    expect((await notas.search({ text: "cap" })).map((n) => n.id)).toEqual(["n-1"]);
    expect((await notas.search({ text: "COLEÇÕES" })).map((n) => n.id)).toEqual(["n-2"]);
    expect((await notas.search({ temaPageIds: [cs.tema.pageId] })).map((n) => n.id)).toEqual(["n-2"]);
    expect((await notas.search({ temaPageIds: [sd.tema.pageId, cs.tema.pageId] })).map((n) => n.id).sort()).toEqual(["n-1", "n-2"]);
    expect((await notas.search({ text: "cap", temaPageIds: [cs.tema.pageId] }))).toEqual([]);
    expect(await notas.search({ text: "nada" })).toEqual([]);
  });

  it("append só acrescenta ao fim; o que já estava na página não muda", async () => {
    const tema = await temas.inbox(T0);
    const first = noteBlocks("R.", { topicos: [{ titulo: "A", pontos: [] }], conceitos: [], lacunas: [] });
    const { nota } = await notas.create(nova({ temaPageId: tema.pageId, blocks: first }));
    const before = structuredClone(notion.pages.find((p) => p.id === nota.pageId)!.children);
    await notas.append(nota.pageId, complementBlocks("08/11/2026", { topicos: [{ titulo: "B", pontos: ["c"] }], conceitos: [], lacunas: [] }));
    const after = notion.pages.find((p) => p.id === nota.pageId)!.children!;
    expect(after.slice(0, before!.length)).toEqual(before);
    expect(after.length).toBeGreaterThan(before!.length);
    expect(JSON.stringify(after.slice(before!.length))).toContain("Complemento, 08/11/2026");
  });

  it("setTema muda só a relação; nota inexistente falha", async () => {
    const a = await temas.ensure("A", T0);
    const b = await temas.ensure("B", T0);
    await notas.create(nova({ temaPageId: a.tema.pageId }));
    notion.calls.length = 0;
    expect((await notas.setTema("telegram-1-10", b.tema.pageId)).temaId).toBe("b");
    expect(Object.keys(notion.calls.find((c) => c.method === "PATCH")!.body.properties)).toEqual(["Tema"]);
    await expect(notas.setTema("nao-existe", b.tema.pageId)).rejects.toBeInstanceOf(NotaNotFound);
  });

  it("linha criada à mão sem ID é ignorada pelo Renato", async () => {
    notion.addManual(NOTAS_DB, { Nome: t("Solta"), Resumo: rt("x") });
    expect(await notas.recent(10)).toEqual([]);
  });
});

describe("blocos", () => {
  const content: NoteContent = {
    topicos: [{ titulo: "Consistência", pontos: ["todos veem o mesmo dado"] }],
    conceitos: [{ termo: "Partição", definicao: "falha de rede entre nós" }],
    diagrama: "flowchart LR\n  A-->B",
    mapaMental: "mindmap\n  root((CAP))",
    lacunas: ["E a latência?"],
    transcricao: "linha 1\n\nlinha 3",
  };
  const kinds = (blocks: Record<string, unknown>[]) => blocks.map((b) => (b.type as string) + (b.type === "heading_2" ? `:${(b.heading_2 as any).rich_text[0].text.content}` : ""));

  it("segue a ordem combinada e marca as sugestões do modelo à parte", () => {
    expect(kinds(noteBlocks("Resumo.", content))).toEqual([
      "paragraph",
      "heading_2:O que entendi", "bulleted_list_item",
      "heading_2:Conceitos-chave", "bulleted_list_item",
      "heading_2:Diagrama", "code",
      "heading_2:Mapa mental", "code",
      "heading_2:Lacunas e perguntas (sugestões do Renato)", "bulleted_list_item",
      "toggle",
    ]);
  });

  it("diagrama usa bloco de código mermaid; transcrição vai num toggle com uma linha por parágrafo", () => {
    const blocks = noteBlocks("", content);
    expect(mermaid("x")).toMatchObject({ type: "code", code: { language: "mermaid" } });
    expect(JSON.stringify(blocks)).toContain('"language":"mermaid"');
    const toggle = blocks.at(-1) as any;
    expect(toggle.toggle.children).toHaveLength(3);
    expect(blocks[0]!.type).toBe("heading_2"); // sem resumo, não abre com parágrafo vazio
  });

  it("textos com mais de 2000 caracteres viram vários trechos (limite do Notion)", () => {
    const long = "x".repeat(4500);
    const [p] = noteBlocks(long, { topicos: [], conceitos: [], lacunas: [] }) as any[];
    expect(p.paragraph.rich_text.map((r: any) => r.text.content.length)).toEqual([2000, 2000, 500]);
  });

  it("complemento abre com a data e não repete o resumo", () => {
    const [h, ...rest] = complementBlocks("08/11/2026", { topicos: [{ titulo: "Novo", pontos: [] }], conceitos: [], lacunas: [] });
    expect((h as any).heading_2.rich_text[0].text.content).toBe("Complemento, 08/11/2026");
    expect(rest.map((b) => b.type)).toEqual(["heading_2", "bulleted_list_item"]);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeNotion } from "../../test/support/fake-notion.js";
import { createNotionCommands, pageIdFromText } from "../src/notion/commands.js";
import { NotasRepository } from "../src/notion/notas.js";
import { TemaRepository } from "../src/notion/temas.js";

const EPOCH = Date.parse("2026-11-07T21:23:00Z") / 1000;
const T0 = "2026-11-07T18:23:00-03:00";
const turn = { text: "", chatId: 7, messageId: 1, epochSeconds: EPOCH };

let notion: FakeNotion;
let temas: TemaRepository;
let notas: NotasRepository;
let cmd: ReturnType<typeof createNotionCommands>;

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  notion = new FakeNotion();
  temas = new TemaRepository(notion, "db-temas");
  notas = new NotasRepository(notion, "db-notas", temas);
  cmd = createNotionCommands({ temas, notas });
});

const nota = async (id: string, title: string, temaPageId: string, summary = "") =>
  notas.create({ id, title, summary, tipo: "conceito", origem: "texto", temaPageId, createdAt: T0, blocks: [] });

describe("pageIdFromText", () => {
  it("pega o ID de 32 caracteres no fim do link; ignora o resto", () => {
    expect(pageIdFromText("Anotei: X\nTema: Y\nhttps://app.notion.com/p/Nota-x-41263ec9e8d281b2b5fde9169681b892")).toBe("41263ec9e8d281b2b5fde9169681b892");
    expect(pageIdFromText("https://www.notion.so/41263ec9e8d281b2b5fde9169681b892?pvs=4")).toBe("41263ec9e8d281b2b5fde9169681b892");
    expect(pageIdFromText("sem link")).toBeNull();
    expect(pageIdFromText("https://exemplo.com/41263ec9e8d281b2b5fde9169681b892")).toBeNull();
    expect(pageIdFromText(undefined)).toBeNull();
  });
});

describe("/tema", () => {
  it("cria o tema; repetir avisa que já existia; sem argumento mostra a árvore", async () => {
    expect(await cmd.tema(turn, "System Design")).toBe("Criei o tema System Design.");
    expect(await cmd.tema(turn, "system   design")).toBe("O tema System Design já existia.");
    expect(await cmd.tema(turn, "")).toContain("- System Design");
    expect(await cmd.tema(turn, "")).toContain("Uso: /tema");
  });

  it("'Pai > Filho' cria cada nível dentro do anterior", async () => {
    expect(await cmd.tema(turn, "Programação > C# > Genéricos")).toBe("Criei o tema Programação > C# > Genéricos.");
    const all = await temas.list();
    expect(all.find((t) => t.id === "genericos")!.parentId).toBe("c-sharp");
    expect(all.find((t) => t.id === "c-sharp")!.parentId).toBe("programacao");
    expect(await cmd.tema(turn, "Programação > C#")).toBe("O tema Programação > C# já existia.");
  });

  it("nome inválido ou 'Caixa de entrada' como pai não criam nada", async () => {
    expect(await cmd.tema(turn, "A > > B")).toContain("Uso: /tema");
    expect(await cmd.tema(turn, "Caixa de entrada > Filho")).toContain("Caixa de entrada não pode ter subtemas");
    expect(await cmd.tema(turn, "###".replace(/#/g, "?"))).toContain("sem letras ou números");
  });

  it("em resposta à mensagem de uma nota (link com o ID de 32 hex), move a nota; já estando no tema, só avisa", async () => {
    const inbox = await temas.inbox(T0);
    const { nota: n } = await nota("n-1", "CAP theorem", inbox.pageId);
    // O fake usa IDs "page-N"; troca por um ID de 32 hex para imitar o Notion.
    const page = notion.pages.find((p) => p.id === n.pageId)!;
    page.id = "41263ec9e8d281b2b5fde9169681b892";
    const link = "Anotei: CAP theorem\nhttps://app.notion.com/p/CAP-theorem-41263ec9e8d281b2b5fde9169681b892";

    const moved = await cmd.tema(turn, "System Design", link);
    expect(moved).toContain('Movi "CAP theorem" para esse tema.');
    expect((await notas.find("n-1"))!.temaId).toBe("system-design");
    expect(await cmd.tema(turn, "System Design", link)).toContain("já está nesse tema");
  });

  it("link de página que não é uma nota do Renato não move nada", async () => {
    const t = await temas.inbox(T0);
    const alheia = notion.pages.find((p) => p.id === t.pageId)!;
    alheia.id = "41263ec9e8d281b2b5fde9169681b893"; // página do banco Temas, não de Notas
    const reply = await cmd.tema(turn, "X", "https://www.notion.so/Algo-41263ec9e8d281b2b5fde9169681b893");
    expect(reply).toContain("não movi nada");
  });
});

describe("/notas", () => {
  beforeEach(async () => {
    const sd = await temas.ensure("System Design", T0);
    const cs = await temas.ensure("C#", T0);
    const gen = await temas.ensure("Genéricos", T0, "c-sharp");
    await nota("n-1", "CAP theorem", sd.tema.pageId, "sistemas distribuídos");
    await nota("n-2", "LINQ", cs.tema.pageId, "consultas");
    await nota("n-3", "Variância", gen.tema.pageId, "in e out");
  });

  it("sem argumento lista as recentes, a mais recente primeiro", async () => {
    const out = await cmd.notas("");
    expect(out).toContain("Achei 3:");
    expect(out.indexOf("Variância")).toBeLessThan(out.indexOf("CAP theorem"));
  });

  it("com o nome de um tema lista as notas dele e dos subtemas", async () => {
    const out = await cmd.notas("c#");
    expect(out).toContain("Achei 2:");
    expect(out).toContain("LINQ");
    expect(out).toContain("Variância");
    expect(out).not.toContain("CAP");
  });

  it("com outro texto busca no título e no resumo; sem resultado avisa", async () => {
    expect(await cmd.notas("distribuídos")).toContain("CAP theorem");
    expect(await cmd.notas("zzzz")).toBe('Não achei nada para "zzzz".');
  });

  it("tema sem notas e banco vazio têm respostas claras", async () => {
    await temas.ensure("Vazio", T0);
    expect(await cmd.notas("vazio")).toBe("Não há notas no tema Vazio.");
    const empty = new FakeNotion();
    const t2 = new TemaRepository(empty, "t");
    const c2 = createNotionCommands({ temas: t2, notas: new NotasRepository(empty, "n", t2) });
    expect(await c2.notas("")).toBe("Você ainda não tem notas.");
  });
});

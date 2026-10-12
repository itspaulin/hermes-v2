import { describe, expect, it } from "vitest";
import { NoteFormatError, parseNote, serializeNote } from "../src/markdown.js";
import { InMemoryNoteRepository, NoteRepositoryError } from "../src/repository.js";
import type { Note } from "../src/types.js";

const base: Note = {
  id: "n1",
  originalContent: "texto",
  category: null,
  tags: [],
  createdAt: "2026-01-15T15:30:00.000Z",
  updatedAt: "2026-01-15T15:30:00.000Z",
  source: { kind: "manual" },
};

const roundTrip = (n: Note) => parseNote(serializeNote(n));

describe("round-trip Note → Markdown → Note", () => {
  it("nota mínima com categoria nula", () => {
    expect(roundTrip(base)).toEqual(base);
  });

  it("nota completa com acentos, tags, projeto, origem e conteúdo organizado diferente", () => {
    const n: Note = {
      ...base,
      originalContent: "  ideia:  ação — coração #estudo @hermes  \n",
      organizedContent: "Ação — coração",
      category: "ideia",
      tags: ["estudo", "açaí"],
      project: "hermes",
      source: { kind: "telegram", messageId: "42" },
      updatedAt: "2026-01-16T10:00:00.000Z",
    };
    expect(roundTrip(n)).toEqual(n);
  });

  it("conteúdo multilinha, linhas em branco e finais preservados", () => {
    const n = { ...base, originalContent: "\n\nlinha 1\n\n\nlinha 3\n\n" };
    expect(roundTrip(n).originalContent).toBe(n.originalContent);
  });

  it("conteúdo que imita estrutura do formato (frontmatter, títulos, cercas)", () => {
    const tricky = "---\nid: x\n---\n\n## Conteúdo organizado\n\n```\nfoo\n```\n````\n";
    const n = { ...base, originalContent: tricky, organizedContent: "```\n" + tricky };
    expect(roundTrip(n)).toEqual(n);
  });

  it("CRLF preservado", () => {
    const n = { ...base, originalContent: "a\r\nb\r\n" };
    expect(roundTrip(n).originalContent).toBe("a\r\nb\r\n");
  });

  it("serialização é determinística e estável após reserializar", () => {
    const n = { ...base, category: "estudo" as const, tags: ["b", "a"], organizedContent: "x" };
    const md = serializeNote(n);
    expect(serializeNote(n)).toBe(md);
    expect(serializeNote(parseNote(md))).toBe(md);
  });

  it("formato legível e estável", () => {
    expect(serializeNote({ ...base, category: "ideia", tags: ["a"], project: "p" })).toBe(
      [
        "---",
        'id: "n1"',
        'category: "ideia"',
        'tags: ["a"]',
        'project: "p"',
        'source: "manual"',
        'createdAt: "2026-01-15T15:30:00.000Z"',
        'updatedAt: "2026-01-15T15:30:00.000Z"',
        "---",
        "",
        "## Conteúdo original",
        "",
        "```",
        "texto",
        "```",
        "",
      ].join("\n"),
    );
  });
});

describe("erros explícitos", () => {
  const valid = serializeNote({ ...base, organizedContent: "org" });

  it("serializar nota inválida lança", () => {
    expect(() => serializeNote({ ...base, originalContent: " " })).toThrow(/originalContent/);
    expect(() => serializeNote({ ...base, organizedContent: "" })).toThrow(/organizedContent/);
  });

  it.each([
    ["sem frontmatter", "texto solto", /Frontmatter ausente/],
    ["frontmatter não fechado", "---\nid: \"a\"\n", /sem fechamento/],
    ["metadado desconhecido", valid.replace('id: "n1"', 'id: "n1"\nextra: 1'), /desconhecido: extra/],
    ["metadado ausente", valid.replace('id: "n1"\n', ""), /ausente: id/],
    ["metadado duplicado", valid.replace('id: "n1"', 'id: "n1"\nid: "n1"'), /duplicado: id/],
    ["JSON inválido", valid.replace('"manual"', "manual"), /não é JSON válido/],
    ["categoria inválida", valid.replace("null", '"foo"'), /categoria inválida/],
    ["data inválida", valid.replace("2026-01-15T15:30:00.000Z", "ontem"), /createdAt inválido/],
    ["sem bloco original", valid.replace("## Conteúdo original", "## Outro"), /Esperado "## Conteúdo original"/],
    ["cerca não fechada", valid.replace("```\norg\n```\n", "```\norg\n"), /sem cerca de fechamento/],
    ["lixo no final", valid + "lixo\n", /inesperado/],
    ["organizado vazio", valid.replace("```\norg\n```", "```\n\n```"), /vazio/],
  ])("%s", (_n, md, re) => {
    const act = () => parseNote(md);
    expect(act).toThrow(NoteFormatError);
    expect(act).toThrow(re);
  });
});

describe("InMemoryNoteRepository", () => {
  it("create/get/update/list", async () => {
    const repo = new InMemoryNoteRepository();
    const b = { ...base, id: "b", createdAt: "2026-01-16T00:00:00.000Z", updatedAt: "2026-01-16T00:00:00.000Z" };
    await repo.create(b);
    await repo.create(base);
    expect(await repo.get("n1")).toEqual(base);
    expect(await repo.get("zzz")).toBeNull();
    expect((await repo.list()).map((n) => n.id)).toEqual(["n1", "b"]);

    const updated = { ...base, tags: ["x"], updatedAt: "2026-02-01T00:00:00.000Z" };
    await repo.update(updated);
    expect(await repo.get("n1")).toEqual(updated);
  });

  it("não sobrescreve nem atualiza inexistente em silêncio", async () => {
    const repo = new InMemoryNoteRepository();
    await repo.create(base);
    await expect(repo.create({ ...base, originalContent: "outro" })).rejects.toThrow(/já existe/);
    expect((await repo.get("n1"))?.originalContent).toBe("texto");
    await expect(repo.update({ ...base, id: "nope" })).rejects.toThrow(/não encontrada/);
  });

  it("não guarda referência mutável ao objeto", async () => {
    const repo = new InMemoryNoteRepository();
    const n = { ...base, tags: ["a"] };
    await repo.create(n);
    n.tags.push("b");
    expect((await repo.get("n1"))?.tags).toEqual(["a"]);
  });

  it("nota armazenada inválida gera erro acionável em get e list", async () => {
    const repo = new InMemoryNoteRepository({ bad: "lixo" });
    await expect(repo.get("bad")).rejects.toThrow(NoteRepositoryError);
    await expect(repo.list()).rejects.toThrow(/Nota "bad" inválida: Frontmatter ausente/);
  });

  it("id divergente da chave é erro", async () => {
    const repo = new InMemoryNoteRepository({ other: serializeNote(base) });
    await expect(repo.get("other")).rejects.toThrow(/difere da chave/);
  });
});

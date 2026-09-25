import { describe, expect, it } from "vitest";
import { VaultInvalidNote } from "../src/vault/errors.js";
import { parseNote, renderNote, serializeNote, setScalar } from "../src/vault/frontmatter.js";

const P = "Hermes/tarefas/2026-09-25-x.md";

describe("parseNote: recusa o que não entende", () => {
  it.each([
    ["sem frontmatter", "# só corpo\n"],
    ["sem fechamento", "---\nid: x\n# corpo\n"],
    ["frontmatter vazio", "---\n---\ncorpo"],
    ["BOM no início", "﻿---\nid: x\n---\n"],
    ["cerca com espaço", "--- \nid: x\n---\n"],
    ["YAML inválido", "---\nid: [x\n---\n"],
    ["não é mapa", "---\n- a\n- b\n---\n"],
    ["chave duplicada", "---\nid: a\nid: b\n---\n"],
    ["vazio", ""],
  ])("%s", (_n, content) => {
    expect(() => parseNote(content, P)).toThrow(VaultInvalidNote);
  });
});

describe("preservação", () => {
  const original = [
    "---",
    "# comentário no topo",
    "id: 2026-09-25-x",
    "custom_zeta: valor",
    "",
    "title: \"Título: com dois pontos\" # comentário na linha",
    "status: pendente # inline",
    "tags:",
    "  - a",
    "  - b",
    "flow: [1, 2, 3]",
    "nota: |",
    "  linha 1",
    "  linha 2",
    "custom_alfa: 42",
    "# comentário no fim",
    "---",
    "",
    "# Corpo",
    "",
    "Minha anotação manual.",
    "",
    "<!-- comentário meu -->",
    "",
    "---",
    "- CAP",
    "- sharding",
    "",
  ].join("\n");

  it("sem alterar nada, reserializa idêntico", () => {
    expect(serializeNote(parseNote(original, P))).toBe(original);
  });

  it("alterar status muda SÓ a linha do status e acrescenta updated: todo o resto, byte a byte", () => {
    const note = parseNote(original, P);
    setScalar(note, "status", "feita");
    setScalar(note, "updated", "2026-09-25T15:10:00-03:00");
    const expected = original
      .replace("status: pendente # inline", "status: feita # inline")
      .replace("# comentário no fim\n---", "# comentário no fim\nupdated: 2026-09-25T15:10:00-03:00\n---");
    expect(serializeNote(note)).toBe(expected);
  });

  it("valor novo é relido corretamente", () => {
    const note = parseNote(original, P);
    setScalar(note, "status", "feita");
    expect(note.data.status).toBe("feita");
    expect(note.data.custom_alfa).toBe(42);
    expect(note.data.flow).toEqual([1, 2, 3]);
  });

  it("chave nova entra no fim do mapa, depois das existentes", () => {
    const note = parseNote("---\nid: a\nz: 1\n---\nc", P);
    setScalar(note, "updated", "u");
    expect(serializeNote(note)).toBe("---\nid: a\nz: 1\nupdated: u\n---\nc");
  });

  it("corpo vazio, com e sem quebra final", () => {
    for (const c of ["---\nid: a\n---", "---\nid: a\n---\n"]) {
      const note = parseNote(c, P);
      setScalar(note, "status", "feita");
      const out = serializeNote(note);
      expect(out).toBe(c.replace("id: a", "id: a\nstatus: feita"));
    }
  });

  it("corpo com CRLF, unicode, emoji e '---' internos fica intacto", () => {
    const body = "\r\n# Ação 日本語 🚀\r\n\r\n---\r\ntexto\t\ttab  \r\n";
    const note = parseNote(`---\nid: a\n---${body}`, P);
    setScalar(note, "status", "feita");
    expect(serializeNote(note).endsWith(body)).toBe(true);
  });

  it("arquivo inteiro em CRLF continua em CRLF", () => {
    const c = "---\r\nid: a\r\nstatus: pendente\r\n---\r\n\r\ncorpo\r\n";
    const note = parseNote(c, P);
    setScalar(note, "status", "feita");
    expect(serializeNote(note)).toBe("---\r\nid: a\r\nstatus: feita\r\n---\r\n\r\ncorpo\r\n");
  });

  it("valor citado mantém o estilo; título longo não é dobrado", () => {
    const long = "palavra ".repeat(40).trim();
    const c = `---\ntitle: '${long}'\nstatus: "pendente"\n---\n`;
    const note = parseNote(c, P);
    setScalar(note, "status", "feita");
    expect(serializeNote(note)).toBe(`---\ntitle: '${long}'\nstatus: "feita"\n---\n`);
  });
});

describe("renderNote", () => {
  it("cita strings problemáticas e faz round-trip", () => {
    const fields = { id: "a", title: "Título: com # símbolos e 'aspas' \"duplas\"", status: "pendente", n: 1 };
    const note = parseNote(renderNote(fields, "\n# x\n"), P);
    expect(note.data).toEqual(fields);
    expect(note.tail).toBe("\n\n# x\n");
  });

  it("não dobra títulos longos", () => {
    const title = "x".repeat(300);
    expect(renderNote({ title }, "")).toContain(`title: ${title}\n`);
  });
});

describe("setScalar: recusa em vez de arriscar", () => {
  it.each([
    ["bloco literal", "status: |\n  pendente\n"],
    ["valor em linha seguinte", "status:\n  pendente\n"],
    ["coleção", "status: [a, b]\n"],
    ["chave entre aspas", '"status": pendente\n'],
    ["aspas que não fecham na linha", 'status: "pen\n  dente"\n'],
    ["âncora", "status: &a pendente\n"],
  ])("%s", (_n, yaml) => {
    const note = parseNote(`---\nid: a\n${yaml}---\ncorpo`, P);
    expect(() => setScalar(note, "status", "feita")).toThrow(VaultInvalidNote);
    expect(serializeNote(note)).toBe(`---\nid: a\n${yaml}---\ncorpo`); // não alterou nada
  });

  it("valor multilinha ou chave inválida", () => {
    const note = parseNote("---\nid: a\n---\n", P);
    expect(() => setScalar(note, "x", "a\nb")).toThrow(VaultInvalidNote);
    expect(() => setScalar(note, "Chave Ruim", "a")).toThrow(VaultInvalidNote);
  });

  it("valores que exigem aspas são escapados e relidos idênticos", () => {
    const note = parseNote("---\nid: a\n---\n", P);
    setScalar(note, "x", "com: dois pontos # e hash");
    expect(note.data.x).toBe("com: dois pontos # e hash");
  });

  it("aspas simples com apóstrofo escapado", () => {
    const note = parseNote("---\nt: 'it''s'\n---\n", P);
    setScalar(note, "t", "l'a");
    expect(serializeNote(note)).toBe("---\nt: 'l''a'\n---\n");
  });
});

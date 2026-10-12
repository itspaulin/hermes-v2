import { describe, expect, it } from "vitest";
import { fixedClock } from "../src/clock.js";
import { captureNote } from "../src/note.js";
import { type Note, validateNote } from "../src/types.js";

const clock = fixedClock("2026-01-15T15:30:00Z");
const source = { kind: "telegram", messageId: "42" } as const;

describe("captureNote", () => {
  it("preserva o conteúdo original exatamente", () => {
    const raw = "  ideia:   texto   com\nquebra  ";
    const note = captureNote({ id: "n1", content: raw, source }, clock);
    expect(note.originalContent).toBe(raw);
    expect(note.organizedContent).toBe("texto com quebra");
    expect(note.category).toBe("ideia");
  });

  it("define timestamps explícitos a partir do relógio injetado", () => {
    const note = captureNote({ id: "n1", content: "oi", source }, clock);
    expect(note.createdAt).toBe("2026-01-15T15:30:00.000Z");
    expect(note.updatedAt).toBe(note.createdAt);
  });

  it("conteúdo ambíguo fica sem categoria e sem organizedContent redundante", () => {
    const note = captureNote({ id: "n1", content: "algo", source }, clock);
    expect(note.category).toBeNull();
    expect(note.organizedContent).toBeUndefined();
  });

  it("rejeita conteúdo vazio", () => {
    expect(() => captureNote({ id: "n1", content: "   ", source }, clock)).toThrow(/originalContent/);
  });
});

describe("validateNote", () => {
  const valid: Note = {
    id: "n1",
    originalContent: "x",
    category: null,
    tags: [],
    createdAt: "2026-01-15T15:30:00.000Z",
    updatedAt: "2026-01-15T15:30:00.000Z",
    source,
  };

  it("aceita nota válida", () => {
    expect(validateNote(valid)).toEqual([]);
  });

  it("detecta problemas", () => {
    const bad = { ...valid, id: "", category: "outra" as never, createdAt: "ontem" };
    const errors = validateNote(bad);
    expect(errors).toContain("id vazio");
    expect(errors).toContain("categoria inválida");
    expect(errors).toContain("createdAt inválido");
  });

  it("rejeita updatedAt anterior a createdAt", () => {
    expect(validateNote({ ...valid, updatedAt: "2026-01-14T00:00:00.000Z" })).toContain(
      "updatedAt anterior a createdAt",
    );
  });
});

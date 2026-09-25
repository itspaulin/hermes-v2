import { describe, expect, it } from "vitest";
import { VaultPathViolation } from "../src/vault/errors.js";
import { assertHermesDir, assertHermesPath } from "../src/vault/paths.js";
import { isSlug, slugify } from "../src/vault/slug.js";

const ok = (p: string) => expect(() => assertHermesPath(p), p).not.toThrow();
const bad = (p: unknown) => expect(() => assertHermesPath(p), String(p)).toThrow(VaultPathViolation);

describe("assertHermesPath: permitidos", () => {
  it.each([
    "Hermes/metas/melhorar-linkedin.md",
    "Hermes/tarefas/2026-09-25-estudar-system-design.md",
    "Hermes/checkins/2026/2026-09-25-checkin.md",
    "Hermes/checkins/2026/2026-09-25-metrics.md",
    "Hermes/revisoes/2026-W39.md",
    "Hermes/revisoes/2026-W01.md",
    "Hermes/revisoes/2026-W53.md",
    "Hermes/tarefas/2028-02-29-bissexto.md",
  ])("%s", ok);
});

describe("assertHermesPath: fora da fronteira", () => {
  it.each([
    "../segredo.md",
    "metas/x.md",
    "Hermes/../segredo.md",
    "Hermes2/metas/x.md",
    "Hermes/tarefas/../../x.md",
    "hermes/metas/x.md",
    "/Hermes/metas/x.md",
    "Hermes",
    "Hermes/",
    "Hermes/metas",
    "Hermes/pessoal/x.md",
    "Hermes/.obsidian/x.md",
    "pessoal/x.md",
    "Hermes/metas/../../pessoal/x.md",
    "Hermes/./metas/x.md",
    "Hermes//metas/x.md",
    "Hermes/metas//x.md",
    "Hermes/metas/x.md/",
  ])("%s", bad);
});

describe("assertHermesPath: formato", () => {
  it.each([
    "Hermes/metas/x.txt",
    "Hermes/metas/x",
    "Hermes/metas/.md",
    "Hermes/metas/X.md", // maiúscula
    "Hermes/metas/a_b.md",
    "Hermes/metas/-a.md",
    "Hermes/metas/a--b.md",
    "Hermes/metas/a/b.md", // subpasta
    `Hermes/metas/${"a".repeat(61)}.md`,
    "Hermes/tarefas/estudar.md", // sem data
    "Hermes/tarefas/2026-02-30-x.md", // data inexistente
    "Hermes/tarefas/2026-9-5-x.md",
    "Hermes/tarefas/2026-09-25-.md",
    "Hermes/tarefas/2026-09-25-X.md",
    "Hermes/checkins/2026-09-25-checkin.md", // sem pasta do ano
    "Hermes/checkins/2026/2025-09-25-checkin.md", // ano difere
    "Hermes/checkins/2026/2026-09-25-outro.md",
    "Hermes/checkins/26/2026-09-25-checkin.md",
    "Hermes/revisoes/2026-W00.md",
    "Hermes/revisoes/2026-W54.md",
    "Hermes/revisoes/2026-39.md",
  ])("%s", bad);
});

describe("assertHermesPath: caracteres e tipos hostis", () => {
  it.each([
    "Hermes/metas/x.md\0",
    "Hermes/metas/x.md\n",
    "Hermes/metas/x .md",
    "Hermes\\metas\\x.md",
    "Hermes/metas/ação.md",
    "Hermes/metas/x.md%2e",
    "Hermes/metas/%2e%2e/x.md",
    "Hermes/metas/x‮.md",
    "Hermes/metas/ｘ.md", // fullwidth
    "",
    " ",
    "Hermes/tarefas/../../x.md".replace("..", "‥"),
  ])("%j", bad);

  it.each([undefined, null, 42, {}, ["Hermes/metas/x.md"]])("não-string %j", bad);

  it("comprimento absurdo", () => bad(`Hermes/metas/${"a".repeat(500)}.md`));

  it("mensagem de erro escapa caracteres de controle", () => {
    try {
      assertHermesPath("Hermes/metas/x\n.md");
    } catch (e) {
      expect((e as Error).message).not.toContain("\n");
      return;
    }
    throw new Error("deveria lançar");
  });
});

describe("assertHermesDir", () => {
  it.each(["Hermes/metas", "Hermes/tarefas", "Hermes/checkins", "Hermes/revisoes", "Hermes/checkins/2026"])(
    "permite %s",
    (d) => expect(() => assertHermesDir(d)).not.toThrow(),
  );

  it.each([
    "Hermes",
    "Hermes/",
    "Hermes/metas/",
    "",
    "..",
    "Hermes/..",
    "Hermes/metas/..",
    "Hermes/checkins/../..",
    "Hermes/checkins/26",
    "Hermes/checkins/2026/2026-09-25-checkin.md",
    "Hermes/pessoal",
    "Hermes2/metas",
    "Hermes/tarefas/x",
    "Hermes/revisoes/2026",
  ])("rejeita %j", (d) => expect(() => assertHermesDir(d)).toThrow(VaultPathViolation));
});

describe("slugify", () => {
  it.each([
    ["Estudar System Design", "estudar-system-design"],
    ["Ação: revisão de código!", "acao-revisao-de-codigo"],
    ["  --Melhorar   LinkedIn--  ", "melhorar-linkedin"],
    ["café_com_leite", "cafe-com-leite"],
    ["A/B test #2", "a-b-test-2"],
    ["Olá 👋 mundo", "ola-mundo"],
  ])("%j -> %s", (input, expected) => {
    expect(slugify(input)).toBe(expected);
    expect(isSlug(slugify(input))).toBe(true);
  });

  it("limita a 60 e não termina em '-'", () => {
    const s = slugify(`${"a".repeat(59)} bbbb`);
    expect(s.length).toBeLessThanOrEqual(60);
    expect(s.endsWith("-")).toBe(false);
    expect(isSlug(s)).toBe(true);
  });

  it.each(["", "   ", "!!!", "👋👋", "---"])("sem caracteres aproveitáveis %j: erro", (t) => {
    expect(() => slugify(t)).toThrow();
  });

  it("é determinístico", () => expect(slugify("Meu Título")).toBe(slugify("Meu Título")));

  it("todo slug gerado é aceito pela guarda", () => {
    for (const t of ["Ação", "x", "a b c", "Ñandú 2026", "z".repeat(200)]) {
      ok(`Hermes/metas/${slugify(t)}.md`);
    }
  });
});

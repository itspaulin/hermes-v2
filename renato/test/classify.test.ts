import { describe, expect, it } from "vitest";
import { classify } from "../src/classify.js";

describe("classify", () => {
  it("confirma categoria por prefixo", () => {
    expect(classify("ideia: app de receitas").category).toBe("ideia");
    expect(classify("Referência: artigo sobre Lambda").category).toBe("referencia");
  });

  it("remove prefixo do conteúdo organizado", () => {
    expect(classify("estudo:   cap.  3  de   grafos").organizedContent).toBe("cap. 3 de grafos");
  });

  it("confirma categoria por hashtag", () => {
    const r = classify("rever contrato #trabalho #urgente");
    expect(r.category).toBe("trabalho");
    expect(r.tags).toEqual(["urgente"]);
  });

  it("texto ambíguo fica sem categoria", () => {
    expect(classify("preciso pensar sobre isso").category).toBeNull();
  });

  it("marcadores conflitantes ficam sem categoria", () => {
    expect(classify("ideia: algo #estudo").category).toBeNull();
  });

  it("não infere categoria de palavras soltas", () => {
    expect(classify("tenho uma ideia sobre o trabalho").category).toBeNull();
  });

  it("prefixo desconhecido não é removido", () => {
    const r = classify("nota: algo");
    expect(r.category).toBeNull();
    expect(r.organizedContent).toBe("nota: algo");
  });

  it("extrai tags sem duplicar e projeto único", () => {
    const r = classify("nota #a #A #b @hermes");
    expect(r.tags).toEqual(["a", "b"]);
    expect(r.project).toBe("hermes");
  });

  it("projetos distintos são ambíguos", () => {
    expect(classify("@a e @b").project).toBeUndefined();
  });

  it("é determinístico", () => {
    expect(classify("ideia: x #t")).toEqual(classify("ideia: x #t"));
  });
});

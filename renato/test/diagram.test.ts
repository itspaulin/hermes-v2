import { describe, expect, it } from "vitest";
import { diagramToMermaid, mindMapToMermaid, normalizeDiagram, normalizeMindMap } from "../src/notion/diagram.js";

describe("diagrama de arquitetura", () => {
  const spec = normalizeDiagram({
    direcao: "LR",
    nos: [
      { id: "client", rotulo: "Cliente", forma: "caixa" },
      { id: "api", rotulo: "API Gateway", forma: "redondo" },
      { id: "db", rotulo: "Banco", forma: "banco" },
    ],
    ligacoes: [{ de: "client", para: "api", rotulo: "HTTPS" }, { de: "api", para: "db" }],
    grupos: [{ titulo: "Backend", nos: ["api", "db"] }],
  })!;

  it("gera flowchart com IDs próprios, formas, rótulo de ligação e grupo", () => {
    expect(diagramToMermaid(spec)).toBe(
      [
        "flowchart LR",
        '  subgraph g1["Backend"]',
        '    n2("API Gateway")',
        '    n3[("Banco")]',
        "  end",
        '  n1["Cliente"]',
        '  n1 -->|"HTTPS"| n2',
        "  n2 --> n3",
      ].join("\n"),
    );
  });

  it("rótulos com aspas, quebras de linha e código não quebram a sintaxe", () => {
    const s = normalizeDiagram({ nos: [{ id: "a", rotulo: 'Serviço "X"\nend\n  A --> B' }, { id: "b", rotulo: "B" }], ligacoes: [{ de: "a", para: "b", rotulo: '"|' }] })!;
    const out = diagramToMermaid(s);
    expect(out.split("\n").length).toBe(4); // cabeçalho, 2 nós, 1 ligação: nada injetou linhas
    expect(out).not.toMatch(/"[^"\n]*"[^"\n]*"[^|\]\)\n]/);
    expect(out).toContain("Serviço 'X' end A --> B");
  });

  it("descarta o que não serve em vez de recusar tudo: ligação para nó inexistente, duplicatas, nós sem rótulo", () => {
    const s = normalizeDiagram({
      nos: [{ id: "a", rotulo: "A" }, { id: "a", rotulo: "A de novo" }, { id: "b", rotulo: "B" }, { id: "c", rotulo: "  " }, 5],
      ligacoes: [{ de: "a", para: "b" }, { de: "a", para: "b" }, { de: "a", para: "zzz" }],
      grupos: [{ titulo: "G", nos: ["zzz"] }],
    })!;
    expect(s.nos.map((n) => n.id)).toEqual(["a", "b"]);
    expect(s.ligacoes).toEqual([{ de: "a", para: "b" }]);
    expect(s.grupos).toEqual([]);
  });

  it("sem pelo menos 2 nós válidos não há diagrama", () => {
    expect(normalizeDiagram({ nos: [{ id: "a", rotulo: "A" }] })).toBeUndefined();
    expect(normalizeDiagram("flowchart LR\n A-->B")).toBeUndefined();
    expect(normalizeDiagram(null)).toBeUndefined();
  });

  it("respeita os limites de nós e de tamanho do rótulo", () => {
    const nos = Array.from({ length: 80 }, (_, i) => ({ id: `n${i}`, rotulo: "x".repeat(200) }));
    const s = normalizeDiagram({ nos })!;
    expect(s.nos).toHaveLength(40);
    expect(s.nos[0]!.rotulo).toHaveLength(80);
  });
});

describe("mapa mental", () => {
  it("vira árvore de flowchart", () => {
    const m = normalizeMindMap({ raiz: "CAP", ramos: [{ rotulo: "Consistência", filhos: [{ rotulo: "Forte" }] }, { rotulo: "Disponibilidade" }] })!;
    expect(mindMapToMermaid(m)).toBe(
      ['flowchart LR', '  r0(("CAP"))', '  m1["Consistência"]', "  r0 --> m1", '  m2["Forte"]', "  m1 --> m2", '  m3["Disponibilidade"]', "  r0 --> m3"].join("\n"),
    );
  });

  it("limita profundidade (4) e quantidade (50); sem ramos ou sem raiz não há mapa", () => {
    let deep: unknown = { rotulo: "f" };
    for (let i = 0; i < 10; i++) deep = { rotulo: `n${i}`, filhos: [deep] };
    const m = normalizeMindMap({ raiz: "R", ramos: [deep] })!;
    const depth = (n: { filhos: any[] }): number => 1 + Math.max(0, ...n.filhos.map(depth));
    expect(Math.max(...m.ramos.map(depth))).toBe(4);
    const many = normalizeMindMap({ raiz: "R", ramos: Array.from({ length: 100 }, (_, i) => ({ rotulo: `r${i}` })) })!;
    expect(many.ramos).toHaveLength(50);
    expect(normalizeMindMap({ raiz: "R", ramos: [] })).toBeUndefined();
    expect(normalizeMindMap({ ramos: [{ rotulo: "a" }] })).toBeUndefined();
  });

  it("rótulo com aspas não quebra", () => {
    expect(mindMapToMermaid(normalizeMindMap({ raiz: 'R"', ramos: [{ rotulo: 'a"b' }] })!)).toContain(`"a'b"`);
  });
});

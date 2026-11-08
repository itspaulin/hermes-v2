/**
 * Diagramas e mapas mentais como DADOS (nós e ligações), nunca como código escrito pelo modelo: o código
 * gera o Mermaid, com rótulos entre aspas e IDs próprios, então saída torta do modelo não vira
 * "Syntax error" no Notion nem injeta nada. (O `mindmap` do Mermaid não renderiza no Notion; o mapa
 * mental sai como árvore em `flowchart`.)
 */
export type Shape = "caixa" | "banco" | "redondo";

export interface DiagramSpec {
  direcao: "LR" | "TD";
  nos: { id: string; rotulo: string; forma: Shape }[];
  ligacoes: { de: string; para: string; rotulo?: string }[];
  /** Agrupamentos (ex.: "Backend") com os IDs dos nós que contêm. */
  grupos: { titulo: string; nos: string[] }[];
}

export interface MindNode {
  rotulo: string;
  filhos: MindNode[];
}
export interface MindMapSpec {
  raiz: string;
  ramos: MindNode[];
}

export const LIMITS = { nodes: 40, edges: 80, groups: 8, label: 80, mindNodes: 50, mindDepth: 4 } as const;

const clean = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return s === "" ? null : s.slice(0, max);
};
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Rótulo seguro para ficar entre aspas no Mermaid. */
const q = (label: string): string => `"${label.replace(/"/g, "'")}"`;

/**
 * Normaliza o que o modelo mandou: descarta o que não serve (nó sem rótulo, ligação para nó que não
 * existe, duplicatas) em vez de recusar a nota inteira. Devolve undefined se sobrar menos de 2 nós.
 */
export function normalizeDiagram(raw: unknown): DiagramSpec | undefined {
  if (!isRecord(raw)) return undefined;
  const nos: DiagramSpec["nos"] = [];
  const seen = new Set<string>();
  for (const n of Array.isArray(raw.nos) ? raw.nos : []) {
    if (!isRecord(n) || nos.length >= LIMITS.nodes) continue;
    const id = clean(n.id, 40);
    const rotulo = clean(n.rotulo, LIMITS.label);
    if (id === null || rotulo === null || seen.has(id)) continue;
    seen.add(id);
    nos.push({ id, rotulo, forma: n.forma === "banco" || n.forma === "redondo" ? n.forma : "caixa" });
  }
  if (nos.length < 2) return undefined;

  const ligacoes: DiagramSpec["ligacoes"] = [];
  const edgeKeys = new Set<string>();
  for (const l of Array.isArray(raw.ligacoes) ? raw.ligacoes : []) {
    if (!isRecord(l) || ligacoes.length >= LIMITS.edges) continue;
    const de = clean(l.de, 40);
    const para = clean(l.para, 40);
    if (de === null || para === null || !seen.has(de) || !seen.has(para)) continue;
    const rotulo = clean(l.rotulo, LIMITS.label);
    const key = `${de}>${para}>${rotulo ?? ""}`;
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    ligacoes.push({ de, para, ...(rotulo !== null && { rotulo }) });
  }

  const grupos: DiagramSpec["grupos"] = [];
  const grouped = new Set<string>();
  for (const g of Array.isArray(raw.grupos) ? raw.grupos : []) {
    if (!isRecord(g) || grupos.length >= LIMITS.groups) continue;
    const titulo = clean(g.titulo, LIMITS.label);
    const members = (Array.isArray(g.nos) ? g.nos : []).map((x) => clean(x, 40)).filter((x): x is string => x !== null && seen.has(x) && !grouped.has(x));
    if (titulo === null || members.length === 0) continue;
    for (const m of new Set(members)) grouped.add(m);
    grupos.push({ titulo, nos: [...new Set(members)] });
  }
  return { direcao: raw.direcao === "TD" ? "TD" : "LR", nos, ligacoes, grupos };
}

const shaped = (id: string, label: string, forma: Shape): string =>
  forma === "banco" ? `${id}[(${q(label)})]` : forma === "redondo" ? `${id}(${q(label)})` : `${id}[${q(label)}]`;

export function diagramToMermaid(spec: DiagramSpec): string {
  const ids = new Map(spec.nos.map((n, i) => [n.id, `n${i + 1}`]));
  const lines = [`flowchart ${spec.direcao}`];
  const inGroup = new Set(spec.grupos.flatMap((g) => g.nos));
  spec.grupos.forEach((g, i) => {
    lines.push(`  subgraph g${i + 1}[${q(g.titulo)}]`);
    for (const id of g.nos) {
      const n = spec.nos.find((x) => x.id === id)!;
      lines.push(`    ${shaped(ids.get(id)!, n.rotulo, n.forma)}`);
    }
    lines.push("  end");
  });
  for (const n of spec.nos) if (!inGroup.has(n.id)) lines.push(`  ${shaped(ids.get(n.id)!, n.rotulo, n.forma)}`);
  for (const l of spec.ligacoes) {
    lines.push(`  ${ids.get(l.de)!} -->${l.rotulo !== undefined ? `|${q(l.rotulo)}|` : ""} ${ids.get(l.para)!}`);
  }
  return lines.join("\n");
}

/** Árvore de ramos: limita profundidade e quantidade, descarta rótulos vazios. Undefined se não houver ramos. */
export function normalizeMindMap(raw: unknown): MindMapSpec | undefined {
  if (!isRecord(raw)) return undefined;
  const raiz = clean(raw.raiz, LIMITS.label);
  if (raiz === null) return undefined;
  let count = 0;
  const walk = (items: unknown, depth: number): MindNode[] => {
    if (!Array.isArray(items) || depth > LIMITS.mindDepth) return [];
    const out: MindNode[] = [];
    for (const it of items) {
      if (!isRecord(it) || count >= LIMITS.mindNodes) continue;
      const rotulo = clean(it.rotulo, LIMITS.label);
      if (rotulo === null) continue;
      count++;
      out.push({ rotulo, filhos: walk(it.filhos, depth + 1) });
    }
    return out;
  };
  const ramos = walk(raw.ramos, 1);
  return ramos.length === 0 ? undefined : { raiz, ramos };
}

export function mindMapToMermaid(spec: MindMapSpec): string {
  const lines = ["flowchart LR", `  r0((${q(spec.raiz)}))`];
  let n = 0;
  const walk = (nodes: MindNode[], parent: string): void => {
    for (const node of nodes) {
      const id = `m${++n}`;
      lines.push(`  ${id}[${q(node.rotulo)}]`, `  ${parent} --> ${id}`);
      walk(node.filhos, id);
    }
  };
  walk(spec.ramos, "r0");
  return lines.join("\n");
}

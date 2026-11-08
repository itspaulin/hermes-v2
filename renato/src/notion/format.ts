import type { Nota } from "./notas.js";
import { temaPath, type Tema } from "./temas.js";

/** Lista numerada de notas para o Telegram (texto cru): título, tema, resumo e link. */
export function listNotas(temas: readonly Tema[], found: readonly Nota[], max = 10): string {
  const byId = new Map(temas.map((t) => [t.id, t]));
  const shown = found.slice(0, max).map((n, i) => {
    const tema = n.temaId !== undefined ? byId.get(n.temaId) : undefined;
    const lines = [`${i + 1}. ${n.title} (${tema ? temaPath(temas, tema) : "sem tema"})`];
    if (n.summary) lines.push(`   ${n.summary.slice(0, 100)}`);
    if (n.url) lines.push(`   ${n.url}`);
    return lines.join("\n");
  });
  return [`Achei ${found.length > max ? `mais de ${max}` : found.length}:`, ...shown].join("\n");
}

/** O tema e todos os seus subtemas. */
export function descendants(temas: readonly Tema[], root: Tema): Tema[] {
  const ids = new Set([root.id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const t of temas) {
      if (t.parentId !== undefined && ids.has(t.parentId) && !ids.has(t.id)) {
        ids.add(t.id);
        grew = true;
      }
    }
  }
  return temas.filter((t) => ids.has(t.id));
}

/** Árvore de temas em linhas recuadas. */
export function temaTree(temas: readonly Tema[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (t: Tema, depth: number): void => {
    if (seen.has(t.id)) return;
    seen.add(t.id);
    out.push(`${"  ".repeat(depth)}- ${t.name}`);
    for (const c of temas.filter((x) => x.parentId === t.id)) walk(c, depth + 1);
  };
  for (const r of temas.filter((t) => t.parentId === undefined || !temas.some((p) => p.id === t.parentId))) walk(r, 0);
  return out;
}

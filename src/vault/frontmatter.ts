import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
import { VaultInvalidNote } from "./errors.js";

/**
 * Nota = frontmatter YAML entre "---" + corpo Markdown.
 *
 * Regra inegociável (docs/vault-contract.md, princípio 0): o corpo pertence ao usuário.
 * `tail` guarda tudo depois da cerca de fechamento, literalmente, e é reemitido sem
 * nenhuma transformação.
 *
 * O frontmatter também NÃO é reserializado: uma biblioteca YAML normaliza espaços,
 * linhas em branco e estilo de coleções, o que apagaria a formatação do usuário.
 * Alterações são cirúrgicas, em texto: só a linha do campo alterado muda (ou uma
 * linha nova é acrescentada ao fim). O YAML é usado para LER e para VERIFICAR o
 * resultado: depois de cada alteração o texto é relido e, se qualquer outra chave
 * mudou (ou a chave alvo não ficou com o valor pedido), a alteração é recusada.
 *
 * Fora do suportado (a nota é recusada, nunca "consertada"): BOM no início,
 * cerca com espaços, frontmatter vazio, YAML inválido, chaves duplicadas, e campos
 * do Hermes escritos em formatos que não sejam um escalar simples de uma linha.
 */
export interface Note {
  readonly path: string;
  /** Texto do frontmatter entre as cercas, sem a quebra final. */
  yaml: string;
  /** Frontmatter como objeto simples (leitura). */
  data: Record<string, unknown>;
  eol: "\n" | "\r\n";
  /** Tudo após a cerca de fechamento (inclui a quebra de linha e o corpo). Intocado. */
  readonly tail: string;
}

const FENCE_RE = /^---(\r?\n)([\s\S]*?)\r?\n---(?=\r?\n|$)/;

function parseYaml(yaml: string, path: string): Record<string, unknown> {
  const doc = YAML.parseDocument(yaml, { uniqueKeys: true });
  if (doc.errors.length > 0) {
    throw new VaultInvalidNote(path, `YAML inválido: ${doc.errors[0]!.message.split("\n")[0]}`);
  }
  if (!YAML.isMap(doc.contents)) {
    throw new VaultInvalidNote(path, "frontmatter não é um mapa de chaves");
  }
  return doc.toJS() as Record<string, unknown>;
}

export function parseNote(content: string, path: string): Note {
  const m = FENCE_RE.exec(content);
  if (!m) throw new VaultInvalidNote(path, "frontmatter ausente ou malformado");
  return {
    path,
    yaml: m[2]!,
    data: parseYaml(m[2]!, path),
    eol: m[1] === "\r\n" ? "\r\n" : "\n",
    tail: content.slice(m[0].length),
  };
}

export function serializeNote(note: Note): string {
  return `---${note.eol}${note.yaml}${note.eol}---${note.tail}`;
}

/** Escalar YAML de uma linha, respeitando o estilo de aspas do valor anterior. */
function encodeScalar(value: string, style: "plain" | "double" | "single"): string {
  if (/[\n\r]/.test(value)) throw new Error("valor multilinha não suportado");
  if (style === "double") return JSON.stringify(value);
  if (style === "single") return `'${value.replace(/'/g, "''")}'`;
  return YAML.stringify(value, { lineWidth: 0 }).trimEnd();
}

/** Separa o resto de uma linha `chave:` em valor bruto, comentário e estilo. Null se não for escalar simples. */
function splitValue(rest: string): { style: "plain" | "double" | "single"; comment: string } | null {
  const v = rest.trimStart();
  if (v === "") return null; // valor em linhas seguintes
  const q = v[0];
  if (q === '"' || q === "'") {
    let i = 1;
    for (; i < v.length; i++) {
      if (q === '"' && v[i] === "\\") i++;
      else if (v[i] === q) {
        if (q === "'" && v[i + 1] === "'") i++;
        else break;
      }
    }
    if (i >= v.length) return null; // aspas não fecham na linha
    const after = v.slice(i + 1);
    if (after.trim() !== "" && !/^[ \t]+#/.test(after)) return null;
    return { style: q === '"' ? "double" : "single", comment: after.trim() === "" ? "" : after };
  }
  if ("|>[{&*!%@`".includes(q!)) return null; // bloco, coleção, âncora, tag...
  const hash = v.search(/[ \t]+#/);
  return { style: "plain", comment: hash === -1 ? "" : v.slice(hash) };
}

/**
 * Define um campo escalar de texto. Chave existente: troca só o valor, mantendo a
 * posição, o estilo de aspas e o comentário da linha. Chave ausente: acrescenta ao fim.
 * Recusa (VaultInvalidNote) se não conseguir alterar sem risco.
 */
export function setScalar(note: Note, key: string, value: string): void {
  const refuse = (reason: string): never => {
    throw new VaultInvalidNote(note.path, `não foi possível alterar "${key}": ${reason}`);
  };
  if (!/^[a-z_][a-z0-9_]*$/.test(key)) refuse("nome de chave não suportado");

  const lines = note.yaml.split(note.eol);
  let next: string;

  if (Object.prototype.hasOwnProperty.call(note.data, key)) {
    const idx = lines.findIndex((l) => l.startsWith(`${key}:`));
    if (idx === -1) return refuse("chave não está no formato `chave: valor` na coluna 0");
    const parts = splitValue(lines[idx]!.slice(key.length + 1));
    if (!parts) return refuse("valor não é um escalar simples de uma linha");
    let encoded: string;
    try {
      encoded = encodeScalar(value, parts.style);
    } catch (e) {
      return refuse((e as Error).message);
    }
    lines[idx] = `${key}: ${encoded}${parts.comment}`;
    next = lines.join(note.eol);
  } else {
    let encoded: string;
    try {
      encoded = encodeScalar(value, "plain");
    } catch (e) {
      return refuse((e as Error).message);
    }
    next = `${note.yaml}${note.eol}${key}: ${encoded}`;
  }

  // Verificação: só a chave alvo pode ter mudado, e com o valor pedido.
  let after: Record<string, unknown>;
  try {
    after = parseYaml(next, note.path);
  } catch {
    return refuse("o resultado não é YAML válido");
  }
  const expected = { ...note.data, [key]: value };
  if (!isDeepStrictEqual(after, expected)) refuse("a alteração afetaria outros campos");

  note.yaml = next;
  note.data = after;
}

/** Monta uma nota nova (LF). Valores de string são citados pelo YAML quando necessário. */
export function renderNote(fields: Record<string, string | number>, body: string): string {
  const doc = new YAML.Document(fields);
  return `---\n${doc.toString({ lineWidth: 0 })}---\n${body}`;
}

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseMeta } from "../src/domain/meta.js";
import { parseTask } from "../src/domain/task.js";
import { notionFromEnv } from "./notion-env.js";

/**
 * Copia as tarefas e metas do Vault (pasta local, já atualizada com `git pull`) para o Notion.
 * Só lê o Vault; no Notion só cria (se o ID já existe, não mexe). Seguro rodar mais de uma vez.
 * Sem --apply é ensaio: mostra o que faria e não escreve nada.
 *
 *   NOTION_TASKS_DB=... NOTION_METAS_DB=... npm run migrate:notion -- [--apply] [--exclude=<id>]... [pasta-do-vault]
 *
 * `--exclude=<id>` (repetível) deixa de fora uma tarefa ou meta pelo ID exato (ex.: tarefas de teste).
 */
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const vault = args.find((a) => !a.startsWith("--")) ?? join(homedir(), "obsidian-vault");
const excluded = new Set(args.filter((a) => a.startsWith("--exclude=")).map((a) => a.slice("--exclude=".length)));

function readDir<T>(dir: string, parse: (content: string, path: string) => T): { items: T[]; invalid: string[] } {
  const items: T[] = [];
  const invalid: string[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".md")).sort();
  } catch {
    /* pasta inexistente: nada a migrar */
  }
  for (const name of names) {
    const path = `Hermes/${dir.split("/Hermes/")[1]}/${name}`;
    try {
      items.push(parse(readFileSync(join(dir, name), "utf8"), path));
    } catch (err) {
      invalid.push(`${name}: ${err instanceof Error ? err.message : "erro"}`);
    }
  }
  return { items, invalid };
}

const metas = readDir(join(vault, "Hermes", "metas"), parseMeta);
const tasks = readDir(join(vault, "Hermes", "tarefas"), parseTask);
metas.items = metas.items.filter((m) => !excluded.has(m.id));
tasks.items = tasks.items.filter((t) => !excluded.has(t.id));
if (excluded.size > 0) console.log(`Excluídos por --exclude: ${[...excluded].join(", ")}`);
console.log(`Vault: ${vault}\nMetas: ${metas.items.length} (${metas.invalid.length} inválidas) | Tarefas: ${tasks.items.length} (${tasks.invalid.length} inválidas)`);
for (const line of [...metas.invalid, ...tasks.invalid]) console.log(`  ignorada: ${line}`);

if (!apply) {
  for (const m of metas.items) console.log(`  [ensaio] meta   ${m.id} (${m.status})`);
  for (const t of tasks.items) console.log(`  [ensaio] tarefa ${t.id} (${t.status}${t.due ? `, prazo ${t.due}` : ""})`);
  console.log("\nEnsaio: nada foi escrito. Rode de novo com --apply para migrar.");
} else {
  const notion = await notionFromEnv();
  const count = { created: 0, exists: 0 };
  for (const m of metas.items) count[await notion.metas.importMeta(m)]++;
  console.log(`Metas: ${count.created} criadas, ${count.exists} já existiam.`);
  count.created = count.exists = 0;
  for (const t of tasks.items) count[await notion.tasks.importTask(t)]++;
  console.log(`Tarefas: ${count.created} criadas, ${count.exists} já existiam.`);
}

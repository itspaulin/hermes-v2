import { describe, expect, it } from "vitest";
import { makeRepos } from "./support/repos.js";
import { routeMessage } from "../src/telegram/router.js";
import { parseTarefaArgs } from "../src/telegram/task-commands.js";
import { fakeClock } from "../src/time/index.js";
import { InMemoryVaultStore } from "../src/vault/memory-store.js";
import { guardVaultStore } from "../src/vault/store.js";

const EVENT = Date.parse("2026-09-25T18:00:00Z") / 1000; // 25/09 15:00 em SP

function setup() {
  const clock = fakeClock("2026-09-25T18:10:00Z");
  const mem = new InMemoryVaultStore();
  const store = guardVaultStore(mem);
  const deps = { clock, ...makeRepos(store, clock) };
  const say = (text: string) => routeMessage(text, EVENT, deps);
  return { mem, say, ...deps };
}

describe("/meta", () => {
  it("cria com prazo e grava a nota no formato do contrato", async () => {
    const { say, mem } = setup();
    expect(await say("/meta Melhorar LinkedIn até 2026-12-31")).toBe(
      "Meta criada: Melhorar LinkedIn\nID: melhorar-linkedin\nPrazo: 2026-12-31",
    );
    const note = (await mem.read("Hermes/metas/melhorar-linkedin.md"))!.content;
    expect(note).toBe(
      [
        "---",
        "schema: 1",
        "id: melhorar-linkedin",
        "type: meta",
        "title: Melhorar LinkedIn",
        "status: ativa",
        "created: 2026-09-25T15:00:00-03:00",
        "updated: 2026-09-25T15:00:00-03:00",
        "due: 2026-12-31",
        "---",
        "",
        "# Melhorar LinkedIn",
        "",
      ].join("\n"),
    );
  });

  it("é idempotente e não altera o prazo de uma meta existente", async () => {
    const { say } = setup();
    await say("/meta Melhorar LinkedIn");
    expect(await say("/meta Melhorar LinkedIn até 2026-12-31")).toBe(
      "Meta já existe: Melhorar LinkedIn\nID: melhorar-linkedin\nObs.: o prazo pedido não foi alterado.",
    );
  });

  it("erros de uso", async () => {
    const { say } = setup();
    expect(await say("/meta")).toBe("Uso: /meta <título> [até AAAA-MM-DD]");
    expect(await say("/meta x até amanhã")).toContain("Datas relativas ainda não são suportadas");
    expect(await say("/meta x até 2026-02-30")).toContain("Data inexistente");
    await expect(say("/meta !!!")).rejects.toThrow("Título sem letras ou números aproveitáveis"); // o webhook responde ao usuário
  });
});

describe("/tarefa ... #meta", () => {
  it("parse: #meta só como última palavra, com ou sem prazo", () => {
    expect(parseTarefaArgs("Estudar #melhorar-linkedin")).toEqual({ title: "Estudar", meta: "melhorar-linkedin" });
    expect(parseTarefaArgs("Estudar até 2026-10-02 #Melhorar-LinkedIn")).toEqual({
      title: "Estudar",
      due: "2026-10-02",
      meta: "melhorar-linkedin",
    });
    expect(parseTarefaArgs("aprender C# hoje")).toEqual({ title: "aprender C# hoje" });
    expect(parseTarefaArgs("Estudar #melhorar linkedin")).toEqual({ title: "Estudar #melhorar linkedin" });
    expect(parseTarefaArgs("#x")).toEqual({ error: "Uso: /tarefa <título> [até AAAA-MM-DD] [#meta]" });
    expect(parseTarefaArgs("Estudar #Não_Slug")).toEqual({ error: "ID de meta inválido: #Não_Slug. Veja os IDs em /metas." });
  });

  it("vincula à meta existente: frontmatter, wikilink no corpo e resposta", async () => {
    const { say, mem } = setup();
    await say("/meta Melhorar LinkedIn");
    expect(await say("/tarefa Escrever post até 2026-10-02 #melhorar-linkedin")).toBe(
      "Tarefa criada: Escrever post\nID: 2026-09-25-escrever-post\nPrazo: 2026-10-02\nMeta: melhorar-linkedin",
    );
    const note = (await mem.read("Hermes/tarefas/2026-09-25-escrever-post.md"))!.content;
    expect(note).toContain("meta: melhorar-linkedin");
    expect(note).toContain("# Escrever post\n\nMeta: [[melhorar-linkedin]]\n");
  });

  it("meta inexistente: recusa e não cria a tarefa", async () => {
    const { say, mem } = setup();
    expect(await say("/tarefa Escrever post #nao-existe")).toBe("Meta não encontrada: nao-existe. Veja os IDs em /metas.");
    expect(await mem.list("Hermes/tarefas")).toEqual([]);
  });

  it("reenvio com outra meta avisa que não alterou", async () => {
    const { say } = setup();
    await say("/meta A");
    await say("/meta B");
    await say("/tarefa Escrever post #a");
    expect(await say("/tarefa Escrever post #b")).toContain("Obs.: a meta pedida não foi alterada.");
  });
});

describe("/metas", () => {
  it("lista ativas com a contagem de tarefas pendentes; pausadas em resumo", async () => {
    const { say, mem, tasks } = setup();
    expect(await say("/metas")).toBe("Nenhuma meta ativa. Crie com /meta <título>.");
    await say("/meta Melhorar LinkedIn até 2026-12-31");
    await say("/meta Ler mais");
    await say("/meta Aprender Rust");
    await say("/tarefa Post 1 #melhorar-linkedin");
    await say("/tarefa Post 2 #melhorar-linkedin");
    await say("/tarefa Post 3 #melhorar-linkedin");
    await tasks.complete("2026-09-25-post-3");
    const rust = (await mem.read("Hermes/metas/aprender-rust.md"))!;
    await mem.update("Hermes/metas/aprender-rust.md", rust.sha, rust.content.replace("status: ativa", "status: pausada"));

    expect(await say("/metas")).toBe(
      [
        "Metas ativas (2):",
        "- Melhorar LinkedIn até 31/12: 2 tarefas pendentes",
        "  #melhorar-linkedin",
        "- Ler mais: 0 tarefas pendentes",
        "  #ler-mais",
        "",
        "1 meta pausada: Aprender Rust.",
      ].join("\n"),
    );
  });

  it("nota inválida não derruba a listagem", async () => {
    const { say, mem } = setup();
    await say("/meta Boa");
    mem.externalWrite("Hermes/metas/quebrada.md", "sem frontmatter");
    const out = await say("/metas");
    expect(out).toContain("- Boa");
    expect(out).toContain("Obs.: 1 nota ignorada por estar inválida.");
  });
});

describe("/metafeita e /metacancelar", () => {
  it("conclui por trecho, sem tocar o corpo, e repetir é no-op", async () => {
    const { say, mem } = setup();
    await say("/meta Melhorar LinkedIn");
    const file = (await mem.read("Hermes/metas/melhorar-linkedin.md"))!;
    await mem.update("Hermes/metas/melhorar-linkedin.md", file.sha, file.content + "\nMinhas notas.\n");

    expect(await say("/metafeita linkedin")).toBe("Meta concluída: Melhorar LinkedIn");
    const after = (await mem.read("Hermes/metas/melhorar-linkedin.md"))!.content;
    expect(after).toContain("status: concluida");
    expect(after).toContain("updated: 2026-09-25T15:10:00-03:00");
    expect(after.endsWith("\nMinhas notas.\n")).toBe(true);
    const commits = mem.commits.length;

    expect(await say("/metafeita #melhorar-linkedin")).toBe("Meta já estava concluída: Melhorar LinkedIn");
    expect(mem.commits.length).toBe(commits);
  });

  it("cancela, e trata uso, não encontrada e ambígua", async () => {
    const { say } = setup();
    await say("/meta Ler livro A");
    await say("/meta Ler livro B");
    expect(await say("/metacancelar")).toBe("Uso: /metacancelar <id-ou-trecho>");
    expect(await say("/metacancelar zzz")).toBe("Meta não encontrada.");
    expect(await say("/metacancelar ler")).toBe(
      "Mais de uma meta corresponde. Seja mais específico:\n- ler-livro-a (Ler livro A)\n- ler-livro-b (Ler livro B)",
    );
    expect(await say("/metacancelar ler-livro-a")).toBe("Meta cancelada: Ler livro A");
  });
});

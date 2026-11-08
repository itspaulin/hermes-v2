import { describe, expect, it } from "vitest";
import { makeRepos } from "./support/repos.js";
import { VaultTaskRepository } from "../src/domain/task-repository.js";
import { cmdHoje, cmdSemana } from "../src/telegram/list-commands.js";
import { routeMessage } from "../src/telegram/router.js";
import { fakeClock, parseLocalDate } from "../src/time/index.js";
import { InMemoryVaultStore } from "../src/vault/memory-store.js";
import { guardVaultStore } from "../src/vault/store.js";

const epoch = (iso: string) => Date.parse(iso) / 1000;
// 2026-09-25 é sexta. Semana: 21/09 (seg) a 27/09 (dom).
const NOW = "2026-09-25T18:10:00Z";

async function setup(tasks: { title: string; due?: string }[] = []) {
  const clock = fakeClock(NOW);
  const mem = new InMemoryVaultStore();
  const repo = new VaultTaskRepository(guardVaultStore(mem), clock);
  for (const t of tasks) {
    await repo.create({
      title: t.title,
      eventEpochSeconds: epoch("2026-09-20T15:00:00Z"),
      ...(t.due !== undefined && { due: parseLocalDate(t.due) }),
    });
  }
  const repos = makeRepos(guardVaultStore(mem), clock);
  return { clock, mem, repo, repos };
}

const TASKS = [
  { title: "Atrasada velha", due: "2026-09-10" },
  { title: "Atrasada da semana", due: "2026-09-23" },
  { title: "Fazer hoje", due: "2026-09-25" },
  { title: "Fazer sabado", due: "2026-09-26" },
  { title: "Fazer no mes que vem", due: "2026-10-15" },
  { title: "Ideia solta" },
];

describe("/hoje", () => {
  it("separa atrasadas, hoje e sem prazo, e conta as futuras", async () => {
    const { repo, clock, repos } = await setup(TASKS);
    expect(await cmdHoje(repo, repos.metas, clock)).toBe(
      [
        "Hoje, sexta 25/09",
        "",
        "Atrasadas (2):",
        "- Atrasada velha (10/09)",
        "- Atrasada da semana (23/09)",
        "",
        "Para hoje (1):",
        "- Fazer hoje",
        "",
        "Sem prazo (1):",
        "- Ideia solta",
        "",
        "2 tarefas com prazo futuro. Veja em /semana.",
      ].join("\n"),
    );
  });

  it("sem tarefas", async () => {
    const { repo, clock, repos } = await setup();
    expect(await cmdHoje(repo, repos.metas, clock)).toBe("Hoje, sexta 25/09\n\nNada atrasado nem para hoje.");
  });

  it("ignora feitas e canceladas", async () => {
    const { repo, clock, repos } = await setup([{ title: "A", due: "2026-09-25" }, { title: "B", due: "2026-09-25" }]);
    const { tasks } = await repo.listPending();
    await repo.complete(tasks[0]!.id);
    await repo.cancel(tasks[1]!.id);
    expect(await cmdHoje(repo, repos.metas, clock)).toBe("Hoje, sexta 25/09\n\nNada atrasado nem para hoje.");
  });

  it("usa a data de São Paulo, não a de UTC (23h em SP já é dia seguinte em UTC)", async () => {
    const { repo, repos } = await setup([{ title: "Do dia", due: "2026-09-25" }]);
    const late = fakeClock("2026-09-26T01:30:00Z"); // 25/09 22:30 em SP
    expect(await cmdHoje(repo, repos.metas, late)).toContain("Para hoje (1):\n- Do dia");
  });

  it("avisa sobre notas inválidas sem falhar", async () => {
    const { repo, clock, mem, repos } = await setup([{ title: "Boa", due: "2026-09-25" }]);
    mem.externalWrite("Hermes/tarefas/2026-09-20-quebrada.md", "sem frontmatter");
    const out = await cmdHoje(repo, repos.metas, clock);
    expect(out).toContain("- Boa");
    expect(out).toContain("Obs.: 1 nota ignorada por estar inválida.");
  });
});

describe("/semana", () => {
  it("agrupa por dia, marca hoje, e separa atrasadas, sem prazo e depois da semana", async () => {
    const { repo, clock, repos } = await setup([...TASKS, { title: "Outra hoje", due: "2026-09-25" }]);
    expect(await cmdSemana(repo, repos.metas, clock)).toBe(
      [
        "Semana 21/09 a 27/09",
        "",
        "Atrasadas (1):",
        "- Atrasada velha (10/09)",
        "",
        "quarta 23/09:",
        "- Atrasada da semana",
        "",
        "sexta 25/09 (hoje):",
        "- Fazer hoje",
        "- Outra hoje",
        "",
        "sábado 26/09:",
        "- Fazer sabado",
        "",
        "Sem prazo (1):",
        "- Ideia solta",
        "",
        "1 tarefa depois desta semana.",
      ].join("\n"),
    );
  });

  it("sem tarefas", async () => {
    const { repo, clock, repos } = await setup();
    expect(await cmdSemana(repo, repos.metas, clock)).toBe("Semana 21/09 a 27/09\n\nNada pendente nesta semana.");
  });

  it("domingo pertence à semana que termina nele", async () => {
    const { repo, repos } = await setup([{ title: "Descanso", due: "2026-09-27" }]);
    const sunday = fakeClock("2026-09-27T15:00:00Z");
    expect(await cmdSemana(repo, repos.metas, sunday)).toContain("domingo 27/09 (hoje):\n- Descanso");
  });
});

describe("roteamento", () => {
  it("/hoje e /semana (com @bot) chegam nos comandos", async () => {
    const { repo, clock, repos } = await setup();
    expect(await routeMessage("/hoje", undefined, { clock, ...repos })).toMatch(/^Hoje, sexta 25\/09/);
    expect(await routeMessage("/semana@Hermesuntakedbot", undefined, { clock, ...repos })).toMatch(/^Semana 21\/09/);
  });
});

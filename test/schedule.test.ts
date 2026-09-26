import { describe, expect, it } from "vitest";
import { SCHEDULES } from "../src/config.js";
import { dayContext, weekStats } from "../src/domain/stats.js";
import { parseTask } from "../src/domain/task.js";
import { parseScheduledEvent, runScheduled, type ScheduledEvent } from "../src/schedule/run.js";
import { routeMessage } from "../src/telegram/router.js";
import { currentWeek, fakeClock, parseLocalDate } from "../src/time/index.js";
import { InMemoryVaultStore } from "../src/vault/memory-store.js";
import { guardVaultStore } from "../src/vault/store.js";
import { makeRepos } from "./support/repos.js";

const epoch = (iso: string) => Date.parse(iso) / 1000;
const D = parseLocalDate;
// Semana de teste: seg 21/09/2026 a dom 27/09/2026. 14h em SP = 17:00Z, 18h = 21:00Z.

function setup(startIso = "2026-09-21T17:00:00Z") {
  const clock = fakeClock(startIso);
  const mem = new InMemoryVaultStore();
  const repos = makeRepos(guardVaultStore(mem), clock);
  const sent: { chat: number; text: string }[] = [];
  let telegramDown = false;
  const deps = {
    clock,
    ...repos,
    chatIds: [111],
    client: {
      sendMessage: async (chat: number, text: string) => {
        if (telegramDown) throw new Error("telegram fora");
        sent.push({ chat, text });
      },
    },
  };
  const run = (kind: ScheduledEvent["kind"], force = false) => runScheduled({ kind, ...(force && { force }) }, deps);
  const say = (text: string) => routeMessage(text, epoch("2026-09-21T17:05:00Z"), { clock, ...repos });
  const task = (title: string, createdIso: string, due?: string, meta?: string) =>
    repos.tasks.create({ title, eventEpochSeconds: epoch(createdIso), ...(due && { due: D(due) }), ...(meta && { meta }) });
  return { clock, mem, repos, sent, run, say, task, setTelegramDown: (v: boolean) => (telegramDown = v) };
}

describe("parseScheduledEvent", () => {
  it("reconhece só {kind} válido; evento do API Gateway não", () => {
    expect(parseScheduledEvent({ kind: "checkin" })).toEqual({ kind: "checkin" });
    expect(parseScheduledEvent({ kind: "weekly_review", force: true })).toEqual({ kind: "weekly_review", force: true });
    expect(parseScheduledEvent({ kind: "outro" })).toBeNull();
    expect(parseScheduledEvent({ routeKey: "POST /telegram/webhook", body: "{}" })).toBeNull();
    expect(parseScheduledEvent(null)).toBeNull();
    expect(parseScheduledEvent("checkin")).toBeNull();
  });
});

describe("check-in diário (seg 14h)", () => {
  it("cria a nota do dia com o contexto e manda a pergunta", async () => {
    const t = setup();
    await t.task("Atrasada", "2026-09-14T15:00:00Z", "2026-09-18");
    await t.task("Para hoje", "2026-09-20T15:00:00Z", "2026-09-21");
    await t.task("Semana que vem", "2026-09-20T15:00:00Z", "2026-09-25");
    await t.task("Longe", "2026-09-20T15:00:00Z", "2026-11-01");

    expect(await t.run("checkin")).toBe("check-in 2026-09-21-checkin enviado");

    const note = (await t.mem.read("Hermes/checkins/2026/2026-09-21-checkin.md"))!.content;
    expect(note).toBe(
      [
        "---",
        "schema: 1",
        "id: 2026-09-21-checkin",
        "type: checkin",
        "kind: checkin",
        "date: 2026-09-21",
        "created: 2026-09-21T14:00:00-03:00",
        "updated: 2026-09-21T14:00:00-03:00",
        "---",
        "",
        "# Check-in 21/09",
        "",
        "## Contexto",
        "",
        "- Pendentes para hoje: 1",
        "- Atrasadas: 1",
        "- Próximas (7 dias): 1",
        "",
        "Resposta: campo `answer` acima (Telegram: /checkin).",
        "",
      ].join("\n"),
    );
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.chat).toBe(111);
    expect(t.sent[0]!.text).toBe(
      [
        "Check-in de hoje (seg 21/09)",
        "",
        "Pendentes para hoje: 1",
        "Atrasadas: 1",
        "Próximas (7 dias): 1",
        "",
        "Como está indo hoje? O que você já fez e o que pretende fazer até o fim do dia?",
        "Responda com /checkin <texto>.",
      ].join("\n"),
    );
  });

  it("falha do Telegram propaga; a nova tentativa reaproveita a nota e reenvia", async () => {
    const t = setup();
    t.setTelegramDown(true);
    await expect(t.run("checkin")).rejects.toThrow("telegram fora");
    expect(t.mem.commits.map((c) => c.op)).toEqual(["create"]);

    t.setTelegramDown(false);
    expect(await t.run("checkin")).toBe("check-in 2026-09-21-checkin enviado");
    expect(t.mem.commits).toHaveLength(1); // sem segunda criação
    expect(t.sent).toHaveLength(1);
  });

  it("já respondido: não reenvia", async () => {
    const t = setup();
    await t.run("checkin");
    await t.say("/checkin foi bem");
    t.sent.length = 0;
    expect(await t.run("checkin")).toBe("check-in 2026-09-21-checkin já respondido");
    expect(t.sent).toEqual([]);
  });
});

describe("calendário", () => {
  it("só roda no dia agendado em SCHEDULES; domingo nunca (sem force)", async () => {
    const sunday = setup("2026-09-27T17:00:00Z");
    for (const kind of ["checkin", "metrics", "weekly_review"] as const) {
      expect(await sunday.run(kind)).toMatch(/^ignorado: /);
    }
    expect(sunday.sent).toEqual([]);
    expect(sunday.mem.commits).toEqual([]);

    const monday = setup(); // segunda: só check-in
    expect(await monday.run("metrics")).toMatch(/^ignorado: /);
    expect(await monday.run("weekly_review")).toMatch(/^ignorado: /);
    expect(monday.mem.commits).toEqual([]);
  });

  it("force ignora o calendário (teste manual)", async () => {
    const sunday = setup("2026-09-27T17:00:00Z");
    expect(await sunday.run("checkin", true)).toBe("check-in 2026-09-27-checkin enviado");
  });

  it("horários e dias vêm de SCHEDULES: seg/ter/qua/sex check-in, qui métricas, sáb revisão, dom nada", () => {
    expect(SCHEDULES.map((s) => `${s.weekday}${s.kind}${s.time}`)).toEqual([
      "1checkin14:00", "2checkin14:00", "3checkin14:00", "4metrics14:00", "5checkin14:00", "6weekly_review18:00",
    ]);
  });
});

describe("/checkin", () => {
  it("responde ao mais recente sem resposta, acrescenta e é idempotente", async () => {
    const t = setup();
    expect(await t.say("/checkin")).toBe("Uso: /checkin <texto>");
    expect(await t.say("/checkin oi")).toBe("Nenhum check-in aguardando resposta.");

    await t.run("checkin");
    expect(await t.say("/checkin Fiz o relatório,\nfalta o deploy")).toBe("Check-in de 21/09 registrado.");
    let note = (await t.mem.read("Hermes/checkins/2026/2026-09-21-checkin.md"))!.content;
    expect(note).toContain("answer: Fiz o relatório, falta o deploy\n");
    expect(note).toContain("answered_at: 2026-09-21T14:00:00-03:00");
    expect(note).toContain("# Check-in 21/09"); // corpo intacto

    const commits = t.mem.commits.length;
    expect(await t.say("/checkin Fiz o relatório, falta o deploy")).toBe("Check-in de 21/09 já estava registrado.");
    expect(t.mem.commits.length).toBe(commits);

    // já respondido: nada aguardando
    expect(await t.say("/checkin mais uma coisa")).toBe("Nenhum check-in aguardando resposta.");
  });

  it("dois dias sem responder: responde ao mais recente; janela de 7 dias", async () => {
    const t = setup();
    await t.run("checkin"); // seg 21
    t.clock.set("2026-09-22T17:00:00Z");
    await t.run("checkin"); // ter 22
    expect(await t.say("/checkin ontem foi corrido")).toBe("Check-in de 22/09 registrado.");
    expect(await t.say("/checkin e o de segunda")).toBe("Check-in de 21/09 registrado.");

    const old = setup();
    await old.run("checkin"); // seg 21
    old.clock.set("2026-09-29T17:00:00Z"); // 8 dias depois
    expect(await old.say("/checkin tarde demais")).toBe("Nenhum check-in aguardando resposta.");
  });

  it("resposta vazia ou longa demais é recusada", async () => {
    const t = setup();
    await t.run("checkin");
    await expect(t.say("/checkin " + "x".repeat(1001))).rejects.toThrow("Resposta longa demais");
  });
});

// Semana de teste: A pendente atrasada, B feita na terça, C cancelada na quarta,
// D (criada na semana anterior, da meta) feita na quinta, E pendente sem prazo.
async function populate(t: ReturnType<typeof setup>) {
  await t.say("/meta Melhorar LinkedIn");
  await t.task("A atrasada", "2026-09-21T15:00:00Z", "2026-09-22");
  await t.task("B", "2026-09-21T15:00:00Z");
  await t.task("C", "2026-09-22T15:00:00Z");
  await t.task("D post", "2026-09-14T15:00:00Z", "2026-09-30", "melhorar-linkedin");
  await t.task("E solta", "2026-09-25T15:00:00Z");
  t.clock.set("2026-09-22T15:00:00Z");
  await t.repos.tasks.complete("2026-09-21-b");
  t.clock.set("2026-09-23T15:00:00Z");
  await t.repos.tasks.cancel("2026-09-22-c");
  t.clock.set("2026-09-24T15:00:00Z");
  await t.repos.tasks.complete("2026-09-14-d-post");
}

describe("estatísticas", () => {
  it("weekStats conta criadas, concluídas, canceladas, pendentes, atrasadas e por dia/meta", async () => {
    const t = setup();
    await populate(t);
    const { tasks } = await t.repos.tasks.listAll();
    const { metas } = await t.repos.metas.list();
    const stats = weekStats(tasks, metas, currentWeek(fakeClock("2026-09-26T21:00:00Z")), D("2026-09-26"));
    expect(stats).toEqual({
      created: 4,
      done: 2,
      cancelled: 1,
      pending: 2,
      overdue: 1,
      doneByDay: [0, 1, 0, 1, 0, 0, 0],
      byMeta: [{ id: "melhorar-linkedin", title: "Melhorar LinkedIn", done: 1, pending: 0 }],
    });
  });

  it("dayContext: hoje, atrasadas e próximas (7 dias, hoje excluído)", () => {
    const mk = (due?: string) => parseTask(`---\nschema: 1\nid: 2026-09-01-x\ntype: tarefa\ntitle: x\nstatus: pendente\ncreated: 2026-09-01T10:00:00-03:00\n${due ? `due: ${due}\n` : ""}---\n`, "Hermes/tarefas/2026-09-01-x.md");
    const tasks = [mk("2026-09-20"), mk("2026-09-21"), mk("2026-09-22"), mk("2026-09-28"), mk("2026-09-29"), mk()];
    expect(dayContext(tasks, D("2026-09-21"))).toEqual({ overdue: 1, dueToday: 1, upcoming: 2 });
  });
});

describe("métricas (qui 14h) e /metrica", () => {
  it("calcula, grava, envia e aceita as métricas manuais", async () => {
    const t = setup();
    await populate(t);
    t.clock.set("2026-09-24T17:00:00Z"); // quinta 14h
    expect(await t.run("metrics")).toBe("métricas 2026-09-24-metrics enviadas");

    const text = t.sent[0]!.text;
    expect(text).toContain("Métricas da semana (21/09 a 27/09)");
    expect(text).toContain("• Criadas: 4");
    expect(text).toContain("• Concluídas: 2");
    expect(text).toContain("• Canceladas: 1");
    expect(text).toContain("• Pendentes: 2");
    expect(text).toContain("• Atrasadas: 1");
    expect(text).toContain("Concluídas por dia: seg 0, ter 1, qua 0, qui 1, sex 0, sáb 0, dom 0");
    expect(text).toContain("• Melhorar LinkedIn: 1 concluídas na semana, 0 pendentes");
    expect(text).toContain("/metrica 6h estudo, 7 candidaturas");

    expect(await t.say("/metrica 6h estudo, 7 candidaturas, 12 comentários")).toBe("Métricas de 24/09 registrado.");
    const note = (await t.mem.read("Hermes/checkins/2026/2026-09-24-metrics.md"))!.content;
    expect(note).toContain("kind: metrics");
    expect(note).toContain("answer: 6h estudo, 7 candidaturas, 12 comentários");
    // /checkin não confunde com métricas
    expect(await t.say("/checkin x")).toBe("Nenhum check-in aguardando resposta.");
  });
});

describe("revisão semanal (sáb 18h) e /revisao", () => {
  it("resume a semana com check-ins e métricas, e aceita a revisão do usuário", async () => {
    const t = setup();
    await populate(t);
    t.clock.set("2026-09-21T17:00:00Z");
    await t.run("checkin");
    await t.say("/checkin segunda ok");
    t.clock.set("2026-09-22T17:00:00Z");
    await t.run("checkin"); // sem resposta
    t.clock.set("2026-09-24T17:00:00Z");
    await t.run("metrics");
    await t.say("/metrica 6h estudo");
    t.sent.length = 0;

    t.clock.set("2026-09-26T21:00:00Z"); // sábado 18h
    expect(await t.run("weekly_review")).toBe("revisão 2026-W39 enviada");

    const note = (await t.mem.read("Hermes/revisoes/2026-W39.md"))!.content;
    expect(note).toContain("type: revisao\nweek: 2026-W39\nweek_start: 2026-09-21");
    expect(note).toContain("21/09 a 27/09");
    expect(note).toContain("- Concluídas: 2");
    expect(note).toContain("2 registrados, 1 sem resposta.\n- 21/09: segunda ok");
    expect(note).toContain("## Métricas manuais\n\n6h estudo");

    expect(t.sent[0]!.text).toBe(
      [
        "Revisão semanal 2026-W39 (21/09 a 27/09)",
        "",
        "2 concluídas, 1 canceladas, 2 pendentes e 1 atrasadas.",
        "Check-ins: 1 de 2 respondidos.",
        "",
        "A semana foi encerrada. O que você quer registrar sobre ela?",
        "Responda com /revisao <texto>.",
      ].join("\n"),
    );

    expect(await t.say("/revisao")).toBe("Uso: /revisao <texto>");
    expect(await t.say("/revisao Semana produtiva, faltou LinkedIn")).toBe("Revisão 2026-W39 registrada.");
    expect((await t.mem.read("Hermes/revisoes/2026-W39.md"))!.content).toContain("answer: Semana produtiva, faltou LinkedIn");
    expect(await t.say("/revisao outra")).toBe("Nenhuma revisão aguardando resposta.");

    // revisão já respondida não é reenviada
    t.sent.length = 0;
    expect(await t.run("weekly_review")).toBe("revisão 2026-W39 já respondida");
    expect(t.sent).toEqual([]);
  });

  it("/revisao na segunda ainda acha a revisão da semana anterior", async () => {
    const t = setup("2026-09-26T21:00:00Z");
    await t.run("weekly_review");
    t.clock.set("2026-09-28T13:00:00Z"); // segunda, semana W40
    expect(await t.say("/revisao atrasei")).toBe("Revisão 2026-W39 registrada.");
  });

  it("sem revisão nenhuma", async () => {
    const t = setup();
    expect(await t.say("/revisao x")).toBe("Nenhuma revisão aguardando resposta.");
  });
});

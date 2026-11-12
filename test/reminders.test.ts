import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CreateScheduleCommand,
  DeleteScheduleCommand,
  GetScheduleCommand,
  ListSchedulesCommand,
} from "@aws-sdk/client-scheduler";
import { createHermesAi, createHermesConversation, AI_UNAVAILABLE_TEXT } from "../src/ai/hermes.js";
import type { Converse } from "../shared/ai/bedrock.js";
import type { AiConfig } from "../shared/ai/types.js";
import {
  cronOf,
  matchReminders,
  MAX_REMINDERS,
  ReminderApiError,
  ReminderUnavailable,
  reminderDraft,
  reminderId,
  scheduleText,
  type Reminder,
} from "../src/domain/reminder.js";
import { InMemoryReminderStore, reminderConfigFromEnv, SchedulerReminderStore } from "../src/schedule/reminder-store.js";
import { parseScheduledEvent, runScheduled } from "../src/schedule/run.js";
import { routeMessage } from "../src/telegram/router.js";
import { fakeClock, parseLocalDate, parseLocalTime } from "../src/time/index.js";
import { InMemoryVaultStore } from "../src/vault/memory-store.js";
import { guardVaultStore } from "../src/vault/store.js";
import { makeRepos } from "./support/repos.js";

const epoch = (iso: string) => Date.parse(iso) / 1000;
const config: AiConfig = { modelId: "m", region: "us-east-1", apiKeyParam: "/p/key", maxHistoryMessages: 4, maxInputChars: 500, maxOutputTokens: 100, timeoutMs: 1000 };
const json = (o: unknown): Converse => vi.fn(async () => ({ text: JSON.stringify(o) }));
const rem = (over: Partial<Reminder> = {}): Reminder => ({
  id: "linkedin",
  weekdays: [2, 4, 5],
  time: parseLocalTime("10:00"),
  text: "15 min de LinkedIn",
  ...over,
});

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("lembrete: domínio", () => {
  it("normaliza dias (ordena, sem repetir) e horário de 4 dígitos", () => {
    expect(reminderDraft({ weekdays: [5, 2, 4, 2], time: "9:30", text: "  15 min  de LinkedIn " })).toEqual({
      weekdays: [2, 4, 5],
      time: "09:30",
      text: "15 min de LinkedIn",
    });
  });

  it.each([
    { weekdays: [], time: "10:00", text: "x" },
    { weekdays: [0], time: "10:00", text: "x" },
    { weekdays: [8], time: "10:00", text: "x" },
    { weekdays: [1.5], time: "10:00", text: "x" },
    { weekdays: [1], time: "25:00", text: "x" },
    { weekdays: [1], time: "10h", text: "x" },
    { weekdays: [1], time: "10:00", text: "" },
    { weekdays: [1], time: "10:00", text: "/feita tudo" },
    { weekdays: [1], time: "10:00", text: "x".repeat(201) },
    { weekdays: "seg", time: "10:00", text: "x" },
  ])("recusa input inválido: %j", (input) => {
    expect(reminderDraft(input)).toBeNull();
  });

  it("cron no formato do Scheduler, com dias ou * para todo dia", () => {
    expect(cronOf(rem())).toBe("cron(0 10 ? * TUE,THU,FRI *)");
    expect(cronOf(rem({ weekdays: [1], time: parseLocalTime("18:00") }))).toBe("cron(0 18 ? * MON *)");
    expect(cronOf(rem({ weekdays: [1, 2, 3, 4, 5, 6, 7], time: parseLocalTime("07:05") }))).toBe("cron(5 7 ? * * *)");
  });

  it("descrição legível dos dias", () => {
    expect(scheduleText(rem())).toBe("ter, qui e sex às 10:00");
    expect(scheduleText(rem({ weekdays: [1], time: parseLocalTime("18:00") }))).toBe("toda seg às 18:00");
    expect(scheduleText(rem({ weekdays: [7] }))).toBe("todo dom às 10:00");
    expect(scheduleText(rem({ weekdays: [1, 2, 3, 4, 5] }))).toBe("seg a sex às 10:00");
    expect(scheduleText(rem({ weekdays: [1, 2, 3, 4, 5, 6, 7] }))).toBe("todo dia às 10:00");
  });

  it("id pelo texto, sem colidir", () => {
    expect(reminderId("15 min de LinkedIn", [])).toBe("15-min-de-linkedin");
    expect(reminderId("15 min de LinkedIn", ["15-min-de-linkedin"])).toBe("15-min-de-linkedin-2");
    expect(reminderId("!!!", [])).toBe("lembrete");
    expect(reminderId("a".repeat(80), []).length).toBeLessThanOrEqual(40);
  });

  it("acha por trecho do texto (sem acento) ou do id", () => {
    const all = [rem(), rem({ id: "ingles", text: "Revisar inglês" })];
    expect(matchReminders("ingles", all).map((r) => r.id)).toEqual(["ingles"]);
    expect(matchReminders("LinkedIn", all).map((r) => r.id)).toEqual(["linkedin"]);
    expect(matchReminders("xyz", all)).toEqual([]);
  });
});

function setup(converse: Converse = json({ type: "reply", message: "ok" })) {
  const clock = fakeClock("2026-11-10T13:00:00Z"); // terça 10:00 em SP
  const repos = makeRepos(guardVaultStore(new InMemoryVaultStore()), clock);
  const reminders = new InMemoryReminderStore();
  const conv = createHermesConversation(createHermesAi(config, converse), { clock, tasks: repos.tasks, metas: repos.metas, reminders });
  const deps = { clock, ...repos, reminders, converse: conv, chatId: 111 };
  const say = (text: string) => routeMessage(text, epoch("2026-11-10T13:00:00Z"), deps);
  return { clock, repos, reminders, deps, say };
}

describe("lembrete: pela conversa", () => {
  it("create_reminder cria e confirma com o que entendeu", async () => {
    const t = setup(json({ type: "action", action: "create_reminder", input: { weekdays: [2, 4, 5], time: "10:00", text: "15 min de LinkedIn" } }));
    expect(await t.say("terça quinta e sexta às 10h me lembra de 15 min de LinkedIn")).toBe(
      "Lembrete criado: ter, qui e sex às 10:00: 15 min de LinkedIn [15-min-de-linkedin]",
    );
    expect([...t.reminders.items.values()]).toEqual([{ id: "15-min-de-linkedin", weekdays: [2, 4, 5], time: "10:00", text: "15 min de LinkedIn" }]);
  });

  it("pedir o mesmo lembrete de novo não duplica", async () => {
    const t = setup(json({ type: "action", action: "create_reminder", input: { weekdays: [1], time: "18:00", text: "Revisar inglês" } }));
    await t.say("toda segunda 18h revisar inglês");
    expect(await t.say("toda segunda 18h revisar inglês")).toContain("Esse lembrete já existe");
    expect(t.reminders.items.size).toBe(1);
  });

  it("mesmo texto em outro horário vira outro lembrete com id próprio", async () => {
    const t = setup();
    await t.reminders.create(rem({ id: "revisar-ingles", text: "Revisar inglês", weekdays: [1], time: parseLocalTime("18:00") }));
    const conv = createHermesConversation(
      createHermesAi(config, json({ type: "action", action: "create_reminder", input: { weekdays: [2], time: "11:00", text: "Revisar inglês" } })),
      { clock: t.clock, tasks: t.repos.tasks, metas: t.repos.metas, reminders: t.reminders },
    );
    expect(await routeMessage("terça 11h revisar inglês", 0, { ...t.deps, converse: conv })).toContain("[revisar-ingles-2]");
  });

  it("liga à meta ativa pelo nome; meta inexistente não cria nada", async () => {
    const t = setup(json({ type: "action", action: "create_reminder", input: { weekdays: [1], time: "18:00", text: "Inglês", meta: "ingles" } }));
    expect(await t.say("toda segunda 18h inglês, meta inglês")).toContain('Não achei a meta "ingles"');
    expect(t.reminders.items.size).toBe(0);

    await t.repos.metas.create({ title: "Inglês fluente", eventEpochSeconds: epoch("2026-11-01T12:00:00Z") });
    expect(await t.say("toda segunda 18h inglês, meta inglês")).toContain("(meta ingles-fluente)");
    expect([...t.reminders.items.values()][0]!.meta).toBe("ingles-fluente");
  });

  it("limite de lembretes", async () => {
    const t = setup(json({ type: "action", action: "create_reminder", input: { weekdays: [1], time: "08:00", text: "novo" } }));
    for (let i = 0; i < MAX_REMINDERS; i++) await t.reminders.create(rem({ id: `r-${i}`, text: `r ${i}` }));
    expect(await t.say("segunda 8h novo")).toContain("o máximo");
    expect(t.reminders.items.size).toBe(MAX_REMINDERS);
  });

  it("input inválido do modelo não cria nada", async () => {
    const t = setup(json({ type: "action", action: "create_reminder", input: { weekdays: [9], time: "10:00", text: "x" } }));
    expect(await t.say("lembra")).toBe(AI_UNAVAILABLE_TEXT);
    expect(t.reminders.items.size).toBe(0);
  });

  it("list_reminders e delete_reminder pela conversa", async () => {
    const t = setup(json({ type: "action", action: "list_reminders", input: {} }));
    await t.reminders.create(rem());
    expect(await t.say("quais meus lembretes?")).toContain("ter, qui e sex às 10:00: 15 min de LinkedIn [linkedin]");

    const conv = createHermesConversation(createHermesAi(config, json({ type: "action", action: "delete_reminder", input: { ref: "linkedin" } })), {
      clock: t.clock,
      tasks: t.repos.tasks,
      metas: t.repos.metas,
      reminders: t.reminders,
    });
    expect(await routeMessage("apaga o do linkedin", 0, { ...t.deps, converse: conv })).toContain("Lembrete apagado");
    expect(t.reminders.items.size).toBe(0);
  });

  it("sem store configurado, avisa e não quebra", async () => {
    const t = setup();
    const conv = createHermesConversation(
      createHermesAi(config, json({ type: "action", action: "create_reminder", input: { weekdays: [1], time: "18:00", text: "x" } })),
      { clock: t.clock, tasks: t.repos.tasks, metas: t.repos.metas },
    );
    const { reminders: _, ...noReminders } = t.deps;
    expect(await routeMessage("segunda 18h x", 0, { ...noReminders, converse: conv })).toContain("não estão configurados");
    expect(await routeMessage("/lembretes", 0, noReminders)).toContain("não estão configurados");
  });
});

describe("lembrete: comandos", () => {
  it("/lembretes lista; /apagarlembrete pede precisão quando ambíguo", async () => {
    const t = setup();
    expect(await t.say("/lembretes")).toContain("Nenhum lembrete");
    await t.reminders.create(rem());
    await t.reminders.create(rem({ id: "linkedin-post", text: "Post no LinkedIn", weekdays: [1] }));
    expect(await t.say("/lembretes")).toContain("Lembretes (2):");
    expect(await t.say("/apagarlembrete linkedin")).toContain("linkedin");
    expect(t.reminders.items.size).toBe(1);
    expect(await t.say("/apagarlembrete post")).toContain("Lembrete apagado: toda seg às 10:00: Post no LinkedIn");
    expect(await t.say("/apagarlembrete nada")).toContain("Não achei");
  });

  it("id exato vence os parciais", async () => {
    const t = setup();
    await t.reminders.create(rem());
    await t.reminders.create(rem({ id: "linkedin-2", text: "outro" }));
    expect(await t.say("/apagarlembrete linkedin")).toContain("Lembrete apagado");
    expect([...t.reminders.items.keys()]).toEqual(["linkedin-2"]);
  });
});

describe("lembrete: disparo agendado", () => {
  it("parseScheduledEvent aceita o Input do schedule e recusa lembrete malformado", () => {
    const r = rem();
    expect(parseScheduledEvent({ kind: "reminder", ...r })).toEqual({ kind: "reminder", reminder: r });
    expect(parseScheduledEvent({ kind: "reminder", ...r, id: "Inválido!" })).toBeNull();
    expect(parseScheduledEvent({ kind: "reminder", ...r, text: "" })).toBeNull();
    expect(parseScheduledEvent({ kind: "reminder" })).toBeNull();
  });

  async function fire(reminder: Reminder, nowIso: string, seed?: (t: ReturnType<typeof setup>) => Promise<void>) {
    const t = setup();
    const clock = fakeClock(nowIso);
    if (seed) await seed(t);
    const sent: string[] = [];
    const out = await runScheduled(
      { kind: "reminder", reminder },
      { clock, ...t.repos, chatIds: [111], client: { sendMessage: async (_c: number, text: string) => void sent.push(text) } },
    );
    return { out, sent };
  }

  it("manda o texto, inclusive no domingo (o schedule é o calendário)", async () => {
    const { out, sent } = await fire(rem({ weekdays: [7] }), "2026-11-15T13:00:00Z");
    expect(out).toBe("lembrete linkedin enviado");
    expect(sent).toEqual(["⏰ 15 min de LinkedIn"]);
  });

  it("com meta, junta as pendências dela de hoje e atrasadas (não as futuras nem de outra meta)", async () => {
    const { sent } = await fire(rem({ meta: "ingles" }), "2026-11-10T13:00:00Z", async (t) => {
      await t.repos.metas.create({ title: "Ingles", eventEpochSeconds: epoch("2026-11-01T12:00:00Z") });
      await t.repos.metas.create({ title: "Outra", eventEpochSeconds: epoch("2026-11-01T12:00:00Z") });
      const task = (title: string, due: string, meta: string) =>
        t.repos.tasks.create({ title, eventEpochSeconds: epoch("2026-11-02T12:00:00Z"), due: parseLocalDate(due), meta });
      await task("Hoje", "2026-11-10", "ingles");
      await task("Atrasada", "2026-11-08", "ingles");
      await task("Futura", "2026-11-12", "ingles");
      await task("De outra meta", "2026-11-10", "outra");
    });
    expect(sent).toEqual(["⏰ 15 min de LinkedIn\n\nPendências da meta ingles para hoje:\n- Atrasada (atrasada, prazo 08/11)\n- Hoje"]);
  });
});

describe("lembrete: EventBridge Scheduler", () => {
  const cfg = { group: "hermes-v2-reminders", roleArn: "arn:aws:iam::1:role/r", targetArn: "arn:aws:lambda:sa-east-1:1:function:f" };

  function fakeScheduler() {
    const schedules = new Map<string, { Name: string; Target: { Input: string } }>();
    const calls: unknown[] = [];
    const send = vi.fn(async (cmd: unknown) => {
      calls.push(cmd);
      const input = (cmd as { input: Record<string, unknown> }).input;
      if (cmd instanceof CreateScheduleCommand) {
        schedules.set(input.Name as string, { Name: input.Name as string, Target: input.Target as { Input: string } });
        return {};
      }
      if (cmd instanceof ListSchedulesCommand) return { Schedules: [...schedules.values()].map((s) => ({ Name: s.Name })) };
      if (cmd instanceof GetScheduleCommand) return schedules.get(input.Name as string);
      if (cmd instanceof DeleteScheduleCommand) {
        if (!schedules.delete(input.Name as string)) throw Object.assign(new Error("x"), { name: "ResourceNotFoundException" });
        return {};
      }
      throw new Error("comando inesperado");
    });
    return { send, schedules, calls };
  }

  it("cria o schedule no grupo, no fuso oficial, com o lembrete no Input; lista e apaga", async () => {
    const f = fakeScheduler();
    const store = new SchedulerReminderStore({ send: f.send } as never, cfg);
    await store.create(rem({ meta: "ingles" }));

    const create = (f.calls[0] as CreateScheduleCommand).input;
    expect(create).toMatchObject({
      Name: "linkedin",
      GroupName: "hermes-v2-reminders",
      ScheduleExpression: "cron(0 10 ? * TUE,THU,FRI *)",
      ScheduleExpressionTimezone: "America/Sao_Paulo",
      FlexibleTimeWindow: { Mode: "OFF" },
      Target: { Arn: cfg.targetArn, RoleArn: cfg.roleArn, RetryPolicy: { MaximumRetryAttempts: 2, MaximumEventAgeInSeconds: 3600 } },
    });
    // O Input é exatamente o que a Lambda reconhece como lembrete.
    expect(parseScheduledEvent(JSON.parse(create.Target!.Input!))).toEqual({ kind: "reminder", reminder: rem({ meta: "ingles" }) });

    expect(await store.list()).toEqual([rem({ meta: "ingles" })]);
    expect(await store.delete("linkedin")).toBe(true);
    expect(await store.delete("linkedin")).toBe(false);
    expect(await store.list()).toEqual([]);
  });

  it("schedule com Input estranho é ignorado na lista", async () => {
    const f = fakeScheduler();
    f.schedules.set("x", { Name: "x", Target: { Input: "não é json" } });
    expect(await new SchedulerReminderStore({ send: f.send } as never, cfg).list()).toEqual([]);
  });

  it("classifica erros: permissão não repete, limite/servidor repete", async () => {
    const failing = (err: object) => new SchedulerReminderStore({ send: vi.fn(async () => Promise.reject(err)) } as never, cfg);
    await expect(failing({ name: "AccessDeniedException", $metadata: { httpStatusCode: 403 } }).list()).rejects.toBeInstanceOf(ReminderApiError);
    await expect(failing({ name: "ThrottlingException", $metadata: { httpStatusCode: 400 } }).list()).rejects.toBeInstanceOf(ReminderUnavailable);
    await expect(failing({ name: "InternalServerException", $metadata: { httpStatusCode: 500 } }).create(rem())).rejects.toBeInstanceOf(ReminderUnavailable);
  });

  it("configuração pelo ambiente; incompleta = desligado", () => {
    const env = {
      REMINDER_GROUP: "g",
      REMINDER_ROLE_ARN: "arn:role",
      REMINDER_TARGET_ARN_PREFIX: "arn:aws:lambda:sa-east-1:1:function:",
      AWS_LAMBDA_FUNCTION_NAME: "hermes-v2-HermesFunction-abc",
    };
    expect(reminderConfigFromEnv(env)).toEqual({ group: "g", roleArn: "arn:role", targetArn: "arn:aws:lambda:sa-east-1:1:function:hermes-v2-HermesFunction-abc" });
    expect(reminderConfigFromEnv({ ...env, REMINDER_GROUP: "" })).toBeUndefined();
  });
});

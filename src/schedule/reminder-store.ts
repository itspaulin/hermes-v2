import {
  CreateScheduleCommand,
  DeleteScheduleCommand,
  GetScheduleCommand,
  ListSchedulesCommand,
  type GetScheduleCommandOutput,
  type ListSchedulesCommandOutput,
  type SchedulerClient,
} from "@aws-sdk/client-scheduler";
import {
  cronOf,
  parseReminder,
  ReminderApiError,
  ReminderUnavailable,
  scheduleText,
  type Reminder,
  type ReminderStore,
} from "../domain/reminder.js";
import { TIMEZONE } from "../time/index.js";

/**
 * Lembretes guardados no próprio EventBridge Scheduler: um schedule por lembrete, num grupo só
 * deles. O Input do schedule leva o lembrete inteiro (é o que a Lambda recebe e o que a lista lê),
 * então não há banco. Mesmo retry dos schedules fixos do template.
 */
export interface SchedulerReminderConfig {
  group: string;
  /** Role que o Scheduler assume para invocar a Lambda. */
  roleArn: string;
  /** ARN da própria Lambda do Hermes. */
  targetArn: string;
}

type Send = Pick<SchedulerClient, "send">;

/** Payload do evento: o que runScheduled recebe. */
export function reminderEvent(r: Reminder): Record<string, unknown> {
  return { kind: "reminder", ...r };
}

const RETRYABLE = new Set(["ThrottlingException", "InternalServerException", "ServiceUnavailableException", "TimeoutError"]);

function wrap(err: unknown): Error {
  const e = err as { name?: string; $retryable?: unknown; $metadata?: { httpStatusCode?: number } };
  const name = e.name ?? "erro desconhecido";
  const status = e.$metadata?.httpStatusCode;
  // Só o nome do erro: a mensagem do SDK pode trazer ARNs, que não interessam ao usuário.
  if (RETRYABLE.has(name) || e.$retryable !== undefined || (status !== undefined && status >= 500)) {
    return new ReminderUnavailable(`Scheduler indisponível: ${name}`);
  }
  return new ReminderApiError(`Scheduler recusou: ${name}`);
}

export class SchedulerReminderStore implements ReminderStore {
  constructor(
    private readonly client: Send,
    private readonly config: SchedulerReminderConfig,
  ) {}

  async list(): Promise<Reminder[]> {
    try {
      const names: string[] = [];
      let token: string | undefined;
      do {
        const page = (await this.client.send(
          new ListSchedulesCommand({ GroupName: this.config.group, ...(token && { NextToken: token }) }),
        )) as ListSchedulesCommandOutput;
        for (const s of page.Schedules ?? []) if (s.Name) names.push(s.Name);
        token = page.NextToken;
      } while (token);

      const got = (await Promise.all(
        names.map((Name) => this.client.send(new GetScheduleCommand({ GroupName: this.config.group, Name }))),
      )) as GetScheduleCommandOutput[];
      const out: Reminder[] = [];
      for (const s of got) {
        const r = parseInput(s.Target?.Input);
        if (r) out.push(r);
        else console.error(`[reminders] schedule ignorado (Input inválido): ${s.Name ?? "?"}`);
      }
      return out.sort((a, b) => (a.time === b.time ? a.id.localeCompare(b.id) : a.time < b.time ? -1 : 1));
    } catch (err) {
      throw wrap(err);
    }
  }

  async create(r: Reminder): Promise<void> {
    try {
      await this.client.send(
        new CreateScheduleCommand({
          Name: r.id,
          GroupName: this.config.group,
          Description: `${scheduleText(r)}: ${r.text}`.slice(0, 512),
          ScheduleExpression: cronOf(r),
          ScheduleExpressionTimezone: TIMEZONE,
          FlexibleTimeWindow: { Mode: "OFF" },
          State: "ENABLED",
          Target: {
            Arn: this.config.targetArn,
            RoleArn: this.config.roleArn,
            Input: JSON.stringify(reminderEvent(r)),
            RetryPolicy: { MaximumRetryAttempts: 2, MaximumEventAgeInSeconds: 3600 },
          },
        }),
      );
    } catch (err) {
      throw wrap(err);
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      await this.client.send(new DeleteScheduleCommand({ GroupName: this.config.group, Name: id }));
      return true;
    } catch (err) {
      if ((err as { name?: string }).name === "ResourceNotFoundException") return false;
      throw wrap(err);
    }
  }
}

function parseInput(input: string | undefined): Reminder | null {
  if (!input) return null;
  try {
    return parseReminder(JSON.parse(input));
  } catch {
    return null;
  }
}

/** Configuração pelo ambiente da Lambda. Ausente = lembretes desligados. */
export function reminderConfigFromEnv(env: NodeJS.ProcessEnv): SchedulerReminderConfig | undefined {
  const { REMINDER_GROUP, REMINDER_ROLE_ARN, REMINDER_TARGET_ARN_PREFIX, AWS_LAMBDA_FUNCTION_NAME } = env;
  if (!REMINDER_GROUP || !REMINDER_ROLE_ARN || !REMINDER_TARGET_ARN_PREFIX || !AWS_LAMBDA_FUNCTION_NAME) return undefined;
  return { group: REMINDER_GROUP, roleArn: REMINDER_ROLE_ARN, targetArn: `${REMINDER_TARGET_ARN_PREFIX}${AWS_LAMBDA_FUNCTION_NAME}` };
}

/** Para testes: mesma interface, em memória. */
export class InMemoryReminderStore implements ReminderStore {
  readonly items = new Map<string, Reminder>();
  async list(): Promise<Reminder[]> {
    return [...this.items.values()].sort((a, b) => (a.time === b.time ? a.id.localeCompare(b.id) : a.time < b.time ? -1 : 1));
  }
  async create(r: Reminder): Promise<void> {
    if (this.items.has(r.id)) throw new ReminderApiError("Scheduler recusou: ConflictException");
    this.items.set(r.id, r);
  }
  async delete(id: string): Promise<boolean> {
    return this.items.delete(id);
  }
}

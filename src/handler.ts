import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { CheckinRepository } from "./domain/checkin-repository.js";
import { ReviewRepository } from "./domain/review-repository.js";
import { MetaRepository } from "./domain/meta-repository.js";
import { TaskRepository } from "./domain/task-repository.js";
import { createBedrockConverse } from "../shared/ai/bedrock.js";
import { loadAiConfig } from "../shared/ai/config.js";
import { createHermesAi, createHermesConversation } from "./ai/hermes.js";
import { parseScheduledEvent, runScheduled, type ScheduleDeps } from "./schedule/run.js";
import { createSsmReader } from "./ssm.js";
import { createTelegramClient } from "./telegram/client.js";
import { loadTelegramConfig, telegramParamNamesFromEnv } from "./telegram/config.js";
import { handleWebhook, type WebhookDeps } from "./telegram/webhook.js";
import { systemClock } from "./time/index.js";
import { loadVaultConfig } from "./vault/config.js";
import { createGitHubVaultStore } from "./vault/github-store.js";

/** Handler do API Gateway (webhook do Telegram). Dependências entram por fábrica: o 2º argumento do Lambda é o context. */
export function createHandler(deps: WebhookDeps) {
  return (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> =>
    handleWebhook(event, deps);
}

type Route = {
  http: ReturnType<typeof createHandler>;
  schedule: (event: ReturnType<typeof parseScheduledEvent> & object) => Promise<string>;
};

// Cache do cold start: só otimização. Falha não é cacheada, a próxima invocação tenta de novo.
let cached: Promise<Route> | undefined;

async function build(): Promise<Route> {
  const ssm = createSsmReader();
  // Telegram e Vault em paralelo: 4 GetParameter no total, só no cold start.
  const [config, vault] = await Promise.all([
    loadTelegramConfig(ssm, telegramParamNamesFromEnv(process.env)),
    loadVaultConfig(ssm, process.env),
  ]);
  const store = createGitHubVaultStore(vault);
  const client = createTelegramClient(config.botToken);
  const repos = {
    tasks: new TaskRepository(store, systemClock),
    metas: new MetaRepository(store, systemClock),
    checkins: new CheckinRepository(store, systemClock),
    reviews: new ReviewRepository(store, systemClock),
  };
  // IA opcional: desligada (padrão) ou mal configurada, o bot segue só com os comandos.
  const aiConfig = loadAiConfig(process.env);
  const converse = aiConfig
    ? createHermesConversation(createHermesAi(aiConfig, createBedrockConverse(aiConfig.region)), { clock: systemClock, ...repos })
    : undefined;
  const scheduleDeps: ScheduleDeps = { clock: systemClock, client, chatIds: config.allowedChatIds, ...repos };
  return {
    http: createHandler({ config, client, clock: systemClock, ...repos, ...(converse && { converse }) }),
    schedule: (ev) => runScheduled(ev, scheduleDeps),
  };
}

/**
 * Export de produção. Dois tipos de evento na mesma Lambda: o webhook do Telegram (API Gateway)
 * e os check-ins agendados (EventBridge Scheduler, `{"kind": ...}`). Dependências (SSM) são
 * montadas na primeira invocação, não no import. Falha no agendado propaga: o Scheduler repete.
 */
export const handler = async (event: unknown): Promise<APIGatewayProxyResultV2 | string> => {
  cached ??= build().catch((err) => {
    cached = undefined;
    throw err;
  });
  const route = await cached;

  const scheduled = parseScheduledEvent(event);
  if (scheduled) {
    const outcome = await route.schedule(scheduled);
    console.log(`[schedule] ${outcome}`);
    return outcome;
  }
  return route.http(event as APIGatewayProxyEventV2);
};

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { createSsmReader } from "./ssm.js";
import { createTelegramClient } from "./telegram/client.js";
import { loadTelegramConfig, telegramParamNamesFromEnv } from "./telegram/config.js";
import { handleWebhook, type WebhookDeps } from "./telegram/webhook.js";
import { systemClock } from "./time/index.js";

/** Handler do API Gateway (webhook do Telegram). Dependências entram por fábrica: o 2º argumento do Lambda é o context. */
export function createHandler(deps: WebhookDeps) {
  return (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> =>
    handleWebhook(event, deps);
}

// Cache do cold start: só otimização. Falha não é cacheada, a próxima invocação tenta de novo.
let cached: Promise<ReturnType<typeof createHandler>> | undefined;

async function build(): Promise<ReturnType<typeof createHandler>> {
  const config = await loadTelegramConfig(
    createSsmReader(),
    telegramParamNamesFromEnv(process.env),
  );
  return createHandler({
    config,
    client: createTelegramClient(config.botToken),
    clock: systemClock,
  });
}

/** Export de produção: monta as dependências (SSM) na primeira invocação, não no import. */
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  cached ??= build().catch((err) => {
    cached = undefined;
    throw err;
  });
  return (await cached)(event);
};

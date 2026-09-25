import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { createTelegramClient } from "./telegram/client.js";
import { loadTelegramConfig } from "./telegram/config.js";
import { handleWebhook, type WebhookDeps } from "./telegram/webhook.js";
import { systemClock } from "./time/index.js";

/** Handler do API Gateway (webhook do Telegram). Dependências entram por fábrica: o 2º argumento do Lambda é o context. */
export function createHandler(deps: WebhookDeps) {
  return (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> =>
    handleWebhook(event, deps);
}

let cached: ReturnType<typeof createHandler> | undefined;

/** Export de produção: monta as dependências na primeira invocação (não no import). */
export const handler = (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  if (!cached) {
    const config = loadTelegramConfig(process.env);
    cached = createHandler({
      config,
      client: createTelegramClient(config.botToken),
      clock: systemClock,
    });
  }
  return cached(event);
};

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { nowIso, systemClock, TIMEZONE, type Clock } from "./time/index.js";

/**
 * Handler mínimo da fundação. Ainda não processa Telegram nem jobs agendados.
 * Devolve 200 com o horário atual, para validar deploy e camada de tempo.
 * O Clock entra por fábrica (o 2º argumento do Lambda é o context, não um clock).
 */
export function createHandler(clock: Clock) {
  return async (_event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => ({
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ok: true, timezone: TIMEZONE, now: nowIso(clock) }),
  });
}

export const handler = createHandler(systemClock);

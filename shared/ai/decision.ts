/** Valida o `input` de uma ação. Devolve o input normalizado, ou null se inválido. */
export type InputValidator<Input> = (input: unknown) => Input | null;

export type ActionSchemas<Actions extends Record<string, unknown>> = {
  [K in keyof Actions & string]: InputValidator<Actions[K]>;
};

export type DecisionOf<Actions extends Record<string, unknown>> =
  | { type: "reply"; message: string }
  | { type: "clarify"; message: string }
  | { [K in keyof Actions & string]: { type: "action"; action: K; input: Actions[K]; message?: string } }[keyof Actions & string];

const MAX_MESSAGE_CHARS = 2000;

function extractJson(raw: string): unknown {
  let s = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(s);
  if (fenced) s = fenced[1]!;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function cleanMessage(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s !== "" && s.length <= MAX_MESSAGE_CHARS ? s : null;
}

/**
 * Texto do modelo -> decisão validada, ou null. Fora do contrato (JSON inválido, tipo desconhecido,
 * ação fora da allowlist, input inválido) nunca vira ação. `Object.hasOwn` impede que nomes como
 * "constructor" passem pela allowlist.
 */
export type Rejection = "json_invalid" | "type_unknown" | "message_invalid" | "action_not_allowed" | "input_invalid";

/** Por que o texto do modelo foi recusado. Só um código fixo, nunca o conteúdo (serve para os logs). */
export function explainRejection<Actions extends Record<string, unknown>>(raw: string, schemas: ActionSchemas<Actions>): Rejection {
  const obj = extractJson(raw);
  if (!isRecord(obj)) return "json_invalid";
  if (obj.type === "reply" || obj.type === "clarify") return "message_invalid";
  const flattened = typeof obj.type === "string" && Object.hasOwn(schemas, obj.type);
  if (obj.type !== "action" && !flattened) return "type_unknown";
  const name = flattened ? obj.type : obj.action;
  if (typeof name !== "string" || !Object.hasOwn(schemas, name)) return "action_not_allowed";
  return "input_invalid";
}

export function parseDecision<Actions extends Record<string, unknown>>(
  raw: string,
  schemas: ActionSchemas<Actions>,
): DecisionOf<Actions> | null {
  const obj = extractJson(raw);
  if (!isRecord(obj)) return null;

  const message = cleanMessage(obj.message);
  if (obj.type === "reply" || obj.type === "clarify") {
    return message ? { type: obj.type, message } : null;
  }
  // Erro comum de modelos pequenos: o nome da ação no lugar de "action" ({"type":"save_note",...}).
  // Aceito só se o nome está na allowlist; o input vem de `input` ou dos demais campos soltos.
  const flattened = typeof obj.type === "string" && Object.hasOwn(schemas, obj.type);
  if (obj.type !== "action" && !flattened) return null;

  const name = flattened ? obj.type : obj.action;
  if (typeof name !== "string" || !Object.hasOwn(schemas, name)) return null;
  const validate = schemas[name as keyof Actions & string] as InputValidator<unknown>;
  const loose = flattened && obj.input === undefined ? Object.fromEntries(Object.entries(obj).filter(([k]) => k !== "type" && k !== "message")) : undefined;
  const input = validate(obj.input === undefined ? (loose ?? {}) : obj.input);
  if (input === null) return null;
  return { type: "action", action: name, input, ...(message && { message }) } as DecisionOf<Actions>;
}

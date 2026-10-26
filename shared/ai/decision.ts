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
  if (obj.type !== "action") return null;

  const name = obj.action;
  if (typeof name !== "string" || !Object.hasOwn(schemas, name)) return null;
  const validate = schemas[name as keyof Actions & string] as InputValidator<unknown>;
  const input = validate(obj.input === undefined ? {} : obj.input);
  if (input === null) return null;
  return { type: "action", action: name, input, ...(message && { message }) } as DecisionOf<Actions>;
}

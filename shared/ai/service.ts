import { explainRejection, parseDecision, type ActionSchemas, type DecisionOf } from "./decision.js";
import type { Converse, ConverseImage } from "./bedrock.js";
import type { AiConfig, AiFailureReason, AiResult, AssistantId, ConversationTurn } from "./types.js";

export interface DecideInput {
  /** Mensagem atual do usuário (texto não confiável). */
  message: string;
  history?: readonly ConversationTurn[];
  /** Imagens da mensagem atual (só a atual: o histórico é texto). */
  images?: readonly ConverseImage[];
  /** Linhas extras de contexto confiável do código (ex.: data de hoje), anexadas ao prompt do sistema. */
  context?: string;
}

export interface AiService<Actions extends Record<string, unknown>> {
  decide(input: DecideInput): Promise<AiResult<DecisionOf<Actions>>>;
}

export interface AiServiceOptions<Actions extends Record<string, unknown>> {
  assistant: AssistantId;
  /** Instruções de sistema DESTE assistente. Nunca compartilhadas entre Hermes e Renato. */
  systemPrompt: string;
  schemas: ActionSchemas<Actions>;
  config: AiConfig;
  converse: Converse;
}

const TEMPERATURE = 0.3;

function classify(err: unknown): AiFailureReason {
  const name = typeof err === "object" && err !== null && "name" in err ? String((err as { name: unknown }).name) : "";
  if (name === "ThrottlingException" || name === "ServiceQuotaExceededException") return "throttled";
  if (name === "AbortError" || name === "TimeoutError") return "timeout";
  return "error";
}

/** Histórico limitado, começando por turno do usuário e alternando papéis (exigência do Converse). */
function normalizeHistory(history: readonly ConversationTurn[], max: number, maxChars: number): ConversationTurn[] {
  const out: ConversationTurn[] = [];
  for (const t of history.slice(-max)) {
    const text = t.text.trim().slice(0, maxChars);
    if (text === "") continue;
    const last = out[out.length - 1];
    if (last?.role === t.role) out[out.length - 1] = { role: t.role, text };
    else if (last || t.role === "user") out.push({ role: t.role, text });
  }
  if (out[out.length - 1]?.role === "user") out.pop(); // a mensagem atual é do usuário: dois seguidos seriam inválidos
  return out;
}

/**
 * Serviço de IA: monta o pedido, chama o modelo, valida a saída. Nunca lança, nunca executa ação e
 * não conhece persistência. Logs só com assistente, motivo, latência e tokens (nunca o conteúdo).
 */
export function createAiService<Actions extends Record<string, unknown>>(
  opts: AiServiceOptions<Actions>,
): AiService<Actions> {
  const { assistant, config, converse } = opts;
  const fail = (reason: AiFailureReason): AiResult<never> => {
    console.error(`[ai] assistant=${assistant} falha=${reason}`);
    return { ok: false, reason };
  };

  return {
    async decide({ message, history = [], context, images = [] }) {
      const text = message.trim();
      if (text === "") return fail("invalid_output");
      if (text.length > config.maxInputChars) return fail("input_too_long");

      const messages = [
        ...normalizeHistory(history, config.maxHistoryMessages, config.maxInputChars),
        { role: "user" as const, text, ...(images.length > 0 && { images: [...images] }) },
      ];
      const system = context ? `${opts.systemPrompt}\n\n${context}` : opts.systemPrompt;

      const started = Date.now();
      let response;
      try {
        response = await converse(
          { modelId: config.modelId, system, messages, maxTokens: config.maxOutputTokens, temperature: TEMPERATURE },
          AbortSignal.timeout(config.timeoutMs),
        );
      } catch (err) {
        return fail(classify(err));
      }

      const decision = parseDecision<Actions>(response.text, opts.schemas);
      if (!decision) {
        const why = explainRejection(response.text, opts.schemas);
        // Só o valor de `type` (um token estrutural curto), nunca o conteúdo da resposta.
        const typeValue = why === "type_unknown" ? /"type"\s*:\s*"([a-z_]{1,30})"/.exec(response.text)?.[1] : undefined;
        console.error(`[ai] assistant=${assistant} saida_recusada=${why}${typeValue ? ` type=${typeValue}` : ""}`);
        return fail("invalid_output");
      }
      console.log(
        `[ai] assistant=${assistant} ok ms=${Date.now() - started} in=${response.inputTokens ?? "?"} out=${response.outputTokens ?? "?"}`,
      );
      return { ok: true, decision };
    },
  };
}

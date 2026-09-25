/**
 * Fonte única do "agora". Nada fora de src/time pode chamar Date.now()/new Date().
 * Em produção usa o relógio do sistema; em testes usa um relógio fixo.
 */
export interface Clock {
  /** Instante atual, em epoch milliseconds (UTC). */
  nowMs(): number;
}

export const systemClock: Clock = {
  nowMs: () => Date.now(),
};

/** Relógio de teste: instante fixo, avançável manualmente. */
export interface FakeClock extends Clock {
  set(iso: string): void;
  advanceMs(ms: number): void;
}

export function fakeClock(iso: string): FakeClock {
  let ms = parseInstant(iso);
  return {
    nowMs: () => ms,
    set(next) {
      ms = parseInstant(next);
    },
    advanceMs(delta) {
      ms += delta;
    },
  };
}

function parseInstant(iso: string): number {
  // Exige offset explícito: "2026-09-25T10:00:00" sem offset é ambíguo.
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(iso)) {
    throw new Error(`Instante sem offset explícito: ${iso}`);
  }
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`Instante inválido: ${iso}`);
  return ms;
}

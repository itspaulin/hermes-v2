import { describe, expect, it } from "vitest";
import { TIMEZONE, fixedClock, localDate, localIso, utcIso } from "../src/clock.js";

describe("clock", () => {
  it("usa America/Sao_Paulo", () => {
    expect(TIMEZONE).toBe("America/Sao_Paulo");
  });

  it("relógio fixo é injetável e estável", () => {
    const clock = fixedClock("2026-01-15T15:30:00Z");
    expect(utcIso(clock.now())).toBe("2026-01-15T15:30:00.000Z");
    expect(utcIso(clock.now())).toBe("2026-01-15T15:30:00.000Z");
  });

  it("rejeita instante inválido", () => {
    expect(() => fixedClock("nope")).toThrow();
  });

  it("converte para horário local com offset -03:00", () => {
    expect(localIso(new Date("2026-01-15T15:30:00Z"))).toBe("2026-01-15T12:30:00-03:00");
  });

  it("data local cruza a meia-noite corretamente", () => {
    expect(localDate(new Date("2026-01-16T02:30:00Z"))).toBe("2026-01-15");
    expect(localDate(new Date("2026-01-16T03:00:00Z"))).toBe("2026-01-16");
  });
});

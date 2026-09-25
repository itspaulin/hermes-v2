import { describe, expect, it } from "vitest";
import { SCHEDULES } from "../src/config.js";
import { parseLocalTime } from "../src/time/index.js";

describe("SCHEDULES", () => {
  it("horários são válidos", () => {
    for (const s of SCHEDULES) expect(() => parseLocalTime(s.time)).not.toThrow();
  });

  it("domingo não tem nenhuma entrada", () => {
    expect(SCHEDULES.some((s) => s.weekday === 7)).toBe(false);
  });

  it("segunda a sábado tem exatamente uma entrada por dia", () => {
    const days = SCHEDULES.map((s) => s.weekday).sort();
    expect(days).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("quinta é métricas e sábado é revisão semanal às 18:00", () => {
    expect(SCHEDULES.find((s) => s.weekday === 4)?.kind).toBe("metrics");
    const sat = SCHEDULES.find((s) => s.weekday === 6);
    expect(sat).toMatchObject({ kind: "weekly_review", time: "18:00" });
  });
});

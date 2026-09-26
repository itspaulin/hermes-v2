import { describe, expect, it } from "vitest";
import {
  addDays,
  currentWeek,
  diffDays,
  fakeClock,
  isRestDay,
  localDateOfInstant,
  nowIso,
  parseLocalDate,
  timeOfDay,
  today,
  tomorrow,
  toInstantIso,
  weekdayOf,
  weekOf,
  yesterday,
  type LocalDate,
  type LocalTime,
} from "../src/time/index.js";

const d = (s: string) => s as LocalDate;
const t = (s: string) => s as LocalTime;

describe("hoje/amanhã em America/Sao_Paulo", () => {
  it("23:30 em SP (02:30 UTC do dia seguinte) ainda é o mesmo dia em SP", () => {
    const c = fakeClock("2026-09-26T02:30:00Z"); // 23:30 de 25/09 em SP
    expect(today(c)).toBe("2026-09-25");
    expect(tomorrow(c)).toBe("2026-09-26");
    expect(timeOfDay(c)).toBe("23:30");
  });

  it("00:30 em SP (03:30 UTC) já é o dia novo", () => {
    const c = fakeClock("2026-09-25T03:30:00Z");
    expect(today(c)).toBe("2026-09-25");
    expect(yesterday(c)).toBe("2026-09-24");
  });

  it("02:59 UTC ainda é ontem em SP; 03:00 UTC vira o dia", () => {
    expect(today(fakeClock("2026-09-25T02:59:59Z"))).toBe("2026-09-24");
    expect(today(fakeClock("2026-09-25T03:00:00Z"))).toBe("2026-09-25");
  });

  it("entrada com offset diferente representa o mesmo instante", () => {
    const c = fakeClock("2026-09-25T10:00:00+09:00"); // 01:00 UTC = 22:00 de 24/09 em SP
    expect(today(c)).toBe("2026-09-24");
  });

  it("nowIso sai com offset -03:00", () => {
    expect(nowIso(fakeClock("2026-09-25T17:30:00Z"))).toBe("2026-09-25T14:30:00-03:00");
  });

  it("nowIso sempre com precisão de segundos, mesmo com milissegundos no relógio", () => {
    expect(nowIso(fakeClock("2026-09-25T17:30:00.430Z"))).toBe("2026-09-25T14:30:00-03:00");
    expect(nowIso(fakeClock("2026-09-25T17:30:59.999Z"))).toBe("2026-09-25T14:30:59-03:00");
    expect(nowIso(fakeClock("2026-09-25T17:30:00.000Z"))).toBe("2026-09-25T14:30:00-03:00");
  });

  it("relógio avança", () => {
    const c = fakeClock("2026-09-25T02:59:00Z");
    expect(today(c)).toBe("2026-09-24");
    c.advanceMs(60_000);
    expect(today(c)).toBe("2026-09-25");
  });

  it("rejeita instante sem offset", () => {
    expect(() => fakeClock("2026-09-25T10:00:00")).toThrow();
  });
});

describe("aritmética de datas", () => {
  it("virada de mês, ano e bissexto", () => {
    expect(addDays(d("2026-01-31"), 1)).toBe("2026-02-01");
    expect(addDays(d("2026-12-31"), 1)).toBe("2027-01-01");
    expect(addDays(d("2028-02-28"), 1)).toBe("2028-02-29");
    expect(addDays(d("2026-02-28"), 1)).toBe("2026-03-01");
    expect(addDays(d("2026-03-01"), -1)).toBe("2026-02-28");
  });

  it("diffDays", () => {
    expect(diffDays(d("2026-09-25"), d("2026-09-28"))).toBe(3);
    expect(diffDays(d("2026-09-28"), d("2026-09-25"))).toBe(-3);
  });

  it("parseLocalDate rejeita datas inválidas ou inexistentes", () => {
    expect(() => parseLocalDate("2026-02-30")).toThrow();
    expect(() => parseLocalDate("2026-13-01")).toThrow();
    expect(() => parseLocalDate("25/09/2026")).toThrow();
    expect(() => parseLocalDate("2026-9-5")).toThrow();
    expect(parseLocalDate("2028-02-29")).toBe("2028-02-29");
  });
});

describe("semana (segunda a domingo)", () => {
  it("2026-09-25 é sexta", () => {
    expect(weekdayOf(d("2026-09-25"))).toBe(5);
  });

  it("qualquer dia da semana mapeia para a mesma segunda", () => {
    for (const day of ["2026-09-21", "2026-09-23", "2026-09-26", "2026-09-27"]) {
      const w = weekOf(d(day));
      expect(w.start).toBe("2026-09-21");
      expect(w.end).toBe("2026-09-27");
      expect(w.days).toHaveLength(7);
    }
  });

  it("domingo é descanso e pertence à semana que termina nele", () => {
    expect(isRestDay(d("2026-09-27"))).toBe(true);
    expect(isRestDay(d("2026-09-26"))).toBe(false);
    expect(weekOf(d("2026-09-27")).start).toBe("2026-09-21");
  });

  it("semana atravessa virada de ano", () => {
    const w = weekOf(d("2026-12-31")); // quinta
    expect(w.start).toBe("2026-12-28");
    expect(w.end).toBe("2027-01-03");
  });

  it("currentWeek usa o fuso de SP: sábado 22:00 SP é domingo UTC, mas segue na mesma semana", () => {
    const c = fakeClock("2026-09-27T01:00:00Z"); // sábado 26/09 22:00 em SP
    expect(today(c)).toBe("2026-09-26");
    expect(currentWeek(c).start).toBe("2026-09-21");
  });

  it("domingo 22:00 SP (segunda 01:00 UTC) ainda é a semana antiga", () => {
    const c = fakeClock("2026-09-28T01:00:00Z");
    expect(today(c)).toBe("2026-09-27");
    expect(currentWeek(c).start).toBe("2026-09-21");
  });
});

describe("instantes", () => {
  it("toInstantIso aplica offset de SP", () => {
    expect(toInstantIso(d("2026-09-25"), t("14:00"))).toBe("2026-09-25T14:00:00-03:00");
  });

  it("rejeita horário inválido", () => {
    expect(() => toInstantIso(d("2026-09-25"), t("24:00"))).toThrow();
    expect(() => toInstantIso(d("2026-09-25"), t("9:00"))).toThrow();
  });

  it("horário inexistente por horário de verão histórico é rejeitado", () => {
    // Brasil: DST começou 2018-11-04 00:00 -> 01:00; 00:30 não existiu.
    expect(() => toInstantIso(d("2018-11-04"), t("00:30"))).toThrow();
  });

  it("localDateOfInstant converte para a data de SP", () => {
    expect(localDateOfInstant("2026-09-26T02:30:00Z")).toBe("2026-09-25");
    expect(localDateOfInstant("2026-09-25T23:30:00-03:00")).toBe("2026-09-25");
    expect(localDateOfInstant("2026-09-26T08:00:00+09:00")).toBe("2026-09-25");
  });

  it("localDateOfInstant exige offset", () => {
    expect(() => localDateOfInstant("2026-09-25T10:00:00")).toThrow();
  });

  it("dia com DST histórico: hoje continua correto", () => {
    // 2018-11-04 03:30Z = 01:30 em SP (já em DST, -02:00)
    expect(today(fakeClock("2018-11-04T03:30:00Z"))).toBe("2018-11-04");
  });
});

describe("isoWeekLabel", () => {
  it("usa a semana ISO, com virada de ano", async () => {
    const { isoWeekLabel, parseLocalDate } = await import("../src/time/index.js");
    expect(isoWeekLabel(parseLocalDate("2026-09-21"))).toBe("2026-W39");
    expect(isoWeekLabel(parseLocalDate("2026-09-27"))).toBe("2026-W39");
    expect(isoWeekLabel(parseLocalDate("2026-09-28"))).toBe("2026-W40");
    expect(isoWeekLabel(parseLocalDate("2026-01-01"))).toBe("2026-W01");
    expect(isoWeekLabel(parseLocalDate("2027-01-01"))).toBe("2026-W53");
    expect(isoWeekLabel(parseLocalDate("2024-12-30"))).toBe("2025-W01");
  });
});

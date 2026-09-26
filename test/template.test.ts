import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SCHEDULES } from "../src/config.js";

const DOW = ["", "MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

describe("template.yaml x src/config.ts", () => {
  const template = readFileSync("template.yaml", "utf8");
  const found = [
    ...template.matchAll(
      /ScheduleExpression: cron\((\d+) (\d+) \? \* (\w+) \*\)\s+ScheduleExpressionTimezone: (\S+)\s+Input: '\{"kind":"(\w+)"\}'/g,
    ),
  ].map(([, min, hour, dow, tz, kind]) => `${dow} ${hour!.padStart(2, "0")}:${min!.padStart(2, "0")} ${kind} ${tz}`);

  it("cada horário de SCHEDULES tem um schedule no template, na mesma hora, dia e tipo, no fuso oficial", () => {
    const expected = SCHEDULES.map((s) => `${DOW[s.weekday]} ${s.time} ${s.kind} America/Sao_Paulo`);
    expect(found.sort()).toEqual(expected.sort());
  });

  it("domingo não tem schedule", () => {
    expect(found.some((f) => f.startsWith("SUN"))).toBe(false);
  });
});

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

describe("fronteira do módulo de tempo", () => {
  it("nada fora de src/time usa Date, Date.now, luxon ou process.env.TZ", () => {
    const offenders = files("src")
      .filter((f) => !f.startsWith(join("src", "time")))
      .filter((f) => /\bnew Date\b|\bDate\.(now|parse|UTC)\b|from "luxon"|process\.env\.TZ/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});

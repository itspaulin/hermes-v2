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

describe("fronteira de camadas", () => {
  const imports = (dir: string) =>
    files(dir).filter((f) => /from "[^"]*\/(telegram|handler)[^"]*"/.test(readFileSync(f, "utf8")));

  it("domínio e vault não conhecem Telegram nem o handler", () => {
    expect([...imports(join("src", "domain")), ...imports(join("src", "vault"))]).toEqual([]);
  });

  it("vault não conhece o domínio", () => {
    const offenders = files(join("src", "vault")).filter((f) => /from "[^"]*\/domain\//.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});

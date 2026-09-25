import { describe, expect, it } from "vitest";
import {
  instantIsoOfEpochSeconds,
  localDateOfEpochSeconds,
  parseInstantIso,
} from "../src/time/index.js";

const epoch = (iso: string) => Date.parse(iso) / 1000;

describe("tempo do evento (epoch seconds)", () => {
  it("23:59 em SP ainda é o dia 25, mesmo já sendo dia 26 em UTC", () => {
    const e = epoch("2026-09-26T02:59:00Z"); // 25/09 23:59 em SP
    expect(localDateOfEpochSeconds(e)).toBe("2026-09-25");
    expect(instantIsoOfEpochSeconds(e)).toBe("2026-09-25T23:59:00-03:00");
  });

  it("00:01 em SP já é o dia 26", () => {
    expect(localDateOfEpochSeconds(epoch("2026-09-26T03:01:00Z"))).toBe("2026-09-26");
  });

  it("limite exato: 02:59:59Z é dia 25, 03:00:00Z é dia 26", () => {
    expect(localDateOfEpochSeconds(epoch("2026-09-26T02:59:59Z"))).toBe("2026-09-25");
    expect(localDateOfEpochSeconds(epoch("2026-09-26T03:00:00Z"))).toBe("2026-09-26");
  });

  it("não depende do relógio: mesmo epoch, mesmo resultado sempre", () => {
    const e = epoch("2026-09-26T02:59:00Z");
    expect(localDateOfEpochSeconds(e)).toBe(localDateOfEpochSeconds(e));
  });

  it("virada de ano e bissexto", () => {
    expect(localDateOfEpochSeconds(epoch("2027-01-01T02:59:59Z"))).toBe("2026-12-31");
    expect(localDateOfEpochSeconds(epoch("2028-02-29T12:00:00Z"))).toBe("2028-02-29");
  });

  it.each([-1, 1.5, NaN, Infinity, 4_102_444_801, Number.MAX_SAFE_INTEGER + 1])("rejeita epoch inválido %s", (v) => {
    expect(() => localDateOfEpochSeconds(v)).toThrow();
    expect(() => instantIsoOfEpochSeconds(v)).toThrow();
  });
});

describe("parseInstantIso", () => {
  it("aceita instante com offset e devolve inalterado", () => {
    expect(parseInstantIso("2026-09-25T15:00:00-03:00")).toBe("2026-09-25T15:00:00-03:00");
    expect(parseInstantIso("2026-09-25T18:00:00Z")).toBe("2026-09-25T18:00:00Z");
  });

  it.each(["2026-09-25T15:00:00", "2026-09-25", "lixo", "", "2026-13-01T00:00:00Z"])("rejeita %j", (v) => {
    expect(() => parseInstantIso(v)).toThrow();
  });
});

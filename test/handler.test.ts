import { describe, expect, it } from "vitest";
import { createHandler } from "../src/handler.js";
import { fakeClock } from "../src/time/index.js";

describe("handler", () => {
  it("responde 200 com horário de SP", async () => {
    const h = createHandler(fakeClock("2026-09-25T17:30:00Z"));
    const res = (await h({} as never)) as { statusCode: number; body: string };
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      ok: true,
      timezone: "America/Sao_Paulo",
      now: "2026-09-25T14:30:00-03:00",
    });
  });
});

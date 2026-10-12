import { describe, expect, it, vi } from "vitest";
import { fixedClock } from "../src/clock.js";
import { type CaptureNoteCommand, createTelegramHandler } from "../src/handler.js";

const clock = fixedClock("2026-01-15T15:30:00.000Z");

function setup(capture?: (c: CaptureNoteCommand) => void | Promise<void>) {
  const fn = vi.fn(capture ?? (() => undefined));
  return { fn, handle: createTelegramHandler({ clock, capture: fn }) };
}

const update = (message: Record<string, unknown>) => ({ update_id: 10, message });
const base = { message_id: 42, date: 1768491000, chat: { id: 777 } };

describe("createTelegramHandler", () => {
  it("converte mensagem de texto válida em comando de captura", async () => {
    const { fn, handle } = setup();
    const res = await handle(update({ ...base, text: "ideia: app de receitas #cozinha" }));
    expect(res).toEqual({
      statusCode: 200,
      body: { status: "accepted", noteId: "telegram-777-42" },
    });
    expect(fn).toHaveBeenCalledOnce();
    const command = fn.mock.calls[0]![0];
    expect(command.type).toBe("capture_note");
    expect(command.note.category).toBe("ideia");
    expect(command.note.tags).toEqual(["cozinha"]);
    expect(command.note.originalContent).toBe("ideia: app de receitas #cozinha");
    expect(command.note.createdAt).toBe("2026-01-15T15:30:00.000Z");
    expect(command.note.source).toEqual({ kind: "telegram", messageId: "42" });
  });

  it.each([null, "texto", 5, [], {}, { update_id: "1" }, { update_id: 1.5 }])(
    "rejeita payload inválido %j",
    async (payload) => {
      const { fn, handle } = setup();
      const res = await handle(payload);
      expect(res.statusCode).toBe(400);
      expect(res.body.status).toBe("invalid");
      expect(fn).not.toHaveBeenCalled();
    },
  );

  it.each([
    { ...base, message_id: "x", text: "oi" },
    { ...base, chat: {}, text: "oi" },
    { ...base, date: null, text: "oi" },
    { ...base, text: 123 },
    "não é objeto",
  ])("rejeita mensagem malformada %j", async (message) => {
    const { fn, handle } = setup();
    const res = await handle({ update_id: 1, message });
    expect(res.statusCode).toBe(400);
    expect(res.body.status).toBe("invalid");
    expect(fn).not.toHaveBeenCalled();
  });

  it("ignora mensagem sem texto", async () => {
    const { fn, handle } = setup();
    const res = await handle(update({ ...base, photo: [] }));
    expect(res).toEqual({ statusCode: 200, body: { status: "ignored", reason: "no_text" } });
    expect(await handle(update({ ...base, text: "   " }))).toMatchObject({
      body: { reason: "no_text" },
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it("ignora update não suportado", async () => {
    const { fn, handle } = setup();
    const res = await handle({ update_id: 3, edited_message: { ...base, text: "oi" } });
    expect(res).toEqual({
      statusCode: 200,
      body: { status: "ignored", reason: "unsupported_update" },
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it("converte falha síncrona da dependência em 500", async () => {
    const { handle } = setup(() => {
      throw new Error("vault indisponível");
    });
    const res = await handle(update({ ...base, text: "oi" }));
    expect(res).toEqual({ statusCode: 500, body: { status: "error", reason: "capture_failed" } });
  });

  it("converte rejeição assíncrona da dependência em 500", async () => {
    const { handle } = setup(() => Promise.reject(new Error("falhou")));
    expect((await handle(update({ ...base, text: "oi" }))).statusCode).toBe(500);
  });

  it("não vaza a mensagem de erro da dependência", async () => {
    const { handle } = setup(() => {
      throw new Error("segredo-interno");
    });
    const res = await handle(update({ ...base, text: "oi" }));
    expect(JSON.stringify(res)).not.toContain("segredo-interno");
  });

  it("usa o relógio injetado, não o do sistema", async () => {
    const { fn, handle } = setup();
    await handle(update({ ...base, text: "oi" }));
    expect(fn.mock.calls[0]![0].note.updatedAt).toBe("2026-01-15T15:30:00.000Z");
  });
});

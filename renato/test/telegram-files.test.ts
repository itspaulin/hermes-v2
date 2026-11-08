import { describe, expect, it, vi } from "vitest";
import { parseTelegramUpdate, pickImage } from "../src/telegram.js";
import { downloadTelegramImage, MAX_IMAGE_BYTES, sniffImage } from "../src/telegram-files.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);

const msg = (extra: Record<string, unknown>) => {
  const r = parseTelegramUpdate({ update_id: 1, message: { message_id: 1, date: 1, chat: { id: 5 }, ...extra } });
  if (r.kind !== "message") throw new Error("inválido");
  return r.message;
};

describe("sniffImage", () => {
  it("reconhece png, jpeg, gif e webp pelos bytes, e recusa o resto", () => {
    expect([PNG, JPG, GIF, WEBP].map(sniffImage)).toEqual(["png", "jpeg", "gif", "webp"]);
    expect(sniffImage(new TextEncoder().encode("<svg xmlns="))).toBeNull();
    expect(sniffImage(new TextEncoder().encode("%PDF-1.7"))).toBeNull();
    expect(sniffImage(new Uint8Array())).toBeNull();
  });
});

describe("pickImage e parse de mídia", () => {
  it("pega a maior foto e a legenda", () => {
    const m = msg({ caption: "legenda", photo: [{ file_id: "p1", file_size: 100, width: 90, height: 90 }, { file_id: "p3", file_size: 9000, width: 1280, height: 720 }, { file_id: "p2", file_size: 900, width: 320, height: 180 }] });
    expect(m.caption).toBe("legenda");
    expect(pickImage(m)).toEqual({ fileId: "p3", fileSize: 9000 });
  });
  it("aceita documento com mime de imagem; ignora outros documentos e mensagens sem mídia", () => {
    expect(pickImage(msg({ document: { file_id: "d1", mime_type: "image/png", file_name: "a.png", file_size: 10 } }))).toEqual({ fileId: "d1", fileSize: 10 });
    expect(pickImage(msg({ document: { file_id: "d2", mime_type: "application/pdf" } }))).toBeNull();
    expect(pickImage(msg({ text: "oi" }))).toBeNull();
  });
  it("campos de mídia inválidos são ignorados, não derrubam o update", () => {
    const m = msg({ photo: [{ nope: 1 }, "x"], document: { mime_type: "image/png" }, caption: 5 });
    expect(m.photo).toBeUndefined();
    expect(m.document).toBeUndefined();
    expect(m.caption).toBeUndefined();
  });
});

describe("downloadTelegramImage", () => {
  const fetchOf = (file: Uint8Array | number, info: unknown = { ok: true, result: { file_path: "photos/a.jpg", file_size: 5 } }, infoStatus = 200) =>
    vi.fn(async (url: string) => {
      if (url.includes("/getFile")) return new Response(JSON.stringify(info), { status: infoStatus });
      return typeof file === "number" ? new Response("x", { status: file }) : new Response(file as unknown as BodyInit, { status: 200 });
    });

  it("baixa, detecta o formato pelos bytes e devolve nome e tipo", async () => {
    const f = fetchOf(JPG);
    const r = await downloadTelegramImage("TOKEN", "fid", f as never);
    expect(r).toMatchObject({ ok: true, format: "jpeg", contentType: "image/jpeg", filename: "imagem.jpg" });
    expect(f.mock.calls[1]![0]).toBe("https://api.telegram.org/file/botTOKEN/photos/a.jpg");
  });

  it("grande demais (pelo getFile ou pelo corpo), não-imagem e arquivo inexistente viram ok:false", async () => {
    expect(await downloadTelegramImage("T", "f", fetchOf(PNG, { ok: true, result: { file_path: "a", file_size: MAX_IMAGE_BYTES + 1 } }) as never)).toEqual({ ok: false, reason: "too_big" });
    expect(await downloadTelegramImage("T", "f", fetchOf(new Uint8Array(MAX_IMAGE_BYTES + 1).fill(0xff)) as never, MAX_IMAGE_BYTES)).toEqual({ ok: false, reason: "too_big" });
    expect(await downloadTelegramImage("T", "f", fetchOf(new TextEncoder().encode("<svg>")) as never)).toEqual({ ok: false, reason: "not_image" });
    expect(await downloadTelegramImage("T", "f", fetchOf(PNG, { ok: false, description: "file is too big" }, 400) as never)).toEqual({ ok: false, reason: "unavailable" });
    expect(await downloadTelegramImage("T", "f", fetchOf(404) as never)).toEqual({ ok: false, reason: "unavailable" });
  });

  it("falha de rede e 5xx lançam (o Telegram reenvia), sem o token na mensagem", async () => {
    const net = vi.fn(async () => Promise.reject(new TypeError("https://api.telegram.org/botSEGREDO falhou")));
    const err = await downloadTelegramImage("SEGREDO", "f", net as never).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err.message)).not.toContain("SEGREDO");
    await expect(downloadTelegramImage("T", "f", fetchOf(503) as never)).rejects.toThrow(/503/);
  });
});

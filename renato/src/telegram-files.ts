import type { ConverseImage } from "../../shared/ai/bedrock.js";

/** Limite por imagem: o Converse aceita até 3,75 MB e o plano free do Notion até 5 MiB. */
export const MAX_IMAGE_BYTES = 3_500_000;

export type Downloaded =
  | { ok: true; bytes: Uint8Array; format: ConverseImage["format"]; contentType: string; filename: string }
  | { ok: false; reason: "too_big" | "not_image" | "unavailable" };

const TYPES: Record<ConverseImage["format"], string> = { png: "image/png", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

/** O formato pelos primeiros bytes (não confia em mime nem extensão). */
export function sniffImage(b: Uint8Array): ConverseImage["format"] | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "gif";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "webp";
  return null;
}

/**
 * Baixa uma imagem do Telegram (getFile + download). A URL de download contém o token do bot: erros
 * nunca a repassam. Arquivo grande demais ou que não é imagem viram `ok:false` (resposta ao usuário);
 * falha de rede ou 5xx lança (o Telegram reenvia o update).
 */
export async function downloadTelegramImage(botToken: string, fileId: string, fetchImpl: typeof fetch = fetch, maxBytes = MAX_IMAGE_BYTES): Promise<Downloaded> {
  let meta: Response;
  try {
    meta = await fetchImpl(`https://api.telegram.org/bot${botToken}/getFile`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file_id: fileId }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("Falha de rede ao consultar o arquivo no Telegram");
  }
  if (meta.status >= 500 || meta.status === 429) throw new Error(`Telegram getFile respondeu HTTP ${meta.status}`);
  const info = (await meta.json().catch(() => null)) as { ok?: boolean; result?: { file_path?: string; file_size?: number } } | null;
  // 400 "file is too big" (acima de 20 MB) e arquivo inexistente: o usuário precisa mandar outro.
  if (!meta.ok || info?.ok !== true || !info.result?.file_path) return { ok: false, reason: "unavailable" };
  if ((info.result.file_size ?? 0) > maxBytes) return { ok: false, reason: "too_big" };

  let file: Response;
  try {
    file = await fetchImpl(`https://api.telegram.org/file/bot${botToken}/${info.result.file_path}`, { signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new Error("Falha de rede ao baixar o arquivo do Telegram");
  }
  if (file.status >= 500 || file.status === 429) throw new Error(`Telegram file respondeu HTTP ${file.status}`);
  if (!file.ok) return { ok: false, reason: "unavailable" };
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length > maxBytes) return { ok: false, reason: "too_big" };
  const format = sniffImage(bytes);
  if (format === null) return { ok: false, reason: "not_image" };
  return { ok: true, bytes, format, contentType: TYPES[format], filename: `imagem.${format === "jpeg" ? "jpg" : format}` };
}

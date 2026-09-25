import { slugify } from "../vault/slug.js";
import type { Task } from "./task.js";

/** ID completo de tarefa: AAAA-MM-DD-<slug>. */
export const TASK_ID_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(-[a-z0-9]+)*$/;

/** Se a referência do usuário é um ID completo (normalizado), devolve-o; senão null. */
export function exactTaskId(ref: string): string | null {
  const r = ref.trim().toLowerCase();
  return r.length <= 71 && TASK_ID_RE.test(r) ? r : null;
}

/**
 * Resolução por trecho entre tarefas PENDENTES (contrato, seção 8): o trecho é normalizado
 * como slug e procurado dentro do ID. Um ID idêntico ao trecho vence sobre os parciais.
 * Lança se o trecho não tiver caracteres aproveitáveis.
 */
export function matchPending(ref: string, pending: readonly Task[]): Task[] {
  const slug = slugify(ref);
  const exact = pending.filter((t) => t.id === slug);
  if (exact.length > 0) return exact;
  return pending.filter((t) => t.id.includes(slug));
}

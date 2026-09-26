import type { Meta } from "../domain/meta.js";
import type { MetaRepository } from "../domain/meta-repository.js";
import type { TaskRepository } from "../domain/task-repository.js";
import type { Task } from "../domain/task.js";
import { parseLocalDate, type LocalDate } from "../time/index.js";
import {
  INVALID_OPTION,
  questionKeyboard,
  questionText,
  UNAVAILABLE_META,
  type ParsedQuestion,
  type PendingTask,
} from "./meta-question.js";
import type { Reply } from "./reply.js";

/**
 * Criação de tarefa com a pergunta da meta (docs/vault-contract.md, seção de tarefas).
 * Nada aqui guarda estado: a pergunta carrega o contexto (ver meta-question.ts).
 */
export interface FlowDeps {
  tasks: TaskRepository;
  metas: MetaRepository;
}

export function metaUnavailableText(meta: Meta): string {
  return `A meta "${meta.title}" não está ativa (${meta.status}).`;
}

/** Só metas ativas entram na lista. */
export async function activeMetas(metas: MetaRepository): Promise<Meta[]> {
  return (await metas.list()).metas.filter((m) => m.status === "ativa");
}

/** A pergunta com a lista ATUAL de metas ativas e um botão por opção. */
export async function askMeta(task: PendingTask, metas: MetaRepository, notice?: string): Promise<Reply> {
  const active = await activeMetas(metas);
  const text = questionText(task, active);
  return { text: notice ? `${notice}\n\n${text}` : text, keyboard: questionKeyboard(task, active) };
}

/** Texto da resposta a uma criação (ou "já existe"). `explicitNone`: o usuário escolheu "nenhuma meta". */
export function createdText(
  task: Task,
  created: boolean,
  opts: { meta: Meta | null; explicitNone: boolean; requestedDue?: LocalDate },
): string {
  const lines = [created ? `Tarefa criada: ${task.title}` : `Tarefa já existe: ${task.title}`, `ID: ${task.id}`];
  if (task.due) lines.push(`Prazo: ${task.due}`);
  if (task.meta) lines.push(`Meta: ${opts.meta && opts.meta.id === task.meta ? opts.meta.title : task.meta}`);
  else if (opts.explicitNone) lines.push("Sem meta específica.");
  if (!created && opts.requestedDue !== undefined && opts.requestedDue !== task.due) {
    lines.push("Obs.: o prazo pedido não foi alterado.");
  }
  if (!created && (opts.meta !== null || opts.explicitNone) && (opts.meta?.id ?? undefined) !== task.meta) {
    lines.push("Obs.: a meta pedida não foi alterada.");
  }
  return lines.join("\n");
}

/** Cria (idempotente) a tarefa já com a decisão de meta tomada. */
export async function createTask(
  input: { title: string; eventEpochSeconds: number; due?: LocalDate; idDate?: LocalDate },
  choice: { meta: Meta | null; explicitNone: boolean },
  { tasks }: FlowDeps,
): Promise<string> {
  const { task, created } = await tasks.create({
    title: input.title,
    eventEpochSeconds: input.eventEpochSeconds,
    ...(input.due !== undefined && { due: input.due }),
    ...(input.idDate !== undefined && { idDate: input.idDate }),
    ...(choice.meta && { meta: choice.meta.id }),
  });
  return createdText(task, created, { ...choice, ...(input.due !== undefined && { requestedDue: input.due }) });
}

export type Confirmation =
  | { kind: "created"; text: string }
  | { kind: "invalid"; text: string }
  /** A meta escolhida não existe mais ou não está ativa: nada foi criado; `retry` é a lista atualizada. */
  | { kind: "unavailable"; text: string; retry: Reply };

/**
 * Aplica a opção `n` da pergunta. A meta vem da lista que o USUÁRIO VIU (na mensagem) e é
 * revalidada agora no Vault: nunca se grava referência para meta inexistente ou inativa.
 * `questionEpoch` (data da mensagem da pergunta) vira o instante `created`; o ID e o prazo vêm do texto.
 */
export async function confirmChoice(
  q: ParsedQuestion,
  n: number,
  questionEpoch: number,
  deps: FlowDeps,
): Promise<Confirmation> {
  if (!Number.isInteger(n) || n < 1 || n > q.options.length) return { kind: "invalid", text: INVALID_OPTION };

  const metaId = q.options[n - 1]!;
  let meta: Meta | null = null;
  if (metaId !== null) {
    meta = await deps.metas.find(metaId);
    if (!meta || meta.status !== "ativa") {
      return { kind: "unavailable", text: UNAVAILABLE_META, retry: await askMeta(q.task, deps.metas, UNAVAILABLE_META) };
    }
  }

  const text = await createTask(
    {
      title: q.task.title,
      eventEpochSeconds: questionEpoch,
      idDate: parseLocalDate(q.task.id.slice(0, 10)),
      ...(q.task.due !== undefined && { due: q.task.due }),
    },
    { meta, explicitNone: meta === null },
    deps,
  );
  return { kind: "created", text };
}

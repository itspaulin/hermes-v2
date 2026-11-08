import { localDateOfInstant, parseLocalDate, type LocalDate } from "../time/index.js";
import { dateStart, normalizeInstant } from "../../shared/notion/props.js";

export * from "../../shared/notion/props.js";

/**
 * Nomes das propriedades dos bancos Tarefas e Metas (contrato com o Notion, docs/notion-contract.md):
 * `Nome` (title), `ID` (text), `Status` (select), `Prazo`, `Criada`, `Feita em` (date) e `Meta` (relation).
 * Linhas criadas à mão no Notion (sem ID, Criada ou Status) são aceitas.
 */
export const PROP = {
  title: "Nome",
  id: "ID",
  status: "Status",
  due: "Prazo",
  created: "Criada",
  doneAt: "Feita em",
  meta: "Meta",
} as const;

/** Data de uma propriedade de data. Com horário, a data civil em America/Sao_Paulo. Lança se inválida. */
export function localDateOf(prop: any): LocalDate | undefined {
  const start = dateStart(prop);
  if (start === undefined) return undefined;
  return start.length <= 10 ? parseLocalDate(start) : localDateOfInstant(normalizeInstant(start));
}

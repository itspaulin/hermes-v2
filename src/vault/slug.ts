export const SLUG_MAX_LENGTH = 60;
export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Slug determinístico: minúsculas, sem acentos (NFD), qualquer sequência fora de
 * [a-z0-9] vira "-", sem "-" nas pontas, máximo 60 caracteres. Vazio é erro.
 */
export function slugify(title: string): string {
  const slug = title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/g, "");
  if (slug === "") throw new Error(`Título sem caracteres aproveitáveis para slug: ${JSON.stringify(title)}`);
  return slug;
}

export function isSlug(s: string): boolean {
  return s.length <= SLUG_MAX_LENGTH && SLUG_RE.test(s);
}

/** Slug determinístico (minúsculas, sem acento, só [a-z0-9] e "-", até 60 caracteres; `#` vira "sharp" e `+` vira "plus"). Lança se o texto não tiver letras ou números. */
export function slugify(title: string): string {
  const slug = title
    // Símbolos que distinguem assuntos ("C#", "C++" e "C" não podem virar o mesmo tema).
    .replace(/#/g, " sharp ")
    .replace(/\+/g, " plus ")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  if (slug === "") throw new Error(`Texto sem letras ou números aproveitáveis: ${JSON.stringify(title)}`);
  return slug;
}

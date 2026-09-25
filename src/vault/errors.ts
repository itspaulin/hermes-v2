/** Erros tipados do Vault. Só VaultUnavailable deve virar 500 no webhook (o Telegram reenvia). */
export class VaultPathViolation extends Error {
  constructor(path: string, reason: string) {
    // JSON.stringify: torna visíveis caracteres de controle e evita injeção em logs.
    super(`Caminho fora do contrato do Vault (${reason}): ${JSON.stringify(path)}`);
    this.name = "VaultPathViolation";
  }
}

/** Conflito de sha persistente (esgotadas as tentativas). */
export class VaultConflict extends Error {
  constructor(path: string) {
    super(`Conflito ao escrever ${path}: a nota mudou durante a operação`);
    this.name = "VaultConflict";
  }
}

/** Nota com frontmatter inválido, schema desconhecido ou datas inválidas. */
export class VaultInvalidNote extends Error {
  constructor(path: string, reason: string) {
    super(`Nota inválida ${path}: ${reason}`);
    this.name = "VaultInvalidNote";
  }
}

/** Falha transitória (5xx, rate limit, rede). Seguro reenviar: operações são idempotentes. */
export class VaultUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultUnavailable";
  }
}

/**
 * Resposta inesperada e NÃO transitória da API do Vault (token inválido, sem permissão,
 * repositório ou branch inexistente, erro de validação). Reenviar não adianta.
 */
export class VaultApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(`Vault API ${status}: ${message}`);
    this.name = "VaultApiError";
  }
}

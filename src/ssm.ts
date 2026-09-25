import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

/** Leitura de parâmetros SecureString. Interface mínima para poder mockar. */
export interface ParameterReader {
  get(name: string): Promise<string>;
}

export function createSsmReader(client: SSMClient = new SSMClient({})): ParameterReader {
  return {
    async get(name) {
      let res;
      try {
        res = await client.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
      } catch (err) {
        // O SDK costuma devolver message "UnknownError"; o `name` (ex.: ParameterNotFound,
        // AccessDeniedException) é a parte útil. Nunca inclui o valor do parâmetro.
        const e = err as { name?: string };
        throw new Error(`Falha ao ler o parâmetro SSM ${name}: ${e.name ?? "erro desconhecido"}`);
      }
      const value = res.Parameter?.Value;
      if (!value) throw new Error(`Parâmetro SSM vazio ou ausente: ${name}`);
      return value;
    },
  };
}

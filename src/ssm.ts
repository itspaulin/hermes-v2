import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

/** Leitura de parâmetros SecureString. Interface mínima para poder mockar. */
export interface ParameterReader {
  get(name: string): Promise<string>;
}

export function createSsmReader(client: SSMClient = new SSMClient({})): ParameterReader {
  return {
    async get(name) {
      // Erros do SDK citam o nome do parâmetro, nunca o valor.
      const res = await client.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
      const value = res.Parameter?.Value;
      if (!value) throw new Error(`Parâmetro SSM vazio ou ausente: ${name}`);
      return value;
    },
  };
}

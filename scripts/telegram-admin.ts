/**
 * Administração do bot: webhook e descoberta de chat_id. Lê o token e o secret DIRETO do SSM
 * dentro deste processo: nada de token em argumento de linha de comando, variável de ambiente
 * ou saída. Só imprime URL, contagem de pendentes e último erro.
 *
 *   set-webhook <URL>   registra o webhook e confere com getWebhookInfo
 *   info                mostra getWebhookInfo
 *   delete-webhook      remove o webhook (rollback), sem descartar pendentes
 *   chat-ids            lista chat_id de quem escreveu ao bot (ANTES do webhook)
 *
 * Variáveis opcionais: SSM_PREFIX (padrão /hermes/prod/telegram), VAULT_GITHUB_TOKEN_PARAM
 * (padrão /hermes/prod/vault/github-token).
 */
import { createSsmReader } from "../src/ssm.js";
import { deleteWebhook, findChatIds, formatWebhookInfo, getWebhookInfo, setWebhook } from "./telegram-admin-lib.js";

const prefix = (process.env.SSM_PREFIX ?? "/hermes/prod/telegram").replace(/\/$/, "");
const vaultTokenParam = process.env.VAULT_GITHUB_TOKEN_PARAM ?? "/hermes/prod/vault/github-token";
const ssm = createSsmReader();
const [command, arg] = process.argv.slice(2);

async function main(): Promise<void> {
  switch (command) {
    case "set-webhook": {
      if (!arg) throw new Error("Uso: set-webhook <URL https do API Gateway, terminando em /telegram/webhook>");
      const [token, secret] = await Promise.all([ssm.get(`${prefix}/bot-token`), ssm.get(`${prefix}/webhook-secret`)]);
      // Sem estes a Lambda falharia em todo update; o valor nunca é impresso.
      for (const name of [`${prefix}/allowed-chat-ids`, vaultTokenParam]) {
        await ssm.get(name).catch(() => {
          throw new Error(`Parâmetro SSM ausente ou vazio: ${name}. Crie-o antes de ativar o webhook.`);
        });
      }
      const info = await setWebhook({ token, secret, url: arg });
      console.log("Webhook configurado.");
      for (const l of formatWebhookInfo(info, Date.now())) console.log(l);
      return;
    }
    case "info": {
      const info = await getWebhookInfo(await ssm.get(`${prefix}/bot-token`));
      for (const l of formatWebhookInfo(info, Date.now())) console.log(l);
      return;
    }
    case "delete-webhook": {
      await deleteWebhook(await ssm.get(`${prefix}/bot-token`));
      console.log("Webhook removido (atualizações pendentes preservadas).");
      return;
    }
    case "chat-ids": {
      const chats = await findChatIds(await ssm.get(`${prefix}/bot-token`));
      if (chats.length === 0) {
        console.log("Nenhuma mensagem pendente. Mande /start ao bot no Telegram e rode de novo.");
        return;
      }
      for (const c of chats) console.log(`chat_id=${c.id}  tipo=${c.type}  nome=${c.name}`);
      return;
    }
    default:
      throw new Error("Uso: telegram-admin <set-webhook URL | info | delete-webhook | chat-ids>");
  }
}

main().catch((err: unknown) => {
  console.error(`Erro: ${(err as Error).message}`);
  process.exit(1);
});

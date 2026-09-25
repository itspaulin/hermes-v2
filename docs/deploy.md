# Primeiro deploy

Região: `sa-east-1`. Nenhum valor secreto passa por este repositório, por argumentos de linha de comando dos scripts do Hermes, pelo chat ou por logs.

## Parâmetros SSM necessários (SecureString)

```
/hermes/prod/telegram/bot-token
/hermes/prod/telegram/webhook-secret
/hermes/prod/telegram/allowed-chat-ids      # ex.: 123456789 (vários: separados por vírgula)
/hermes/prod/vault/github-token             # já existe
```

## Passo a passo

### 1. Criar o bot e guardar o token

No Telegram, converse com o `@BotFather`, use `/newbot` e guarde o token que ele devolve.

```bash
read -rs T        # cola o token e Enter (nada aparece na tela)
aws ssm put-parameter --name /hermes/prod/telegram/bot-token --type SecureString --value "$T"
unset T
```

### 2. Descobrir o seu `chat_id` (antes de ativar o webhook)

Mande `/start` para o bot no Telegram. Depois:

```bash
./scripts/telegram-chat-ids.sh
```

Ele lê as atualizações pendentes com `getUpdates` (sem consumi-las) e imprime `chat_id=... tipo=... nome=...`. Só funciona **enquanto não há webhook ativo** (o Telegram recusa `getUpdates` com webhook). Se já houver um: `./scripts/set-webhook.sh --delete` (não descarta as pendentes).

```bash
read -r C         # cola só o número
aws ssm put-parameter --name /hermes/prod/telegram/allowed-chat-ids --type SecureString --value "$C"
unset C
```

### 3. Gerar o secret do webhook

```bash
S=$(openssl rand -hex 32)
aws ssm put-parameter --name /hermes/prod/telegram/webhook-secret --type SecureString --value "$S"
unset S
```

O valor nunca é impresso. Só o Telegram e a Lambda precisam conhecê-lo.

### 4. Build e deploy

```bash
npm test && npm run build
sam deploy --guided
```

Respostas na primeira vez: stack `hermes-v2`, região `sa-east-1`, parâmetros nos padrões (`SsmPrefix`, `VaultRepo`, `VaultBranch`, `VaultTokenParam`), *confirm changes before deploy* sim, *allow IAM role creation* sim, *save arguments to samconfig.toml* sim. O aviso "function has no authentication" é esperado: o endpoint é público e a autenticação é o `secret_token` que a Lambda valida (401 sem ele).

Nas vezes seguintes: `npm run build && sam deploy`.

### 5. Pegar a URL do webhook

```bash
aws cloudformation describe-stacks --stack-name hermes-v2 --region sa-east-1 \
  --query "Stacks[0].Outputs[?OutputKey=='WebhookUrl'].OutputValue" --output text
```

### 6. Registrar o webhook

```bash
./scripts/set-webhook.sh "https://<api-id>.execute-api.sa-east-1.amazonaws.com/telegram/webhook"
```

O script (`scripts/telegram-admin.ts`) lê o token e o secret **direto do SSM dentro do próprio processo**: não há token em argumento, variável de ambiente nem saída. Antes de registrar ele confere que `allowed-chat-ids` e o token do Vault existem no SSM (sem imprimir os valores). Registra `url`, `secret_token` e `allowed_updates: ["message"]`, **sem** `drop_pending_updates`, e confirma com `getWebhookInfo`:

```
Webhook configurado.
URL: https://.../telegram/webhook
Pending updates: 0
Last error: nenhum
Allowed updates: message
```

Estado a qualquer momento: `./scripts/set-webhook.sh --info`.

### 7. Testar, na ordem

```
/ping                                  -> pong <hora de São Paulo>
/tarefa testar o primeiro deploy       -> Tarefa criada + ID
/feita primeiro deploy                 -> Feita
/tarefa testar cancelamento            -> Tarefa criada
/cancelar cancelamento                 -> Cancelada
```

Conferir no repositório do Vault (`Hermes/tarefas/`): um commit por operação. Remova as tarefas de teste depois, manualmente (o Hermes nunca apaga).

## Logs

```bash
sam logs --stack-name hermes-v2 --region sa-east-1 --tail
```

Retenção de 30 dias (`HermesLogGroup`). Linhas úteis: `[vault] ...`, `[telegram] ...`, `[hermes] erro inesperado`.

## Problemas comuns

| Sintoma | Causa provável |
|---|---|
| Log `Dynamic require of "process" is not supported` e `500` em tudo | Bundle ESM sem o `Banner` do `createRequire` no `template.yaml`. O `npm run build` agora roda `scripts/check-bundle.mjs`, que importa o bundle como arquivo `.mjs` (com `node -e` o erro some, porque o `require` global mascara o problema). |
| `Last error: Wrong response ... 401` | `webhook-secret` no SSM difere do usado no `setWebhook`. Rode o `set-webhook.sh` de novo (a Lambda pode ter o valor antigo em cache: um novo deploy ou esperar o cold start renova). |
| `... 500` e log `Falha ao ler o parâmetro SSM <nome>: ParameterNotFound` | Parâmetro ausente ou com nome diferente do `SsmPrefix`/`VaultTokenParam`. |
| `... AccessDeniedException` | A IAM da Lambda só lê os 4 parâmetros do template. Confira o nome exato. |
| Bot responde "erro de configuração ou permissão" | PAT do Vault inválido, expirado, sem *Contents: read and write* ou sem acesso ao repositório. Veja `[vault] Vault API 401/403/404` nos logs. |
| Bot não responde e `Pending updates` cresce | Lambda com erro (ver logs) ou URL errada. O Telegram reenvia até dar certo. |
| Bot não responde e não há erro | O `chat_id` não está em `allowed-chat-ids` (o Hermes ignora em silêncio). |

## Rollback

```bash
./scripts/set-webhook.sh --delete      # desliga o webhook, preserva as pendentes
sam delete --stack-name hermes-v2 --region sa-east-1
```

Os parâmetros SSM e o Vault não são afetados.

## Rotação de segredos

- **Secret do webhook:** gerar outro valor (passo 3, `--overwrite`), rodar `set-webhook.sh` e fazer um novo deploy (ou aguardar o cold start) para a Lambda ler o valor novo.
- **Token do bot:** `/revoke` no BotFather, atualizar o parâmetro e refazer `set-webhook.sh`.
- **PAT do Vault:** gerar outro no GitHub, atualizar o parâmetro `/hermes/prod/vault/github-token`.

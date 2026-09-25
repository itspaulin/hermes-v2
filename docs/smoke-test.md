# Smoke test real do Vault

Objetivo: descobrir se as suposições do `GitHubVaultStore` sobre o protocolo real do GitHub estão corretas. Roda isolado: **não** usa handler, Telegram nem `TaskRepository`.

## Pré-requisitos

1. Repositório privado do Vault e o branch que o Obsidian usa.
2. PAT fine-grained com acesso **somente a esse repositório**, permissão *Contents: read and write*.
3. Credenciais AWS locais (para ler o SSM) e o valor do PAT guardado no SSM, sem passar pelo histórico do shell nem por este chat:

```bash
read -rs T        # cola o token e Enter (não aparece na tela)
aws ssm put-parameter --name /hermes/prod/vault/github-token --type SecureString --value "$T"
unset T
```

Parâmetros separados por serviço:

```
/hermes/prod/telegram/bot-token
/hermes/prod/telegram/webhook-secret
/hermes/prod/telegram/allowed-chat-ids
/hermes/prod/vault/github-token
```

## Executar

```bash
VAULT_REPO=owner/repo VAULT_BRANCH=main \
VAULT_GITHUB_TOKEN_PARAM=/hermes/prod/vault/github-token \
npm run smoke:vault
```

Opcional, caracteriza `update` de arquivo inexistente (deixa um segundo arquivo `smoke-missing` para remover):

```bash
npm run smoke:vault -- --check-update-missing
```

O script imprime cada requisição (método, caminho e status; nunca headers, corpo ou token) e o resultado de cada passo.

## O que valida

| Passo | Suposição sobre o GitHub real |
|---|---|
| `read` de arquivo inexistente → `null` | 404 de arquivo, mais a checagem única do branch (`GET /branches/<branch>` → 200) |
| `list` de diretório inexistente → `[]` | 404 de diretório |
| `create` → `created` | PUT sem `sha` cria (201) e cria diretórios intermediários |
| `create` repetido → `exists` | 422 com "sha" na mensagem |
| `read` → conteúdo e sha | base64 com quebras, UTF-8 (unicode, emoji), sha = blob sha do git |
| `update` com sha correto → `ok` | PUT com `sha` (200) |
| `update` com sha antigo → `conflict` | 409 |
| `list` inclui o arquivo | resposta em array, `type: file` |
| (opcional) `update` de inexistente → `ok`, arquivo criado | O GitHub ignora o sha e cria (201) |

## Resultado da primeira execução real (itspaulin/obsidian-vault)

Os 10 passos principais passaram: 404 de arquivo é `null` (com a checagem única do branch: `GET /branches/main` → 200), 404 de diretório é `[]`, `PUT` sem sha cria (201), repetido dá 422 (`exists`), sha lido é o blob sha do git, `PUT` com sha correto é 200, com sha velho é 409 (`conflict`) e a listagem inclui o arquivo.

**Suposição errada, corrigida:** `PUT` com sha em arquivo inexistente **cria o arquivo (201)**, não dá conflito. O store agora devolve `ok` e registra aviso; ver a limitação conhecida em `docs/vault-contract.md`, seção 7.

## Depois

1. Conferir os 2 commits no GitHub (`hermes: create ...` e `hermes: update ...`) e o conteúdo do arquivo no repositório.
2. **Remover os arquivos de teste manualmente** (`Hermes/tarefas/2000-01-01-smoke-*`). O Hermes nunca apaga arquivos.
3. Se algum passo falhar, anotar o status real que apareceu no log: é a informação que ajusta o mapeamento de erros do store.

## Integração real do TaskRepository

`npm run test:integration` (mesmas variáveis `VAULT_*`) roda `test/integration/tasks-github.itest.ts`: TaskRepository sobre o GitHub real, sem Telegram nem Lambda. Fora do `npm test`.

Cenários: criar (conteúdo exato no GitHub, 1 commit), encontrar, concluir (só status, `done_at` e `updated` mudam), repetir conclusão e cancelamento (no-op, nenhum commit novo), repetir criação (mesma tarefa, sem segundo arquivo), edição manual do corpo direto no GitHub sobrevivendo ao `complete`, conflito real 409 com edição externa de corpo e frontmatter (relê, reaplica, mantém tudo), `listPending` e a guarda de caminhos contra o repositório real.

Isolamento: os arquivos usam o ID `2020-01-01-it-<runid>-...`. No fim, só os caminhos criados pela própria execução (e que casam com esse padrão) são removidos direto pela API, fora do domínio. Se a limpeza falhar, os caminhos restantes são impressos.

A data fixa é 2020-01-01 de propósito: em 2000-01-01 o Brasil estava em horário de verão (`-02:00`), o que a conversão por IANA acerta, mas complicaria as expectativas do teste.

## Integração real ponta a ponta (handler)

`test/integration/telegram-tasks.itest.ts` roda também pelo `npm run test:integration`: update do Telegram, handler, router, `TaskRepository`, `GitHubVaultStore` e GitHub real, verificando o resultado **lendo o Vault direto pela API** (`test/integration/github-raw.ts`). Cobre: `/tarefa` com prazo (conteúdo exato e 1 commit), reenvio sem duplicar, `/feita` preservando edição manual do corpo, `/cancelar` e no-op por ID, trecho ambíguo sem alteração, `message.date` às 23:59 processada às 00:01 do dia seguinte, chat não autorizado e credencial inválida (GitHub real responde 401: resposta genérica 200, sem vazar o token).

Não cobre: Lambda, API Gateway e Telegram reais (o cold start com SSM e o `setWebhook` só se provam no primeiro deploy).

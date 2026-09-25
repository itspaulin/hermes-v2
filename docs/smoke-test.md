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

Opcional, verifica também `update` de arquivo inexistente (suposição não coberta pelo fake):

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
| (opcional) `update` de inexistente → `conflict` | 404 ou 422 com "sha" |

## Depois

1. Conferir os 2 commits no GitHub (`hermes: create ...` e `hermes: update ...`) e o conteúdo do arquivo no repositório.
2. **Remover o arquivo de teste manualmente** (`Hermes/tarefas/2000-01-01-smoke-test-<hex>.md`). O Hermes nunca apaga arquivos.
3. Se algum passo falhar, anotar o status real que apareceu no log: é a informação que ajusta o mapeamento de erros do store.

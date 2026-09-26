# Hermes v2

Bot de metas, tarefas, check-ins e acompanhamento. Telegram é a interface, o Obsidian Vault (via GitHub) é a fonte de verdade, AWS executa.

Status: no ar na AWS. Telegram (`/start`, `/ping`), tarefas (`/tarefa`, `/feita`, `/cancelar`), listagens (`/hoje`, `/semana`) e metas (`/meta`, `/metas`, `/metafeita`, `/metacancelar`), gravadas no Vault via GitHub. Check-ins e Scheduler ainda não existem.

## Arquitetura

```
Telegram -> API Gateway (HTTP API) -> Lambda -> GitHub API -> Vault (Hermes/)
EventBridge Scheduler (America/Sao_Paulo) -> Lambda   (futuro)
```

Decisões: sem banco, sem VPC, sem logging próprio (stdout -> CloudWatch), segredos no SSM Parameter Store (futuro), uma Lambda.

## Estrutura

```
src/
  handler.ts     entrypoint da Lambda (webhook do Telegram)
  telegram/      client (mockável), router (puro), webhook (secret, allowlist), config
  config.ts      horários de check-in/métricas/revisão (editar aqui)
  time/          ÚNICO módulo que sabe "agora", "hoje", "amanhã", semana e tempo de evento
  vault/         VaultStore, InMemoryVaultStore, guarda de caminhos, frontmatter cirúrgico, slug
  domain/        tarefas (TaskRepository) sobre VaultStore; não conhece Telegram nem GitHub
test/
template.yaml    SAM: 1 Lambda + HTTP API
docs/
```

## Regras de tempo

- Timezone oficial: `America/Sao_Paulo`, fixo no código (nunca `process.env.TZ`).
- Só `src/time/` acessa relógio/datas. Um teste (`time-boundary`) falha se outro módulo usar `Date` ou `luxon`.
- `Clock` injetável: produção usa `systemClock`, testes usam `fakeClock("...Z")`.
- Instante = ISO 8601 com offset. Dia inteiro = `LocalDate` `YYYY-MM-DD`.
- Semana: segunda a domingo. Operação segunda a sábado; domingo é descanso.
- O Vault guarda eventos; nunca define "hoje".

## Telegram

Config vem do SSM Parameter Store (SecureString), lida em runtime no cold start (3 `GetParameter` em paralelo) e cacheada em memória só como otimização. A Lambda recebe apenas os **nomes** dos parâmetros (`TELEGRAM_*_PARAM`); a IAM permite só `ssm:GetParameter` nesses três:

```
/hermes/prod/telegram/bot-token
/hermes/prod/telegram/webhook-secret
/hermes/prod/telegram/allowed-chat-ids     # separados por vírgula
```

O prefixo é o parâmetro `SsmPrefix` do `template.yaml`. Nenhum valor vai no código nem no template.

Respostas do webhook: 401 secret errado, 400 payload inválido, 200 ignorado/respondido, 500 falha transitória do Telegram (para ele reenviar). Chat fora da allowlist é ignorado em silêncio.

## Comandos

```
/tarefa <título>
/tarefa <título> até AAAA-MM-DD      # só AAAA-MM-DD; datas relativas ("amanhã") são recusadas
/tarefa <título> [até AAAA-MM-DD] #<id-da-meta>   # vincula à meta; "#meta" só vale como última palavra
/feita <id-ou-trecho>
/cancelar <id-ou-trecho>
/hoje                                # atrasadas, para hoje, sem prazo
/semana                              # atrasadas e um bloco por dia (segunda a domingo)
/meta <título> [até AAAA-MM-DD]
/metas                               # metas ativas com a contagem de tarefas pendentes
/metafeita <id-ou-trecho>
/metacancelar <id-ou-trecho>
/start   /ping
```

- O ID da meta é o slug do título (sem data): o mesmo título é a mesma meta. Uma tarefa com `#meta` grava `meta:` no frontmatter e um wikilink `[[meta]]` no corpo; a meta precisa existir, senão a tarefa não é criada.

- O ID da tarefa é `AAAA-MM-DD-<slug do título>`, com a data do **evento** (`message.date` do Telegram), não a do processamento. Mesmo título no mesmo dia é a mesma tarefa: reenviar não duplica.
- `/feita` e `/cancelar` aceitam o ID completo ou um trecho (normalizado como slug), resolvido **só entre tarefas pendentes**. Um ID completo também acha tarefa já feita (resposta "Já estava feita", sem commit). Zero ou várias correspondências: "Tarefa não encontrada." ou a lista de candidatos, sem alterar nada.
- Erros: pedido inválido, tarefa inexistente, nota inválida, conflito não recuperável e erro de credencial/permissão do Vault respondem 200 com mensagem (reenviar não adianta). Vault/GitHub indisponível (5xx, 429, rate limit, rede, timeout de 10 s) e erro inesperado respondem 500 para o Telegram reenviar; tudo é idempotente.

## Vault

O Hermes só escreve em `Hermes/{metas,tarefas,checkins,revisoes}` (hoje `tarefas` e `metas`). O resto do Vault está fora do escopo. Um commit por operação via GitHub Contents API, direto no branch configurado (`VAULT_REPO`, `VAULT_BRANCH`; o PAT fica no SSM em `VAULT_GITHUB_TOKEN_PARAM`). Contrato completo em `docs/vault-contract.md`.

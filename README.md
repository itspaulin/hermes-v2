# Hermes v2

Bot de metas, tarefas, check-ins e acompanhamento. Telegram é a interface, o Obsidian Vault (via GitHub) é a fonte de verdade, AWS executa.

Status: fundação + Telegram básico (`/start`, `/ping`). Sem Vault, sem Scheduler, sem domínio (metas/tarefas) ainda.

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

## Vault (futuro)

O Hermes só escreve em `Hermes/{metas,tarefas,checkins,revisoes}`. O resto do Vault está fora do escopo. Um commit por operação via GitHub Contents/Data API. Idempotência por IDs determinísticos, sem dedupe em memória.

## Comandos

```
npm run smoke:vault   # smoke test REAL do Vault, ver docs/smoke-test.md
npm run typecheck
npm test          # roda com TZ=UTC e TZ=Asia/Tokyo
npm run build     # sam build
```

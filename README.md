# Hermes v2

Bot de metas, tarefas, check-ins e acompanhamento. Telegram é a interface, o Obsidian Vault (via GitHub) é a fonte de verdade, AWS executa.

Status: **apenas fundação** (tempo, config, handler mínimo, SAM). Sem Telegram, sem Vault, sem Scheduler ainda.

## Arquitetura

```
Telegram -> API Gateway (HTTP API) -> Lambda -> GitHub API -> Vault (Hermes/)
EventBridge Scheduler (America/Sao_Paulo) -> Lambda   (futuro)
```

Decisões: sem banco, sem VPC, sem logging próprio (stdout -> CloudWatch), segredos no SSM Parameter Store (futuro), uma Lambda.

## Estrutura

```
src/
  handler.ts     entrypoint da Lambda (mínimo)
  config.ts      horários de check-in/métricas/revisão (editar aqui)
  time/          ÚNICO módulo que sabe "agora", "hoje", "amanhã", semana
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

## Vault (futuro)

O Hermes só escreve em `Hermes/{metas,tarefas,checkins,revisoes}`. O resto do Vault está fora do escopo. Um commit por operação via GitHub Contents/Data API. Idempotência por IDs determinísticos, sem dedupe em memória.

## Comandos

```
npm run typecheck
npm test          # roda com TZ=UTC e TZ=Asia/Tokyo
npm run build     # sam build
```

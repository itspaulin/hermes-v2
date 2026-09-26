# Hermes v2

Bot de metas, tarefas, check-ins e acompanhamento. Telegram é a interface, o Obsidian Vault (via GitHub) é a fonte de verdade, AWS executa.

Status: no ar na AWS. Telegram (`/start`, `/ping`), tarefas (`/tarefa`, `/feita`, `/cancelar`), listagens (`/hoje`, `/semana`) e metas (`/meta`, `/metas`, `/metafeita`, `/metacancelar`), gravadas no Vault via GitHub. Check-ins agendados (EventBridge Scheduler) e revisão semanal, com `/checkin`, `/metrica` e `/revisao`.

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
/tarefa <título> [até AAAA-MM-DD] #<id-da-meta>   # cria já vinculada, sem perguntar; "#meta" só vale como última palavra
/feita <id-ou-trecho>
/cancelar <id-ou-trecho>
/hoje                                # atrasadas, para hoje, sem prazo
/semana                              # atrasadas e um bloco por dia (segunda a domingo)
/meta <título> [até AAAA-MM-DD]
/metas                               # metas ativas com a contagem de tarefas pendentes
/metafeita <id-ou-trecho>
/metacancelar <id-ou-trecho>
/checkin <texto>                     # responde ao check-in diário mais recente sem resposta
/metrica <texto>                     # responde às métricas da quinta
/revisao <texto>                     # responde à revisão semanal
/start   /ping
```

## Agenda (EventBridge Scheduler)

Definida em `src/config.ts`; `template.yaml` tem um schedule por entrada (fuso `America/Sao_Paulo`) e `test/template.test.ts` garante que os dois batem. Cada schedule invoca a mesma Lambda com `{"kind": ...}`, que cria a nota do slot no Vault (criar-se-não-existir) e avisa no Telegram.

| Quando | O quê | Nota |
|---|---|---|
| seg, ter, qua, sex 14h | check-in: contagens (hoje, atrasadas, próximas 7 dias) e a pergunta | `checkins/AAAA/AAAA-MM-DD-checkin.md` |
| qui 14h | métricas calculadas da semana (criadas, concluídas, canceladas, pendentes, atrasadas, por dia, por meta), andamento e comparação com a semana anterior | `checkins/AAAA/AAAA-MM-DD-metrics.md` |
| sáb 18h | revisão: avaliação da semana (produtiva, razoável ou abaixo do planejado), comparação, resumo, check-ins e métricas manuais | `revisoes/AAAA-Wxx.md` |
| dom | nada automático | |

**A avaliação da semana é do Hermes, calculada por regra (sem IA), e você não precisa digitar nada.** Taxa = tarefas com prazo na semana (menos as canceladas) que foram concluídas; `produtiva` a partir de 80%, `razoável` a partir de 50%, senão `abaixo do planejado` (limites em `PRODUCTIVITY`, `src/config.ts`). Sem nenhuma tarefa com prazo na semana não há taxa, e o Hermes só conta o que foi concluído. A revisão e as métricas também comparam as concluídas com as da semana anterior. `/checkin`, `/metrica` e `/revisao` são **opcionais**: guardam uma nota sua no campo `answer` do frontmatter (o corpo é seu). Falha no Vault ou no Telegram repete até 2 vezes; como criar é idempotente, a repetição só reenvia a mensagem. Slot já respondido não é reenviado. Teste manual fora do calendário: invocar a Lambda com `{"kind":"checkin","force":true}`.

- O ID da meta é o slug do título (sem data): o mesmo título é a mesma meta. Uma tarefa com meta grava `meta: <id da meta>` no frontmatter e um wikilink `[[meta]]` no corpo.
- **`/tarefa` sem `#meta` pergunta a meta** (se houver metas ativas): o Hermes responde com a lista numerada e um botão por opção, e a tarefa só é criada na resposta. Responda tocando no botão, ou respondendo (reply do Telegram) à pergunta com o número, `não` ou `nenhuma`. Uma mensagem solta `1` não tem contexto e é ignorada. Sem estado guardado: a pergunta carrega tudo (título, prazo, ID da tarefa e das metas), e a meta é revalidada (existe e está ativa) na hora de gravar. Perguntas valem por 24 h. Duas `/tarefa` seguidas geram duas perguntas independentes; nenhuma sobrescreve a outra.
- O webhook precisa receber `callback_query`: depois de mudar isso, registre de novo com `./scripts/set-webhook.sh <URL>`.
- `/hoje` e `/semana` mostram `Meta: <título>` sob cada tarefa que tem meta.

- O ID da tarefa é `AAAA-MM-DD-<slug do título>`, com a data do **evento** (`message.date` do Telegram), não a do processamento. Mesmo título no mesmo dia é a mesma tarefa: reenviar não duplica.
- `/feita` e `/cancelar` aceitam o ID completo ou um trecho (normalizado como slug), resolvido **só entre tarefas pendentes**. Um ID completo também acha tarefa já feita (resposta "Já estava feita", sem commit). Zero ou várias correspondências: "Tarefa não encontrada." ou a lista de candidatos, sem alterar nada.
- Erros: pedido inválido, tarefa inexistente, nota inválida, conflito não recuperável e erro de credencial/permissão do Vault respondem 200 com mensagem (reenviar não adianta). Vault/GitHub indisponível (5xx, 429, rate limit, rede, timeout de 10 s) e erro inesperado respondem 500 para o Telegram reenviar; tudo é idempotente.

## Vault

O Hermes só escreve em `Hermes/{metas,tarefas,checkins,revisoes}` (hoje `tarefas` e `metas`). O resto do Vault está fora do escopo. Um commit por operação via GitHub Contents API, direto no branch configurado (`VAULT_REPO`, `VAULT_BRANCH`; o PAT fica no SSM em `VAULT_GITHUB_TOKEN_PARAM`). Contrato completo em `docs/vault-contract.md`.

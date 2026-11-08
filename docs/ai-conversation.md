# Conversa natural (Amazon Bedrock)

Hermes e Renato conversam em linguagem natural via Amazon Bedrock (Converse API, Claude Haiku 4.5). A camada é **opcional e desligada por padrão**; comandos e fluxos determinísticos não dependem dela.

## Fluxo

**Hermes** (`src/telegram/router.ts`): atualização validada e chat autorizado → comando `/...` → resposta a pergunta pendente (reply a pergunta de meta) → **só então** texto solto vai ao modelo → sem IA ou IA falhou: ajuda/aviso fixo.

**Renato** (`renato/src/lambda.ts`): chat autorizado → captura explícita sem modelo (`/anotar <texto>`, ou texto com marcador de categoria como `ideia: ...` / `#estudo`, o formato que já existia) → outro `/comando`: ajuda → texto comum vai ao modelo, que responde ou pede captura. Captura pedida grava a **mensagem original** pelo caminho de persistência existente; a confirmação "Anotado no Renato. ID: ..." só sai depois da gravação. Falha de gravação = HTTP 500 (Telegram reenvia, a captura é idempotente) e nenhuma confirmação. Com a IA desligada, o Renato mantém o comportamento original (todo texto vira nota).

O modelo devolve JSON (`reply` | `clarify` | `action`). O código valida; ação fora da allowlist ou input inválido = nada executa.

| Assistente | Ações permitidas |
|---|---|
| Hermes | `show_today` (= `/hoje`), `show_week` (= `/semana`), `create_task` (= `/tarefa`, título ≤ 120, `due` AAAA-MM-DD opcional), `create_tasks` (até 10 de uma vez, sem pergunta de meta), `set_task_due` (prazo de tarefas pendentes, só por IDs que existem) |
| Renato (Vault) | `capture_note` (sem argumentos: o conteúdo é sempre a mensagem do usuário) |
| Renato (Notion) | `save_note`, `append_to_note`, `find_notes`, `move_note`; ver docs/notion-contract.md |

## Contexto que o Hermes recebe

A cada texto solto o Hermes lê as tarefas pendentes do Vault (como o `/hoje`) e passa ao modelo: ID, título, hora de criação e prazo, mais recentes primeiro (até 40). É isso que permite "essa tarefa tem prazo até 8/11" virar `set_task_due` na tarefa certa em vez de uma tarefa nova. O código só aplica `set_task_due` em IDs que estavam na lista de pendentes.

Várias linhas `/tarefa` coladas na mesma mensagem viram uma tarefa por linha (em lote nunca há pergunta de meta; a tarefa nasce sem meta).

## Memória da conversa (Neon)

O Hermes guarda as últimas mensagens da conversa no Postgres do Neon (`src/ai/history.ts`, tabela `hermes_chat_history`, criada sozinha no primeiro uso): a mensagem do usuário e o que ele viu como resposta (o resultado real da ação). Só entram no contexto as últimas 6 mensagens (`AI_MAX_HISTORY_MESSAGES`) dos últimos 120 minutos; o que passa de 24 h é apagado a cada gravação. Comandos `/...` não passam pelo modelo e não entram no histórico.

- **Opcional e à prova de falha**: sem o parâmetro SSM, ou com o Neon fora do ar / lento (timeout de 3 s por consulta), o Hermes conversa normalmente, só sem histórico. Logs trazem só o nome do erro, nunca mensagens.
- **Segredo**: a connection string fica no SSM como SecureString (padrão `/hermes/prod/neon/database-url`, parâmetro `NeonDatabaseUrlParam`), lida só no cold start, nunca pelo chat. Criar uma vez:

```
aws ssm put-parameter --region sa-east-1 --name /hermes/prod/neon/database-url --type SecureString --value '<connection string do Neon>'
```

- **Dados**: o conteúdo das conversas fica no Neon. O Renato não usa histórico.

## Código

- `shared/ai/`: `config.ts` (env), `decision.ts` (parser/allowlist), `service.ts` (limites, timeout, erros, logs sem conteúdo), `bedrock.ts` (único arquivo que fala com o Bedrock, por `fetch` com API key; injetável nos testes).
- `src/ai/hermes.ts`, `renato/src/conversation.ts`: prompts e ações de cada assistente. Nada é compartilhado entre os dois além do serviço.

## Modelo, região e credencial

Modelo: `us.anthropic.claude-haiku-4-5-20251001-v1:0`, o mesmo dos projetos `prospeccao` e `financas`. `sa-east-1` (região da stack) não tem esse modelo; o profile `us.` existe em `us-east-1`, então `BEDROCK_REGION=us-east-1` e as mensagens de conversa trafegam para regiões dos EUA.

A chamada usa uma **API key do Bedrock** (bearer token) na Converse API, sem SDK e sem permissão IAM de Bedrock na role da Lambda. A key fica no SSM como SecureString (padrão `/hermes/prod/bedrock/api-key`), lida só no cold start, e as duas Lambdas podem lê-la. Criar uma vez (a key vem do console do Bedrock, menu API keys, na conta onde o Haiku 4.5 está liberado):

```
aws ssm put-parameter --region sa-east-1 --name /hermes/prod/bedrock/api-key --type SecureString --value '<key>'
```

Sem a key (parâmetro ausente ou vazio) a IA fica desligada e o bot segue com os comandos, com log `[ai] sem API key do Bedrock`.

## Variáveis de ambiente (parâmetros do `template.yaml`)

| Variável | Parâmetro SAM | Padrão |
|---|---|---|
| `AI_ENABLED` | `AiEnabled` | `false` |
| `BEDROCK_MODEL_ID` | `BedrockModelId` | `us.anthropic.claude-haiku-4-5-20251001-v1:0` |
| `BEDROCK_API_KEY_PARAM` | `BedrockApiKeyParam` | `/hermes/prod/bedrock/api-key` |
| `BEDROCK_REGION` | `BedrockRegion` | `us-east-1` (sem ela, usa `AWS_REGION`) |
| `AI_MAX_HISTORY_MESSAGES` | `AiMaxHistoryMessages` | 6 (máx. 20) |
| `AI_MAX_INPUT_CHARS` | `AiMaxInputChars` | 1000 (máx. 4000) |
| `AI_MAX_OUTPUT_TOKENS` | `AiMaxOutputTokens` | 400 (máx. 1000) |
| `AI_TIMEOUT_MS` | (não exposta) | 8000 |

`AI_ENABLED=true` sem modelo, parâmetro da key ou região deixa a IA desligada (log de erro, bot segue). Sem retry: o timeout é curto e o usuário pode reenviar. Sem cache nem chamada para comandos.

## IAM (já no `template.yaml`, nas duas funções)

Só `ssm:GetParameter` no parâmetro da key, além dos que já existiam. A key carrega a própria autorização no Bedrock.

## Tom das respostas

Os prompts de sistema (`src/ai/hermes.ts`, `renato/src/conversation.ts`) têm um bloco "Tom": frases curtas, reagir ao que a pessoa disse, sem fórmulas de atendimento, sem listas. É o lugar para afinar a personalidade depois de ver conversas reais.

## Testar localmente

```
npm run typecheck && npm test            # Hermes + shared (UTC e Tokyo)
npm --prefix renato run typecheck && npm --prefix renato test
```
Nenhum teste chama Bedrock, Telegram, GitHub ou AWS.

## Deploy manual (nada foi feito automaticamente)

```
npm run build
sam deploy --parameter-overrides AiEnabled=true
```
Para desligar: `AiEnabled=false` (ou omita). Valide com as mensagens "Oi" no Hermes e no Renato (nenhuma nota deve surgir no Vault).

## Limitações da primeira versão

- O Renato não tem histórico entre mensagens (Lambda sem estado). O serviço aceita `history`, mas só o Hermes o preenche (via Neon). Por isso o Renato, em dúvida, pede que o usuário confirme com o comando (`/anotar ...`).
- Hermes não marca tarefa como feita/cancelada por conversa (exige resolução de tarefa ambígua): usar `/feita`, `/cancelar`.
- Renato não consulta o Vault ("O que anotei sobre X?" não é respondido com dados reais; o prompt o proíbe de inventar). Busca fica para uma etapa posterior.
- `/anotar@nome_do_bot texto` (com menção) não é reconhecido.
- Se o envio da resposta ao Telegram falhar, o reenvio do update chama o modelo de novo.
- Custos dependem de modelo, volume e tokens; os limites acima só os restringem.

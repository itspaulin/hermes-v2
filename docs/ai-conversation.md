# Conversa natural (Amazon Bedrock)

Hermes e Renato conversam em linguagem natural via Amazon Bedrock (Converse API, Amazon Nova Lite). A camada é **opcional e desligada por padrão**; comandos e fluxos determinísticos não dependem dela.

## Fluxo

**Hermes** (`src/telegram/router.ts`): atualização validada e chat autorizado → comando `/...` → resposta a pergunta pendente (reply a pergunta de meta) → **só então** texto solto vai ao modelo → sem IA ou IA falhou: ajuda/aviso fixo.

**Renato** (`renato/src/lambda.ts`): chat autorizado → captura explícita sem modelo (`/anotar <texto>`, ou texto com marcador de categoria como `ideia: ...` / `#estudo`, o formato que já existia) → outro `/comando`: ajuda → texto comum vai ao modelo, que responde ou pede captura. Captura pedida grava a **mensagem original** pelo caminho de persistência existente; a confirmação "Anotado no Renato. ID: ..." só sai depois da gravação. Falha de gravação = HTTP 500 (Telegram reenvia, a captura é idempotente) e nenhuma confirmação. Com a IA desligada, o Renato mantém o comportamento original (todo texto vira nota).

O modelo devolve JSON (`reply` | `clarify` | `action`). O código valida; ação fora da allowlist ou input inválido = nada executa.

| Assistente | Ações permitidas |
|---|---|
| Hermes | `show_today` (= `/hoje`), `show_week` (= `/semana`), `create_task` (= `/tarefa`, título ≤ 120, `due` AAAA-MM-DD opcional) |
| Renato | `capture_note` (sem argumentos: o conteúdo é sempre a mensagem do usuário) |

## Código

- `shared/ai/`: `config.ts` (env), `decision.ts` (parser/allowlist), `service.ts` (limites, timeout, erros, logs sem conteúdo), `bedrock.ts` (único arquivo que toca o SDK; injetável nos testes).
- `src/ai/hermes.ts`, `renato/src/conversation.ts`: prompts e ações de cada assistente. Nada é compartilhado entre os dois além do serviço.

## Modelo e região

`sa-east-1` (região da stack) **não tem** Nova Lite nem inference profile dele (verificado com `aws bedrock list-inference-profiles`). Em `us-east-1` existe o profile `us.amazon.nova-lite-v1:0`. Por isso o cliente do Bedrock usa `BEDROCK_REGION=us-east-1` e as mensagens de conversa trafegam para regiões dos EUA. Confirme se isso é aceitável antes de ligar. Habilite o acesso ao modelo no console do Bedrock (Model access) em `us-east-1` na conta.

## Variáveis de ambiente (parâmetros do `template.yaml`)

| Variável | Parâmetro SAM | Padrão |
|---|---|---|
| `AI_ENABLED` | `AiEnabled` | `false` |
| `BEDROCK_MODEL_ID` | `BedrockModelId` | `us.amazon.nova-lite-v1:0` |
| `BEDROCK_REGION` | `BedrockRegion` | `us-east-1` (sem ela, usa `AWS_REGION`) |
| `AI_MAX_HISTORY_MESSAGES` | `AiMaxHistoryMessages` | 6 (máx. 20) |
| `AI_MAX_INPUT_CHARS` | `AiMaxInputChars` | 1000 (máx. 4000) |
| `AI_MAX_OUTPUT_TOKENS` | `AiMaxOutputTokens` | 400 (máx. 1000) |
| `AI_TIMEOUT_MS` | (não exposta) | 8000 |

`AI_ENABLED=true` sem modelo/região deixa a IA desligada (log de erro, bot segue). Retry: no máximo 1, só falhas transitórias do SDK. Sem cache nem chamada para comandos.

## IAM (já no `template.yaml`, nas duas funções)

`bedrock:InvokeModel` em:
- `arn:aws:bedrock:us-east-1:<conta>:inference-profile/us.amazon.nova-lite-v1:0`
- `arn:aws:bedrock:{us-east-1,us-east-2,us-west-2}::foundation-model/amazon.nova-lite-v1:0` (destinos do profile `us.`)

Sem credenciais no código; usa a role da Lambda.

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

- Sem histórico entre mensagens (Lambda sem estado, e não há armazenamento adequado; DynamoDB não justificado ainda). O serviço já aceita `history`, mas nenhum chamador o preenche. Por isso o modelo, em dúvida, pede que o usuário confirme com o comando (`/tarefa ...`, `/anotar ...`).
- Hermes não marca tarefa como feita/cancelada por conversa (exige resolução de tarefa ambígua): usar `/feita`, `/cancelar`.
- Renato não consulta o Vault ("O que anotei sobre X?" não é respondido com dados reais; o prompt o proíbe de inventar). Busca fica para uma etapa posterior.
- `/anotar@nome_do_bot texto` (com menção) não é reconhecido.
- Se o envio da resposta ao Telegram falhar, o reenvio do update chama o modelo de novo.
- Custos dependem de modelo, volume e tokens; os limites acima só os restringem.

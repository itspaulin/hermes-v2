# Renato

Assistente pessoal independente para captura e organização de ideias, estudos, trabalho e contexto de projetos. Renato **captura, classifica, registra e recupera**; metas, tarefas, check-ins, lembretes e progresso pertencem ao Hermes.

Esta pasta é uma base isolada: tem `package.json`, `tsconfig.json` e `vitest.config.ts` próprios e **não importa nada do Hermes**, podendo ser movida para outro repositório.

## Decisões do MVP

- Interface: Telegram. Memória: Markdown em um Obsidian Vault versionado no GitHub.
- Alvo de infraestrutura: AWS Lambda + API Gateway (baixo custo). Fuso: `America/Sao_Paulo`.
- Sem banco, fila ou logging próprio.

## Arquitetura inicial (somente camada de domínio pura)

| Arquivo | Responsabilidade |
| --- | --- |
| `src/types.ts` | `Note`, categorias (`ideia`, `estudo`, `trabalho`, `projeto`, `referencia`), origem da mensagem e `validateNote`. |
| `src/clock.ts` | Único lugar que usa o relógio do sistema. `Clock` injetável (`fixedClock` em testes), `localDate`/`localIso` em `America/Sao_Paulo`. |
| `src/classify.ts` | Classificação determinística por regras explícitas, sem LLM. |
| `src/note.ts` | `captureNote`: monta e valida a `Note`, guardando o texto original intacto. |

### Regras de classificação

- Categoria só é confirmada por prefixo (`ideia: ...`) ou hashtag de categoria (`#estudo`). Acentos e maiúsculas são ignorados (`Referência:`).
- Marcadores conflitantes ou ausentes => `category: null` (sem categoria confirmada).
- Outras `#hashtags` viram tags; `@nome` define o projeto (se houver só um).
- `originalContent` nunca é alterado; `organizedContent` só existe quando difere do original.
- Timestamps (`createdAt`/`updatedAt`) são instantes UTC em ISO 8601, vindos do `Clock`.

## Adaptador de entrada do Telegram

| Arquivo | Responsabilidade |
| --- | --- |
| `src/telegram.ts` | Tipos mínimos (`TelegramUpdate`, `TelegramMessage`) e `parseTelegramUpdate`, que valida `unknown` sem lançar. |
| `src/handler.ts` | `createTelegramHandler({ clock, capture })`: handler puro que devolve `{ statusCode, body }`. |

O handler recebe o payload **já parseado** (o `JSON.parse` é de quem o chama), converte mensagens de texto em um `CaptureNoteCommand` (`{ type: "capture_note", note }`) e o entrega à dependência `capture`. Ele **não** chama a Bot API, não usa token e não persiste nada. O relógio é injetado (`Clock`); o id da nota é determinístico: `telegram-<chat.id>-<message_id>`.

### Respostas

| Situação | Status | Corpo |
| --- | --- | --- |
| Mensagem de texto válida | 200 | `{ "status": "accepted", "noteId": "telegram-777-42" }` |
| Update sem `message` (ex.: `edited_message`, `callback_query`) | 200 | `{ "status": "ignored", "reason": "unsupported_update" }` |
| Mensagem sem texto ou só com espaços | 200 | `{ "status": "ignored", "reason": "no_text" }` |
| Payload inválido (`update_id`/`message_id`/`date`/`chat.id`/`text` com tipo errado) | 400 | `{ "status": "invalid", "errors": [...] }` |
| `capture` ou a montagem da nota falhou | 500 | `{ "status": "error", "reason": "capture_failed" }` |

Ignorados retornam 200 para o Telegram não reenviar; só o 500 sugere nova tentativa. A mensagem do erro da dependência não é exposta.

### Exemplo

```ts
import { createTelegramHandler, systemClock } from "./src/index.js";

const handle = createTelegramHandler({
  clock: systemClock,
  capture: async ({ note }) => { /* persistência virá em outra etapa */ },
});

await handle({
  update_id: 10,
  message: { message_id: 42, date: 1768491000, chat: { id: 777 }, text: "ideia: app de receitas" },
});
// => { statusCode: 200, body: { status: "accepted", noteId: "telegram-777-42" } }
```

### Limites

Só `message` com `text` é tratada: sem comandos `/`, edições, canais, grupos específicos, anexos nem verificação do segredo do webhook (isso fica para o API Gateway/Lambda). Sem webhook público, sem resposta ao usuário, sem Vault.

## Como rodar

```bash
cd renato
npm install
npm run typecheck
npm test   # roda com TZ=UTC e TZ=Asia/Tokyo; sem rede nem credenciais
```

## Próximas etapas

Webhook/Lambda real e resposta ao Telegram, persistência no Vault (Markdown) e, separadamente, integração com o Hermes.

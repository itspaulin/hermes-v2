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

### Formato Markdown da nota

`src/markdown.ts` (`serializeNote`/`parseNote`) usa frontmatter com um metadado por linha (`chave: valor JSON`, YAML válido): `id`, `category` (ou `null`), `tags`, `project` (opcional), `source`, `sourceMessageId` (opcional), `createdAt`, `updatedAt`. Depois vêm `## Conteúdo original` e, só se existir, `## Conteúdo organizado`, cada um em bloco cercado por crases. A cerca é maior que qualquer sequência de crases do texto, então o conteúdo é preservado byte a byte. Metadados desconhecidos, duplicados ou ausentes, JSON inválido e conteúdo extra geram `NoteFormatError`; nada é descartado em silêncio. O formato não protege contra conversão externa de fim de linha (CRLF/LF).

`src/repository.ts` define a interface `NoteRepository` (`create`, `update`, `get`, `list`) e `InMemoryNoteRepository`, que guarda o Markdown serializado e serve para testes. Não há acesso a rede, credenciais ou ao Vault real.

### Persistência no Vault via GitHub (REN-004)

`src/github-repository.ts` implementa `NoteRepository` com `GitHubNoteRepository`, usando a Contents API do GitHub. O cliente HTTP é injetado (`HttpClient`, compatível com o `fetch` global); os testes usam um GitHub falso em memória, sem rede nem Vault real.

Configuração esperada (valores fornecidos pelo chamador; **nenhum valor secreto vive no repositório**):

| Campo | Descrição |
| --- | --- |
| `owner`, `repo` | Repositório do Vault. |
| `branch` | Branch onde as notas são gravadas. |
| `directory` | Pasta das notas (ex.: `Renato/Notas`); `..` e `.` são rejeitados. |
| `token` | Token do GitHub com permissão de escrita em *Contents* só nesse repositório. Injetado pelo chamador (ex.: lido do SSM fora deste módulo); nunca é logado, serializado (`toJSON` o omite) nem incluído em erros. |
| `apiBaseUrl` | Opcional; padrão `https://api.github.com`. |

Comportamento:

- **Nomes de arquivo** (`noteFileName`): ids `[a-z0-9_-]` (até 64) viram `<id>.md`; qualquer outro vira `<slug-ascii>-<sha256[0..12]>.md`. É determinístico, sem separadores/`..`, e ids distintos não colidem (inclusive por maiúsculas/minúsculas).
- **Escrita segura**: `create` não envia `sha`, então a API recusa se o arquivo existir; `update` lê o `sha` atual e o envia, e se o arquivo mudou no meio do caminho a API recusa. Nunca há sobrescrita cega. `update` também recusa alterar `originalContent`.
- **Erros** (todos estendem `NoteRepositoryError`; a nota original permanece com o chamador): `GitHubAuthError` (401/403), `GitHubRateLimitError` (429 ou 403 com limite; traz `retryAfterSeconds` quando conhecido), `GitHubConflictError` (409/422), 404 e 5xx como `GitHubRepositoryError` com `status`. Respostas sem JSON válido, `sha` ou conteúdo base64 (ex.: arquivo >1 MB) são erro, nunca nota vazia. Não há retry automático: o chamador decide.
- Limitação: `list` lê um arquivo por requisição e depende do limite de 1000 entradas por diretório da Contents API.

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

A camada pura só trata `message` com `text`; edições, canais e anexos são ignorados. Verificação do segredo do webhook, allowlist de chats, persistência no Vault e resposta ao usuário ficam na camada Lambda descrita abaixo.

## Lambda/API Gateway e Bot API (REN-005)

`src/lambda.ts` é o entrypoint HTTP do Renato. Ele valida o header `X-Telegram-Bot-Api-Secret-Token` com comparação em tempo constante, valida o método/caminho, limita a captura aos chat IDs configurados e só então encaminha o payload ao handler puro. A nota é persistida pela Contents API do GitHub no Vault; o bot envia confirmação depois da gravação. Reentregas do mesmo `chat.id/message_id` são idempotentes se o conteúdo original for igual.

O template SAM define uma função `RenatoFunction` separada em `POST /renato/webhook`. Renato usa **um bot Telegram próprio**, porque o Telegram permite apenas um webhook por bot; não configure o mesmo bot-token no Hermes e no Renato. A infraestrutura foi descrita em código, mas não foi aplicada/deployada.

Parâmetros SSM SecureString esperados pelo prefixo `RenatoSsmPrefix` (padrão `/renato/prod/telegram`): `bot-token`, `webhook-secret` e `allowed-chat-ids`. O último contém IDs numéricos separados por vírgula. O token do Vault usa o parâmetro já configurado por `VaultTokenParam`; `VaultRepo`, `VaultBranch` e a pasta `Renato/Notas` são configuração não secreta. O template concede à função somente `ssm:GetParameter` para esses parâmetros. A URL final do webhook aparece nas saídas do stack após um deploy autorizado.

A confirmação é enviada após a gravação. Se a API do Telegram falhar depois de persistir, a Lambda retorna 500 para permitir reentrega; o ID determinístico e a verificação da nota existente evitam duplicação da mesma mensagem.

## Como rodar

```bash
cd renato
npm install
npm run typecheck
npm test   # roda com TZ=UTC e TZ=Asia/Tokyo; sem rede nem credenciais
```

## Próximas etapas

Webhook/Lambda real e resposta ao Telegram; integração com o Hermes.

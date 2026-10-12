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

## Como rodar

```bash
cd renato
npm install
npm run typecheck
npm test   # roda com TZ=UTC e TZ=Asia/Tokyo; sem rede nem credenciais
```

## Próximas etapas

Adaptador de Telegram/webhook e, separadamente, integração com o Hermes.

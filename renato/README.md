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

## Como rodar

```bash
cd renato
npm install
npm run typecheck
npm test   # roda com TZ=UTC e TZ=Asia/Tokyo; sem rede nem credenciais
```

## Próximas etapas

Adaptador de Telegram/webhook, persistência no Vault (Markdown) e, separadamente, integração com o Hermes.

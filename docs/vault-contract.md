# Contrato Hermes ↔ Vault

Status: **proposta, aguardando aprovação**. Nenhum código de Vault deve ser escrito antes de este contrato ser aprovado.

Este documento define o que o Hermes pode fazer no Vault e como. O código de acesso ao GitHub é só a implementação deste contrato; as regras de negócio (metas, tarefas, check-ins) dependem dele, não o contrário.

## 1. Princípios

1. **O Vault guarda eventos e estado; o relógio define "agora".** Datas lidas de notas são dados a comparar com `today(clock)`, nunca definem "hoje".
2. **Toda operação é idempotente.** Ou é *criar-se-não-existir*, ou é *definir valor* (set). Nunca *append cego*. Isso torna seguro o reenvio do Telegram (o webhook responde 500 em falha transitória e o Telegram reenvia o mesmo update).
3. **Nenhuma sobrescrita cega.** Toda atualização usa o `sha` lido; conflito resulta em releitura, nova tentativa limitada ou erro claro, nunca em perda de edição manual.
4. **Fronteira rígida:** o Hermes só escreve em `Hermes/`. O resto do Vault está fora do escopo (nem leitura, por enquanto).
5. **O Hermes nunca apaga arquivos.** Cancelar é mudar `status`.
6. **Sem índice nem estado derivado.** Não há arquivo de índice, contador ou banco. O que existe no Vault é a verdade; listagens são calculadas lendo as notas.

## 2. Estrutura

```
Hermes/
├── metas/      <id>.md
├── tarefas/    <id>.md
├── checkins/   <AAAA>/<AAAA-MM-DD>-<tipo>.md
└── revisoes/   <AAAA>-W<SS>.md
```

- `checkins/` é dividido por ano para não crescer sem limite em um único diretório (a Contents API lista no máximo 1000 itens por diretório).
- `revisoes/` usa semana ISO (`2026-W39`), que começa na segunda-feira, igual à semana do Hermes.
- Todos os arquivos são `.md` com frontmatter YAML.

## 3. Identificadores e nomes de arquivo

O nome do arquivo é o ID mais `.md`. O caminho é **calculável a partir do ID**: buscar por ID não exige listagem nem índice.

**Slug** (função única, pura, testada): minúsculas, remove acentos (NFD), qualquer sequência fora de `[a-z0-9]` vira `-`, sem `-` nas pontas, máximo 60 caracteres. Slug vazio é erro de validação.

| Tipo | ID | Exemplo |
|---|---|---|
| Tarefa | `<data de criação>-<slug(título)>` | `2026-09-25-estudar-system-design` |
| Meta | `<slug(título)>` | `melhorar-linkedin` |
| Check-in | data + tipo, já no caminho | `checkins/2026/2026-09-25-checkin.md` |
| Revisão | semana ISO | `revisoes/2026-W39.md` |

Consequência assumida: **mesmo título no mesmo dia é a mesma tarefa.** Um segundo `/tarefa` idêntico não cria duplicata, responde "já existe". Para uma tarefa distinta, o título deve diferir.

### Data usada no ID (decisão D1)

A data do ID vem do **instante do evento do Telegram** (`message.date`), convertido para `LocalDate` pelo módulo de tempo, e não de `clock.now()` no momento do processamento. Motivo: se o Telegram reenviar o update depois da meia-noite, o ID continua o mesmo e a criação continua idempotente. Requer uma função nova em `src/time/` (instante em epoch seconds → `LocalDate` de SP). A regra "só `src/time/` decide datas" continua valendo.

## 4. Frontmatter

Campos comuns:

| Campo | Tipo | Observação |
|---|---|---|
| `schema` | inteiro | versão do formato, começa em `1` |
| `id` | string | igual ao nome do arquivo sem `.md` |
| `type` | `meta`, `tarefa`, `checkin`, `revisao` | |
| `status` | enum por tipo | ver abaixo |
| `created` | instante ISO 8601 com offset | ex.: `2026-09-25T14:30:00-03:00` |

Campos por tipo:

- **tarefa:** `due` (`LocalDate`, opcional), `meta` (ID de meta, opcional), `done_at` (instante, definido só na primeira transição para `feita`). Status: `pendente`, `feita`, `cancelada`.
- **meta:** `due` (`LocalDate`, opcional). Status: `ativa`, `concluida`, `pausada`, `cancelada`.
- **checkin:** `date` (`LocalDate`), `kind` (`checkin`, `metrics`), `answered_at` (instante, opcional). Detalhes das respostas serão definidos na etapa de check-ins, sempre com semântica de set.
- **revisao:** `week` (`2026-W39`), `week_start` (`LocalDate`).

Regras de tipos de data: instantes sempre com offset (gerados pelo módulo de tempo); dias inteiros sempre `AAAA-MM-DD`. Um valor de data inválido numa nota (edição manual) torna **aquela nota** inválida para o Hermes, não derruba as outras (ver seção 8).

Exemplo de tarefa:

```markdown
---
schema: 1
id: 2026-09-25-estudar-system-design
type: tarefa
status: pendente
created: 2026-09-25T14:30:00-03:00
due: 2026-09-26
meta: melhorar-linkedin
---

# Estudar system design

Notas livres aqui. O Hermes não mexe no corpo depois de criado.
```

O vínculo com a meta fica no campo `meta` (dado para o Hermes). O corpo pode ter um wikilink `[[melhorar-linkedin]]` gerado na criação, só para navegação no Obsidian; o Hermes nunca depende do corpo.

## 5. Quem escreve o quê

- **Hermes cria** o arquivo, com frontmatter completo e um corpo inicial mínimo (`# <título>`).
- **Hermes atualiza só campos de frontmatter que ele possui** (`status`, `done_at`, `due`, `meta`, `answered_at`). Nunca reescreve o corpo.
- **Você pode editar o corpo livremente** e também os campos, inclusive `status` à mão.
- Na reescrita, o Hermes **preserva** o corpo byte a byte, as chaves desconhecidas do frontmatter e (na medida do possível) a ordem e os comentários do YAML. Isso exige edição por documento YAML (`yaml` com `Document`), não `parse` e `stringify` do objeto.
- Se o frontmatter não for parseável ou `schema` for desconhecido, o Hermes **recusa escrever** e avisa. Não "conserta" a nota.

## 6. Operações e idempotência

| Operação | Semântica | Repetição |
|---|---|---|
| Criar tarefa/meta/revisão/check-in | *criar-se-não-existir* no caminho calculado | Arquivo existe: no-op, responde "já existe" |
| Concluir tarefa | set `status: feita`; set `done_at` só se estava vazio | Já `feita`: no-op, não altera `done_at` |
| Cancelar, pausar, reativar | set `status` | Já no valor: no-op |
| Mudar `due` ou `meta` | set do campo | Mesmo valor: no-op (sem commit vazio) |
| Registrar resposta de check-in | set de campos do arquivo do slot | Mesma resposta: no-op |

Criar usa a própria atomicidade do GitHub: `PUT contents` **sem** `sha` falha com 422 se o caminho já existe. Esse é o "verifica se a operação já foi feita", sem estado externo.

Operações que não mudam nada **não geram commit**.

## 7. Conflitos e edição manual

Fluxo de atualização:

1. Lê o arquivo (conteúdo + `sha`).
2. Valida (parse, `schema`, tipos de data).
3. Aplica a operação em memória, pelo caminho da seção 5.
4. Se o resultado for igual ao lido, encerra sem commit.
5. `PUT` com o `sha` lido. Se o GitHub responder 409/422 por `sha` desatualizado, volta ao passo 1 (relê e **reaplica a operação**, que é um set) até 3 tentativas.
6. Esgotadas as tentativas, erro `VaultConflict` com mensagem clara para o Telegram. Nunca sobrescreve.

Como as operações são sets sobre campos, reaplicar sobre a versão nova preserva a sua edição manual em qualquer outro campo ou no corpo.

Se você editar o **mesmo campo** que o Hermes está mudando (ex.: `status`), vence o último `PUT` aceito pelo GitHub, e isso é aceito.

Sincronização no lado do Obsidian (obsidian-git ou similar): o Hermes commita direto no branch configurado. Uma edição local sua ainda não enviada em `Hermes/` pode gerar conflito **no seu git** quando você fizer pull. Recomendação: fazer pull antes de editar arquivos em `Hermes/` e commitar em seguida.

## 8. Leitura, listagem e resolução de referências

- **Ler por ID:** caminho calculado, uma chamada.
- **Listar** (ex.: `/hoje`, `/semana`): lista o diretório e lê cada nota necessária, em paralelo com limite. Sem índice (princípio 6). Custo cresce com o número de notas; ver D3.
- **Nota inválida:** listagens **pulam a nota** e a reportam ("2 notas ignoradas: ..."), sem falhar tudo.
- **Referência do usuário em comandos** (ex.: `/feito linkedin`): ID exato; senão, substring única entre tarefas `pendente`; ambíguo: responde com os candidatos e não faz nada.
- **Atrasada** = `due < today(clock)`, com `today` do relógio. O Vault fornece só o `due`.

## 9. Guarda de caminhos

Uma única função `assertHermesPath(path)` é chamada por **toda** leitura e escrita. Ela rejeita, antes de qualquer chamada de rede:

- caminhos que não comecem com `Hermes/metas/`, `Hermes/tarefas/`, `Hermes/checkins/` ou `Hermes/revisoes/`;
- `..`, `.`, segmentos vazios, `\`, caminho absoluto, bytes de controle;
- extensão diferente de `.md`;
- IDs que não passem na validação de slug/formato.

O PAT do GitHub não restringe por pasta (só por repositório), então **esta guarda é a única barreira** entre o Hermes e o resto do Vault. Ela precisa ter testes próprios e agressivos (path traversal, unicode, `Hermes/../pessoal/x.md`, etc.).

## 10. Interface interna

O domínio nunca fala com o GitHub direto:

```
VaultStore (I/O bruto, mockável)
  read(path)                  -> { content, sha } | null
  create(path, content)       -> "created" | "exists"
  update(path, sha, content)  -> "ok" | "conflict"
  list(dir)                   -> string[]

Repositórios de domínio (metas, tarefas, ...) usam VaultStore,
aplicam assertHermesPath, parse/validação de frontmatter e a lógica da seção 7.
```

Erros tipados: `VaultConflict`, `VaultInvalidNote`, `VaultPathViolation`, `VaultUnavailable` (5xx, rate limit, rede). Só `VaultUnavailable` deve virar 500 no webhook (o Telegram reenvia; seguro porque tudo é idempotente). Os demais viram resposta ao usuário com HTTP 200.

Commits: um por operação que altera algo, mensagem `hermes: <verbo> <tipo> <id>` (ex.: `hermes: create tarefa 2026-09-25-estudar-system-design`), no branch configurado.

Configuração (SSM, mesma abordagem do Telegram): token do GitHub (`/hermes/prod/github/token`, PAT fine-grained, um repositório, apenas *Contents: read and write*), e nomes de `owner/repo` e branch.

## 11. Testes previstos (sem GitHub real)

- `InMemoryVaultStore` com a semântica do GitHub (sha por versão, 422 em criar existente, conflito em sha antigo), usado nos testes de todos os repositórios.
- Idempotência: repetir cada operação 2 vezes gera 1 commit e o mesmo estado.
- Conflito: simular edição concorrente entre a leitura e o `PUT`; verificar reaplicação e preservação de corpo e chaves desconhecidas.
- Preservação: corpo byte a byte, chaves extras, comentários YAML.
- `assertHermesPath`: casos de traversal e formato.
- Slug: acentos, emoji, só símbolos, comprimento máximo.
- Notas inválidas nas listagens.
- IDs de tarefa em torno de meia-noite: update do Telegram com `message.date` às 23:59 e reenvio às 00:01 gera o mesmo ID.

## 12. Decisões abertas

- **D1.** Data do ID de tarefa vem de `message.date` (recomendado) ou de `clock.now()`? (Seção 3.)
- **D2.** Aceitar que "mesmo título no mesmo dia = mesma tarefa"? Alternativa: sufixo de `update_id`, que deixa de deduplicar entre mensagens diferentes.
- **D3.** Custo de listagem: começar sem índice e sem arquivamento, e reavaliar quando `Hermes/tarefas/` passar de ~100 notas (arquivar tarefas antigas por ano é a saída provável; índice em arquivo está descartado).
- **D4.** Commit direto no branch principal (recomendado, simples) ou branch dedicado do Hermes com merge posterior?
- **D5.** Enums em português (`pendente`, `feita`) como proposto, ou inglês?
- **D6.** Repositório do Vault: já existe e é privado? Confirmar nome, branch e se o obsidian-git está em uso.

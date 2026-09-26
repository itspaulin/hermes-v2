# Contrato Hermes ↔ Vault

Status: **aprovado para implementação** (decisões D1 a D6 fechadas na seção 12). Implementação em andamento: `VaultStore`, `InMemoryVaultStore`, guarda de caminhos e slug. O `GitHubVaultStore` vem depois, por cima da mesma interface.

Este documento define o que o Hermes pode fazer no Vault e como. O código de acesso ao GitHub é só a implementação deste contrato; as regras de negócio (metas, tarefas, check-ins) dependem dele, não o contrário.

## 1. Princípios

0. **REGRA INEGOCIÁVEL: o corpo Markdown de uma nota pertence ao usuário.** O Hermes não pode reconstruí-lo, reformatá-lo, normalizá-lo nem sobrescrevê-lo depois da criação. O Hermes só pode alterar os campos de frontmatter que ele possui. Qualquer operação que precise do corpo diferente do que está no Vault está fora do contrato.

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

Consequência assumida (D2, aprovada): **mesmo título no mesmo dia é a mesma tarefa.** Um segundo `/tarefa` idêntico não cria duplicata, responde "já existe". O `update_id` **não** entra no ID. Para uma tarefa distinta, o título deve diferir; se um dia for preciso ter duas iguais no mesmo dia, isso será um mecanismo explícito novo.

### Data usada no ID (decisão D1, aprovada)

A data do ID vem do **instante do evento do Telegram** (`message.date`), convertido para `LocalDate` pelo módulo de tempo, e não de `clock.now()` no momento do processamento. Motivo: se o Telegram reenviar o update depois da meia-noite, o ID continua o mesmo e a criação continua idempotente. Requer uma função nova em `src/time/` (instante em epoch seconds → `LocalDate` de SP). A regra "só `src/time/` decide datas" continua valendo.

## 4. Frontmatter

Campos comuns:

| Campo | Tipo | Observação |
|---|---|---|
| `schema` | inteiro | versão do formato, começa em `1` |
| `title` | string | título original (o `id` usa o slug dele) |
| `id` | string | igual ao nome do arquivo sem `.md` |
| `type` | `meta`, `tarefa`, `checkin`, `revisao` | |
| `status` | enum por tipo | ver abaixo |
| `created` | instante ISO 8601 com offset | ex.: `2026-09-25T14:30:00-03:00`. Vem do instante do **evento**. Nunca é alterado depois da criação |
| `updated` | instante ISO 8601 com offset | pertence ao Hermes; muda quando o Hermes altera um campo que possui. Definido igual a `created` na criação. Pode faltar em notas escritas à mão |

**Nomenclatura (decidida):** chaves em inglês, valores de enums em português.

Campos por tipo:

- **tarefa:** `due` (`LocalDate`, opcional), `meta` (ID da meta, opcional; ver "Vínculo tarefa-meta" abaixo), `done_at` (instante, definido só na primeira transição para `feita`). Status: `pendente`, `feita`, `cancelada`.
- **meta:** `due` (`LocalDate`, opcional). Status: `ativa`, `concluida`, `pausada`, `cancelada`.
- **checkin:** `date` (`LocalDate`), `kind` (`checkin` = diário, `metrics` = quinta), `answer` (texto, opcional), `answered_at` (instante, opcional). O corpo é criado pelo Hermes com o **contexto calculado** (contagens do dia ou métricas da semana) e daí em diante é do usuário.
- **revisao:** `week` (`2026-W39`), `week_start` (`LocalDate`, a segunda-feira), `answer`, `answered_at`. O corpo traz, na criação (sábado 18h), a **avaliação calculada** da semana (taxa de conclusão do que tinha prazo, comparação com a semana anterior), o resumo (tarefas, metas), os check-ins e as métricas manuais. `answer` é uma nota opcional do usuário. O arquivo é plano em `revisoes/` (sem pasta de ano).
- **`answer`** (check-in e revisão): a resposta do usuário pelo Telegram (`/checkin`, `/metrica`, `/revisao`), sempre **uma linha** (quebras viram espaço, máximo 1000 caracteres), guardada no frontmatter para o Hermes nunca reescrever o corpo. Uma segunda resposta diferente é **acrescentada** com ` | ` (nada é perdido); repetir o mesmo texto é no-op. `answered_at` só é definido na primeira resposta.

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

### Vínculo tarefa-meta

- O campo `meta` da tarefa guarda o **ID da meta** (o slug do nome do arquivo em `Hermes/metas/`), nunca o título nem o número de uma opção de menu.
- Uma tarefa pertence a **no máximo uma** meta, ou a nenhuma. Sem meta, o campo é **omitido** (nunca `meta: null` nem vazio).
- Ao criar, o Hermes só grava `meta` se a meta **existe e está `ativa`** naquele momento (validação no Vault, na hora de gravar). Não cria referência quebrada. Se depois a meta for apagada à mão ou mudar de status, a tarefa não é alterada; as listagens mostram o ID no lugar do título quando a meta sumiu.
- A relação **não altera status em nenhum sentido**: concluir/cancelar a tarefa não muda a meta, e concluir/cancelar a meta não muda as tarefas. `/feita` e `/cancelar` preservam `meta`.
- O Hermes **nunca apaga** o arquivo de uma tarefa.
- **Como o `meta` é escolhido** (Telegram): `/tarefa <título> #<id-da-meta>` cria direto. Sem `#meta`, se existirem metas ativas, o Hermes **pergunta** antes de criar (botões e resposta por texto); sem metas ativas, cria direto. Nada é guardado entre a pergunta e a resposta (nem no Vault, nem em memória): a própria mensagem da pergunta carrega o contexto (título, prazo, ID da tarefa e o ID de cada meta da lista), que o Telegram devolve no toque do botão ou no *reply*. A tarefa só passa a existir na resposta, com o ID calculado na pergunta (data do `/tarefa` original), então reenvios continuam idempotentes. A resposta vale por 24 h.

## 5. Quem escreve o quê

- **Hermes cria** o arquivo, com frontmatter completo e um corpo inicial mínimo (`# <título>`).
- **Hermes atualiza só campos de frontmatter que ele possui** (`status`, `done_at`, `due`, `meta`, `answered_at`). Nunca reescreve o corpo.
- **O corpo é seu** (ver princípio 0): você pode editá-lo livremente e também os campos, inclusive `status` à mão.
- Na reescrita, o Hermes **preserva** o corpo byte a byte e o frontmatter do usuário: chaves desconhecidas, ordem, comentários, linhas em branco, estilo de aspas e de coleções, e o fim de linha (LF ou CRLF). Como uma biblioteca YAML reserializando o documento normaliza espaços e linhas em branco, a alteração é **cirúrgica, em texto**: só a linha do campo alterado muda (mantendo comentário da linha e estilo de aspas), ou uma linha nova é acrescentada no fim do frontmatter. Depois de cada alteração o texto é relido como YAML e conferido: se qualquer outra chave mudou, ou o campo não ficou com o valor pedido, a alteração é recusada.
- Um campo do Hermes escrito num formato que não seja escalar simples de uma linha (bloco `|`, coleção, âncora, valor na linha seguinte, chave entre aspas) faz o Hermes **recusar** a operação com `VaultInvalidNote`, sem mexer no arquivo.
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

**Limitação conhecida (descoberta no smoke test real):** o `PUT` da Contents API com `sha` num caminho que não existe mais não falha, cria o arquivo. Se você apagar uma nota exatamente entre o read e o update do Hermes (janela de milissegundos), a nota reaparece com a alteração pedida. Não há como evitar isso de forma atômica com essa API. O aviso `[vault] update recriou arquivo removido: <caminho>` vai para o stdout. Apagar uma nota *antes* da operação funciona normalmente: o `read` dá `null` e o Hermes responde que a tarefa não existe.

Se você editar o **mesmo campo** que o Hermes está mudando (ex.: `status`), vence o último `PUT` aceito pelo GitHub, e isso é aceito.

Sincronização no lado do Obsidian (obsidian-git ou similar): o Hermes commita direto no branch configurado. Uma edição local sua ainda não enviada em `Hermes/` pode gerar conflito **no seu git** quando você fizer pull. Recomendação: fazer pull antes de editar arquivos em `Hermes/` e commitar em seguida.

## 8. Leitura, listagem e resolução de referências

- **Ler por ID:** caminho calculado, uma chamada.
- **Listar** (ex.: `/hoje`, `/semana`): lista o diretório e lê cada nota necessária, em paralelo com limite. Sem índice (princípio 6). Custo cresce com o número de notas; ver D3.
- **Nota inválida:** listagens **pulam a nota** e a reportam ("2 notas ignoradas: ..."), sem falhar tudo.
- **Referência do usuário em comandos** (ex.: `/feito linkedin`): ID exato; senão, substring única entre tarefas `pendente`; ambíguo: responde com os candidatos e não faz nada.
- **Atrasada** = `due < today(clock)`, com `today` do relógio. O Vault fornece só o `due`.

## 9. Guarda de caminhos

Uma única função `assertHermesPath(path)` é chamada por **toda** leitura e escrita, e não pelo chamador: um decorator (`guardVaultStore`) envolve qualquer `VaultStore` e aplica a guarda antes de qualquer I/O. O domínio nunca recebe um store sem guarda. `list` usa `assertHermesDir` e também valida os caminhos que o store devolve. A guarda é uma **lista de permissão** (só passa o que casa com a gramática abaixo), portanto rejeita, antes de qualquer chamada de rede:

- caminhos que não comecem com `Hermes/metas/`, `Hermes/tarefas/`, `Hermes/checkins/` ou `Hermes/revisoes/`;
- `..`, `.`, segmentos vazios, `\`, caminho absoluto, bytes de controle;
- extensão diferente de `.md`;
- IDs que não passem na validação de slug/formato;
- qualquer caractere fora de ASCII imprimível sem espaço (unicode, controle, NUL, `\`);
- gramática exata por pasta: `metas/<slug>.md`, `tarefas/<AAAA-MM-DD>-<slug>.md` (data real), `checkins/<AAAA>/<AAAA-MM-DD>-<checkin|metrics>.md` (ano da pasta igual ao da data), `revisoes/<AAAA>-W<01..53>.md`.

O PAT do GitHub não restringe por pasta (só por repositório), então **esta guarda é a única barreira** entre o Hermes e o resto do Vault. Ela precisa ter testes próprios e agressivos (path traversal, unicode, `Hermes/../pessoal/x.md`, etc.).

## 10. Interface interna

O domínio nunca fala com o GitHub direto:

```
VaultStore (I/O bruto, mockável)
  read(path)                  -> { content, sha } | null
  create(path, content)       -> "created" | "exists"
  update(path, sha, content)  -> "ok" | "conflict"   (conflict = sha desatualizado OU arquivo sumiu)
  list(dir)                   -> string[]            (.md diretamente em dir, não recursivo)

Repositórios de domínio (metas, tarefas, ...) usam VaultStore,
aplicam assertHermesPath, parse/validação de frontmatter e a lógica da seção 7.
```

Erros tipados: `VaultConflict`, `VaultInvalidNote`, `VaultPathViolation`, `VaultUnavailable` (429, 5xx, rate limit, rede) e `VaultApiError` (resposta não transitória: token inválido, sem permissão, repo ou branch inexistente, validação). Só `VaultUnavailable` deve virar 500 no webhook (o Telegram reenvia; seguro porque tudo é idempotente). Os demais viram resposta ao usuário com HTTP 200.

Tradução do `GitHubVaultStore` (nada da API vaza para o domínio): 404 de arquivo vira `null` ou lista vazia (confirmando uma vez que o branch é acessível, porque 404 também significa repo/branch/permissão errados); 422 com "sha" ao criar vira `exists`; 409 (ou 422 com "sha") ao atualizar vira `conflict`; **update de arquivo removido (verificado no GitHub real): o GitHub ignora o sha e CRIA o arquivo (201), e o store devolve `ok` com um aviso no stdout** (ver seção 7); 409 ao criar (corrida de branch com outro escritor) refaz até 3 vezes, depois `VaultUnavailable`; 429, 5xx, rate limit e falha de rede viram `VaultUnavailable`; o resto vira `VaultApiError`. Conteúdo que não seja UTF-8 válido é recusado (`VaultInvalidNote`) em vez de decodificado com perda, porque reescrever corromperia o corpo; arquivos acima de 1 MB e listagens com 1000+ itens (truncadas pela API) também falham alto.

Commits: um por operação que altera algo, no branch configurado. O store não conhece tipos de nota, então a mensagem é derivada do caminho: `hermes: create <caminho>` ou `hermes: update <caminho>` (ex.: `hermes: create Hermes/tarefas/2026-09-25-estudar-system-design.md`).

Configuração: `owner/repo` e branch não são segredo (env vars `VAULT_REPO=owner/repo` e `VAULT_BRANCH`); o token do GitHub (PAT fine-grained, um repositório, apenas *Contents: read and write*) fica no SSM SecureString, e a Lambda recebe só o nome do parâmetro (`VAULT_GITHUB_TOKEN_PARAM`, ex.: `/hermes/prod/vault/github-token`). O token nunca aparece em mensagens de erro.

## 11. Testes previstos (sem GitHub real)

- `InMemoryVaultStore` com a semântica do GitHub (sha por versão, 422 em criar existente, conflito em sha antigo), usado nos testes de todos os repositórios.
- Idempotência: repetir cada operação 2 vezes gera 1 commit e o mesmo estado.
- Conflito: simular edição concorrente entre a leitura e o `PUT`; verificar reaplicação e preservação de corpo e chaves desconhecidas.
- Preservação: corpo byte a byte, chaves extras, comentários YAML.
- `assertHermesPath`: casos de traversal e formato.
- Slug: acentos, emoji, só símbolos, comprimento máximo.
- Notas inválidas nas listagens.
- IDs de tarefa em torno de meia-noite: update do Telegram com `message.date` às 23:59 e reenvio às 00:01 gera o mesmo ID.

## 12. Decisões

- **D1. Aprovada:** a data do ID de tarefa vem de `message.date` (evento original), nunca de `clock.now()`. Falta implementar a função em `src/time/` (epoch seconds para `LocalDate`); será feita junto com o repositório de tarefas.
- **D2. Aprovada:** mesmo título no mesmo dia é a mesma tarefa. `update_id` fora do ID.
- **D3. Aprovada:** sem índice e sem arquivamento. ~100 tarefas não é limite técnico, só um ponto possível de revisão; a decisão será por medição, quando `/hoje` ou `/semana` ficarem lentos de verdade.
- **D4. Aprovada:** commit direto no branch principal. A proteção real é `assertHermesPath`.
- **D5. Aprovada:** enums em português (`pendente`, `feita`, `cancelada`, `ativa`, `concluida`, `pausada`).
- **D6. Adiada:** repositório, branch e PAT só serão necessários para o `GitHubVaultStore`. Primeiro `VaultStore` + `InMemoryVaultStore` + guarda.
- **Em aberto (pequeno):** nomes das chaves de frontmatter em português ou inglês (`created` vs `criada_em`). O contrato usa inglês; decidir antes do repositório de tarefas.

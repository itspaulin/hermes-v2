# Notion: tarefas e metas

Desde 2026-11-07 as **tarefas e metas** do Hermes ficam em dois bancos do Notion. Check-ins, revisões e as notas do Renato continuam no Vault (GitHub). O Hermes escolhe o armazenamento ao iniciar: com `NOTION_TASKS_DB` e `NOTION_METAS_DB` preenchidos usa o Notion; sem eles, continua no Vault. Código em `src/notion/`; o resto do bot só conhece as interfaces `TaskRepository` e `MetaRepository` (`src/domain/`).

## Bancos e propriedades

Os nomes abaixo são o contrato: o código procura por eles. Os tipos importam (`ID` precisa ser Text, `Status` precisa ser **Select**, não o tipo "Status" do Notion, que a API não consegue configurar).

**Metas**: `Nome` (title), `ID` (text, slug do título), `Status` (select: `ativa`, `concluida`, `pausada`, `cancelada`), `Prazo` (date), `Criada` (date).

**Tarefas**: `Nome` (title), `ID` (text, `AAAA-MM-DD-<slug>`), `Status` (select: `pendente`, `feita`, `cancelada`), `Prazo` (date), `Criada` (date), `Feita em` (date), `Meta` (relation para Metas).

A data de última alteração (`updated`) vem do campo automático do Notion.

## Regras

- **Criar é criar-se-não-existir** pelo ID determinístico (mesmas regras do Vault: mesmo título no mesmo dia é a mesma tarefa). O Notion não tem restrição de unicidade: duas criações simultâneas do mesmo ID podem duplicar a linha (o Telegram reenvia em sequência, então na prática não ocorre); na leitura vale a linha mais antiga.
- **Alterar manda só as propriedades do Hermes** (`Status`, `Prazo`, `Feita em`, `ID`). Não há lock otimista: uma edição sua em outra propriedade nunca é sobrescrita.
- **Nunca apaga.** Excluir é com você no Notion.
- **Linhas criadas à mão no Notion funcionam.** Sem `ID`, o ID é derivado (`AAAA-MM-DD-<slug do título>` com a data de criação da página; metas: slug do título); sem `Status`, a tarefa é `pendente` e a meta `ativa`; sem `Criada`, vale a criação da página. Na primeira alteração pelo Hermes, o `ID` derivado é gravado na linha.
- Linha com título vazio, status fora da lista, prazo inválido ou ID inválido é **ignorada** (aparece como "nota ignorada" nas listagens), nunca derruba o comando.
- `Prazo` com horário vale como a data civil em America/Sao_Paulo.
- `Meta` guarda a relação pela página; o Hermes converte de/para o ID da meta. Criar tarefa com meta inexistente falha.

## Erros e retry

- 429: espera `Retry-After` (até 2 s) e tenta de novo até 2 vezes; esgotado, 5xx, timeout (8 s) e rede = `NotionUnavailable` → webhook responde 500 (o Telegram reenvia; criar é idempotente).
- 401/403/404/400 (token, banco não compartilhado, propriedade ausente ou com tipo errado) = `NotionApiError` → resposta 200 com "Não consegui acessar o Notion (erro de configuração ou permissão)" e o detalhe no log, sem token.

## Segredo e configuração

Token da integração no SSM (SecureString, padrão `/hermes/prod/notion/token`, parâmetro `NotionTokenParam`), lido só no cold start; nunca pelo chat. IDs dos bancos (32 caracteres, não são segredo): parâmetros `NotionTasksDb` e `NotionMetasDb` do `template.yaml`. Cada banco precisa ser compartilhado com a integração (`…` → Connections).

## Migração do Vault

`npm run migrate:notion` lê as pastas `Hermes/tarefas` e `Hermes/metas` do clone local do Vault (faça `git pull` antes), e só cria no Notion o que ainda não existe (por ID). Sem `--apply` é ensaio. `--exclude=<id>` deixa de fora um item. Depois de migrar, as notas antigas ficam no Vault como arquivo e o Hermes deixa de lê-las. `npm run smoke:notion` testa o ciclo completo contra os bancos reais e arquiva o que criar.

# Decisões

- TypeScript, Node 22, Lambda arm64, SAM, luxon, vitest.
- Idempotência por design (IDs determinísticos); sem dedupe em memória de Lambda.
- Vault: GitHub Contents/Data API, um commit por operação, sem camada Git.
- Só comandos estruturados; sem LLM nesta fase.
- Horários em `src/config.ts`, não espalhados.
- Novos serviços AWS além de API Gateway, Lambda, EventBridge Scheduler e SSM exigem justificativa prévia.
- Histórico curto da conversa do Hermes no Neon (Postgres externo, plano free): exceção deliberada a "sem banco", aprovada pelo usuário em 2026-11-07. Opcional, falha aberta, guardado só texto das últimas mensagens, retenção de 24 h. Sem DynamoDB.
- Tarefas e metas no Notion (2026-11-07), escolha do usuário por preferir a interface e as automações dele; check-ins, revisões e Renato continuam no Vault. Os repositórios são interfaces (`TaskRepository`, `MetaRepository`) com implementação Vault e Notion, escolhida por configuração. Ver docs/notion-contract.md.

# Decisões

- TypeScript, Node 22, Lambda arm64, SAM, luxon, vitest.
- Idempotência por design (IDs determinísticos); sem dedupe em memória de Lambda.
- Vault: GitHub Contents/Data API, um commit por operação, sem camada Git.
- Só comandos estruturados; sem LLM nesta fase.
- Horários em `src/config.ts`, não espalhados.
- Novos serviços AWS além de API Gateway, Lambda, EventBridge Scheduler e SSM exigem justificativa prévia.

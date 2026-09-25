import { defineConfig } from "vitest/config";

/** Testes de integração REAIS (GitHub + SSM). Fora do `npm test`: `npm run test:integration`. */
export default defineConfig({
  test: {
    include: ["test/integration/**/*.itest.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});

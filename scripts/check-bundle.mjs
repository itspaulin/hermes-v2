// Verifica que o bundle da Lambda inicializa como ESM de verdade.
// IMPORTANTE: precisa ser um ARQUIVO .mjs. Com `node -e`, o `require` global existe e mascara
// o erro "Dynamic require of ... is not supported" que só aparece na Lambda.
const path = new URL("../.aws-sam/build/HermesFunction/handler.mjs", import.meta.url);
try {
  const m = await import(path);
  if (typeof m.handler !== "function") throw new Error("o bundle não exporta `handler`");
  console.log("bundle Hermes ok: handler exportado e módulo inicializa em ESM");
} catch (err) {
  console.error(`bundle QUEBRADO: ${err.message}`);
  process.exit(1);
}

const renatoPath = new URL("../.aws-sam/build/RenatoFunction/lambda.mjs", import.meta.url);
try {
  const m = await import(renatoPath);
  if (typeof m.handler !== "function") throw new Error("o bundle do Renato não exporta `handler`");
  console.log("bundle Renato ok: handler exportado e módulo inicializa em ESM");
} catch (err) {
  console.error(`bundle Renato QUEBRADO: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

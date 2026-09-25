import { describe, expect, it, vi } from "vitest";
import { VaultApiError, VaultInvalidNote, VaultPathViolation, VaultUnavailable } from "../src/vault/errors.js";
import { createGitHubVaultStore } from "../src/vault/github-store.js";
import { loadVaultConfig } from "../src/vault/config.js";
import { blobSha, InMemoryVaultStore } from "../src/vault/memory-store.js";
import { guardVaultStore, type VaultStore } from "../src/vault/store.js";
import { FakeGitHub, json } from "./support/fake-github.js";

const TOKEN = "ghp_SUPERSECRETTOKEN";
const P = "Hermes/tarefas/2026-09-25-estudar.md";
const cfg = { owner: "itspaulin", repo: "vault", branch: "main", token: TOKEN };

function ghStore(gh = new FakeGitHub()) {
  const sleep = vi.fn(async () => {});
  return { gh, sleep, store: createGitHubVaultStore(cfg, { fetch: gh.fetch, sleep }) };
}

/** Mesma suíte nas duas implementações: o domínio não pode notar a diferença. */
interface Impl {
  store: VaultStore;
  external(path: string, content: string): void;
  commits(): number;
}
const impls: [string, () => Impl][] = [
  [
    "InMemoryVaultStore",
    () => {
      const mem = new InMemoryVaultStore();
      return { store: guardVaultStore(mem), external: (p, c) => mem.externalWrite(p, c), commits: () => mem.commits.length };
    },
  ],
  [
    "GitHubVaultStore (GitHub falso)",
    () => {
      const { gh, store } = ghStore();
      return { store, external: (p, c) => gh.externalWrite(p, c), commits: () => gh.commits.length };
    },
  ],
];

describe.each(impls)("contrato VaultStore: %s", (_name, make) => {
  it("read de inexistente é null", async () => {
    expect(await make().store.read(P)).toBeNull();
  });

  it("create, read e sha = blob sha do git", async () => {
    const { store } = make();
    expect(await store.create(P, "olá\n")).toBe("created");
    expect(await store.read(P)).toEqual({ content: "olá\n", sha: blobSha("olá\n") });
  });

  it("create em existente: 'exists' sem tocar no conteúdo nem gerar commit", async () => {
    const i = make();
    await i.store.create(P, "a");
    expect(await i.store.create(P, "b")).toBe("exists");
    expect((await i.store.read(P))?.content).toBe("a");
    expect(i.commits()).toBe(1);
  });

  it("update com sha atual", async () => {
    const i = make();
    await i.store.create(P, "a");
    const { sha } = (await i.store.read(P))!;
    expect(await i.store.update(P, sha, "b")).toBe("ok");
    expect((await i.store.read(P))?.content).toBe("b");
  });

  it("update com sha velho: conflict, conteúdo do usuário intacto", async () => {
    const i = make();
    await i.store.create(P, "a");
    const { sha } = (await i.store.read(P))!;
    i.external(P, "editado à mão");
    expect(await i.store.update(P, sha, "b")).toBe("conflict");
    expect((await i.store.read(P))?.content).toBe("editado à mão");
  });

  it("update de arquivo inexistente: conflict", async () => {
    expect(await make().store.update(P, "abc", "b")).toBe("conflict");
  });

  it("preserva unicode, emoji, CRLF e linhas longas (base64 com quebras)", async () => {
    const { store } = make();
    const c = `---\r\nid: a\r\n---\r\n# Ação 日本語 🚀\r\n${"x".repeat(500)}\r\n`;
    await store.create(P, c);
    expect((await store.read(P))?.content).toBe(c);
  });

  it("list: só .md diretamente no diretório, ordenado; vazio se não existe", async () => {
    const i = make();
    expect(await i.store.list("Hermes/tarefas")).toEqual([]);
    await i.store.create("Hermes/tarefas/2026-09-26-b.md", "x");
    await i.store.create("Hermes/tarefas/2026-09-25-a.md", "x");
    await i.store.create("Hermes/metas/m.md", "x");
    await i.store.create("Hermes/checkins/2026/2026-09-25-checkin.md", "x");
    i.external("Hermes/tarefas/nota.txt", "x");
    expect(await i.store.list("Hermes/tarefas")).toEqual(["Hermes/tarefas/2026-09-25-a.md", "Hermes/tarefas/2026-09-26-b.md"]);
    expect(await i.store.list("Hermes/checkins/2026")).toEqual(["Hermes/checkins/2026/2026-09-25-checkin.md"]);
    expect(await i.store.list("Hermes/checkins")).toEqual([]);
  });

  it("a guarda vale: caminho fora do contrato é recusado", async () => {
    const { store } = make();
    await expect(store.read("Hermes/../pessoal/x.md")).rejects.toBeInstanceOf(VaultPathViolation);
    await expect(store.create("metas/x.md", "a")).rejects.toBeInstanceOf(VaultPathViolation);
  });
});

describe("GitHubVaultStore: requisição", () => {
  it("usa branch, headers, mensagem de commit e base64 corretos", async () => {
    const { gh, store } = ghStore();
    await store.create(P, "olá");
    await store.update(P, blobSha("olá"), "olá 2");
    const [put1, put2] = gh.requests;
    expect(put1!.url).toBe("https://api.github.com/repos/itspaulin/vault/contents/Hermes/tarefas/2026-09-25-estudar.md");
    expect(put1!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(put1!.headers.accept).toBe("application/vnd.github+json");
    expect(put1!.headers["user-agent"]).toBe("hermes-v2");
    expect(put1!.body).toEqual({
      message: `hermes: create ${P}`,
      content: Buffer.from("olá").toString("base64"),
      branch: "main",
    });
    expect(put2!.body).toMatchObject({ message: `hermes: update ${P}`, sha: blobSha("olá"), branch: "main" });
    await store.read(P);
    expect(gh.requests.at(-1)!.url).toContain("?ref=main");
  });

  it("nunca faz chamada de rede para caminho fora do contrato", async () => {
    const { gh, store } = ghStore();
    for (const bad of ["Hermes/../x.md", "pessoal/x.md", "Hermes2/metas/x.md", "Hermes/tarefas/../../x.md"]) {
      await expect(store.read(bad)).rejects.toBeInstanceOf(VaultPathViolation);
      await expect(store.create(bad, "x")).rejects.toBeInstanceOf(VaultPathViolation);
      await expect(store.update(bad, "s", "x")).rejects.toBeInstanceOf(VaultPathViolation);
      await expect(store.list(bad)).rejects.toBeInstanceOf(VaultPathViolation);
    }
    expect(gh.requests).toHaveLength(0);
  });

  it("valida a configuração", () => {
    for (const bad of [{ owner: "a/b" }, { repo: "x y" }, { branch: "../x" }, { branch: "" }, { token: " " }]) {
      expect(() => createGitHubVaultStore({ ...cfg, ...bad }, { fetch: vi.fn() })).toThrow();
    }
  });
});

/** Store cujo fetch devolve respostas roteirizadas. */
function scripted(...responses: (Response | Error)[]) {
  const queue = [...responses];
  const f = vi.fn(async () => {
    const r = queue.shift();
    if (!r) throw new Error("resposta não roteirizada");
    if (r instanceof Error) throw r;
    return r;
  });
  const sleep = vi.fn(async () => {});
  return { f, sleep, store: createGitHubVaultStore(cfg, { fetch: f as never, sleep }) };
}

describe("GitHubVaultStore: tradução de erros da API", () => {
  it.each([500, 502, 503, 429])("%s vira VaultUnavailable (reenviável)", async (status) => {
    const { store } = scripted(json(status, { message: "boom" }));
    await expect(store.create(P, "a")).rejects.toBeInstanceOf(VaultUnavailable);
  });

  it("403 com rate limit (header ou mensagem) vira VaultUnavailable", async () => {
    await expect(
      scripted(json(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0" })).store.read(P),
    ).rejects.toBeInstanceOf(VaultUnavailable);
    await expect(
      scripted(json(403, { message: "You have exceeded a secondary rate limit" })).store.read(P),
    ).rejects.toBeInstanceOf(VaultUnavailable);
    await expect(scripted(json(403, { message: "x" }, { "retry-after": "30" })).store.read(P)).rejects.toBeInstanceOf(
      VaultUnavailable,
    );
  });

  it("falha de rede vira VaultUnavailable sem vazar detalhes", async () => {
    const err = await scripted(new TypeError(`fetch failed ${TOKEN}`)).store.read(P).catch((e) => e);
    expect(err).toBeInstanceOf(VaultUnavailable);
    expect(err.message).not.toContain(TOKEN);
  });

  it.each([401, 403])("%s (não rate limit) vira VaultApiError, não reenviável", async (status) => {
    const err = await scripted(json(status, { message: "Bad credentials" })).store.create(P, "a").catch((e) => e);
    expect(err).toBeInstanceOf(VaultApiError);
    expect(err.status).toBe(status);
    expect(err).not.toBeInstanceOf(VaultUnavailable);
  });

  it("nenhuma mensagem de erro contém o token", async () => {
    for (const r of [json(401, { message: "Bad credentials" }), json(500, { message: "x" }), json(422, { message: "y" })]) {
      const err = await scripted(r).store.create(P, "a").catch((e) => e);
      expect(String(err.message)).not.toContain(TOKEN);
    }
  });

  it("404 no read: arquivo ausente só se o branch existe; senão é erro de configuração", async () => {
    const ok = scripted(json(404, { message: "Not Found" }), json(200, { name: "main" }));
    expect(await ok.store.read(P)).toBeNull();
    const bad = scripted(json(404, { message: "Not Found" }), json(404, { message: "Not Found" }));
    await expect(bad.store.read(P)).rejects.toBeInstanceOf(VaultApiError);
  });

  it("depois de verificar o branch uma vez, 404 não faz chamada extra", async () => {
    const { f, store } = scripted(
      json(404, { message: "Not Found" }),
      json(200, { name: "main" }),
      json(404, { message: "Not Found" }),
    );
    expect(await store.read(P)).toBeNull();
    expect(await store.read(P)).toBeNull();
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("list de diretório inexistente: [] se o branch existe; erro se não", async () => {
    expect(await scripted(json(404, {}), json(200, {})).store.list("Hermes/tarefas")).toEqual([]);
    await expect(scripted(json(404, {}), json(404, {})).store.list("Hermes/tarefas")).rejects.toBeInstanceOf(VaultApiError);
  });

  it("list truncada (1000+ itens) falha alto em vez de esconder notas", async () => {
    const many = Array.from({ length: 1000 }, (_, i) => ({ type: "file", name: `${i}.md`, path: `Hermes/tarefas/${i}.md` }));
    await expect(scripted(json(200, many)).store.list("Hermes/tarefas")).rejects.toBeInstanceOf(VaultApiError);
  });

  it("list ignora subdiretórios e não-.md", async () => {
    const { store } = scripted(
      json(200, [
        { type: "dir", name: "2026", path: "Hermes/checkins/2026" },
        { type: "file", name: "2026-09-25-a.md", path: "Hermes/tarefas/2026-09-25-a.md" },
        { type: "file", name: "b.txt", path: "Hermes/tarefas/b.txt" },
      ]),
    );
    expect(await store.list("Hermes/tarefas")).toEqual(["Hermes/tarefas/2026-09-25-a.md"]);
  });

  it("list valida também o que o GitHub devolve", async () => {
    const { store } = scripted(json(200, [{ type: "file", name: "x.md", path: "pessoal/x.md" }]));
    await expect(store.list("Hermes/tarefas")).rejects.toBeInstanceOf(VaultPathViolation);
  });

  it("create: 422 sem menção a sha é erro, não 'exists'", async () => {
    const err = await scripted(json(422, { message: "Invalid request. content is invalid" })).store.create(P, "a").catch((e) => e);
    expect(err).toBeInstanceOf(VaultApiError);
  });

  it("create: 409 (corrida de branch) refaz e depois funciona", async () => {
    const { f, sleep, store } = scripted(json(409, { message: "is at abc but expected def" }), json(201, {}));
    expect(await store.create(P, "a")).toBe("created");
    expect(f).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("create: 409 refaz e, se o commit anterior tinha entrado, responde 'exists'", async () => {
    const { store } = scripted(json(409, { message: "x" }), json(422, { message: '"sha" wasn\'t supplied.' }));
    expect(await store.create(P, "a")).toBe("exists");
  });

  it("create: 409 persistente vira VaultUnavailable depois de 3 tentativas", async () => {
    const { f, store } = scripted(json(409, {}), json(409, {}), json(409, {}));
    await expect(store.create(P, "a")).rejects.toBeInstanceOf(VaultUnavailable);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("update: 409 e 422 com sha viram 'conflict'; 422 sem sha é erro", async () => {
    expect(await scripted(json(409, { message: "does not match" })).store.update(P, "s", "a")).toBe("conflict");
    expect(await scripted(json(422, { message: '"sha" is not a valid sha' })).store.update(P, "s", "a")).toBe("conflict");
    await expect(scripted(json(422, { message: "content invalid" })).store.update(P, "s", "a")).rejects.toBeInstanceOf(VaultApiError);
  });

  it("update: 404 = 'conflict' só com branch existente; senão erro de configuração", async () => {
    expect(await scripted(json(404, {}), json(200, {})).store.update(P, "s", "a")).toBe("conflict");
    await expect(scripted(json(404, {}), json(404, {})).store.update(P, "s", "a")).rejects.toBeInstanceOf(VaultApiError);
  });

  it("create: 404 é erro de configuração (criar nunca deveria dar 404)", async () => {
    await expect(scripted(json(404, { message: "Not Found" })).store.create(P, "a")).rejects.toBeInstanceOf(VaultApiError);
  });
});

describe("GitHubVaultStore: leitura defensiva", () => {
  const fileJson = (over: object = {}) => ({
    type: "file", sha: "abc", size: 3, encoding: "base64", content: Buffer.from("abc").toString("base64"), ...over,
  });

  it("recusa diretório, arquivo grande e conteúdo em formato inesperado", async () => {
    await expect(scripted(json(200, [])).store.read(P)).rejects.toBeInstanceOf(VaultInvalidNote);
    await expect(scripted(json(200, fileJson({ type: "symlink" }))).store.read(P)).rejects.toBeInstanceOf(VaultInvalidNote);
    await expect(scripted(json(200, fileJson({ size: 2_000_000 }))).store.read(P)).rejects.toBeInstanceOf(VaultInvalidNote);
    await expect(scripted(json(200, fileJson({ encoding: "none", content: "" }))).store.read(P)).rejects.toBeInstanceOf(VaultApiError);
    await expect(scripted(json(200, fileJson({ sha: undefined }))).store.read(P)).rejects.toBeInstanceOf(VaultApiError);
  });

  it("UTF-8 inválido é recusado (reescrever corromperia o corpo)", async () => {
    const bad = Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]).toString("base64");
    await expect(scripted(json(200, fileJson({ content: bad }))).store.read(P)).rejects.toBeInstanceOf(VaultInvalidNote);
  });

  it("BOM é preservado na string (não descartado em silêncio)", async () => {
    const bom = Buffer.from("﻿abc", "utf8").toString("base64");
    expect((await scripted(json(200, fileJson({ content: bom }))).store.read(P))?.content).toBe("﻿abc");
  });
});

describe("loadVaultConfig", () => {
  const env = { VAULT_REPO: "itspaulin/vault", VAULT_BRANCH: "main", VAULT_GITHUB_TOKEN_PARAM: "/hermes/prod/github/token" };
  const ssm = { get: vi.fn(async (n: string) => (n === env.VAULT_GITHUB_TOKEN_PARAM ? TOKEN : "?")) };

  it("junta env vars e token do SSM", async () => {
    expect(await loadVaultConfig(ssm, env)).toEqual({ owner: "itspaulin", repo: "vault", branch: "main", token: TOKEN });
  });

  it.each(["VAULT_REPO", "VAULT_BRANCH", "VAULT_GITHUB_TOKEN_PARAM"])("falta %s", async (k) => {
    await expect(loadVaultConfig(ssm, { ...env, [k]: undefined })).rejects.toThrow(k);
  });

  it.each(["vault", "a/b/c", "/x", "x/"])("VAULT_REPO inválido: %s", async (repo) => {
    await expect(loadVaultConfig(ssm, { ...env, VAULT_REPO: repo })).rejects.toThrow("owner/repo");
  });
});

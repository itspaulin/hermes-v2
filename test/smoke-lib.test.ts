import { describe, expect, it, vi } from "vitest";
import { runVaultSmoke } from "../scripts/smoke-lib.js";
import { createGitHubVaultStore } from "../src/vault/github-store.js";
import type { VaultStore } from "../src/vault/store.js";
import { FakeGitHub } from "./support/fake-github.js";

function fakeStore() {
  const gh = new FakeGitHub();
  const store = createGitHubVaultStore(
    { owner: gh.owner, repo: gh.repo, branch: gh.branch, token: "t" },
    { fetch: gh.fetch, sleep: async () => {} },
  );
  return { gh, store };
}

describe("roteiro do smoke test (contra o GitHub falso)", () => {
  it("passa todos os passos e deixa exatamente 2 commits e 1 arquivo", async () => {
    const { gh, store } = fakeStore();
    const r = await runVaultSmoke(store, { suffix: "abc12345" });
    expect(r.steps.filter((s) => !s.ok)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.path).toBe("Hermes/tarefas/2000-01-01-smoke-test-abc12345.md");
    expect(gh.commits.map((c) => c.op)).toEqual(["create", "update"]);
    expect(gh.commitMessages).toEqual([`hermes: create ${r.path}`, `hermes: update ${r.path}`]);
  });

  it("--check-update-missing: passa e não cria o arquivo ausente", async () => {
    const { gh, store } = fakeStore();
    const r = await runVaultSmoke(store, { suffix: "abc12345", checkUpdateMissing: true });
    expect(r.ok).toBe(true);
    expect(gh.commits).toHaveLength(2);
  });

  it("para no primeiro passo que falha e o reporta", async () => {
    const { store } = fakeStore();
    const broken: VaultStore = { ...store, create: vi.fn(async () => "exists" as const) };
    const r = await runVaultSmoke(broken, { suffix: "x" });
    expect(r.ok).toBe(false);
    expect(r.steps.at(-1)).toMatchObject({ ok: false });
    expect(r.steps.at(-1)!.name).toContain("create");
    expect(r.steps).toHaveLength(3);
  });

  it("detecta sha que não é o blob sha do git", async () => {
    const { store } = fakeStore();
    const wrongSha: VaultStore = {
      ...store,
      read: async (p) => {
        const f = await store.read(p);
        return f && { ...f, sha: "0".repeat(40) };
      },
    };
    const r = await runVaultSmoke(wrongSha, { suffix: "x" });
    expect(r.ok).toBe(false);
    expect(r.steps.at(-1)!.name).toContain("sha");
  });

  it("detecta update com sha antigo aceito indevidamente", async () => {
    const { store } = fakeStore();
    const lax: VaultStore = {
      ...store,
      update: async (p, sha, c) => {
        await store.update(p, sha, c);
        return "ok";
      },
    };
    const r = await runVaultSmoke(lax, { suffix: "x" });
    expect(r.ok).toBe(false);
    expect(r.steps.at(-1)!.name).toContain("sha antigo");
  });
});

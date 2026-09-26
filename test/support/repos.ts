import { CheckinRepository } from "../../src/domain/checkin-repository.js";
import { MetaRepository } from "../../src/domain/meta-repository.js";
import { ReviewRepository } from "../../src/domain/review-repository.js";
import { TaskRepository } from "../../src/domain/task-repository.js";
import type { Clock } from "../../src/time/index.js";
import type { VaultStore } from "../../src/vault/store.js";

/** Todos os repositórios sobre o mesmo store (guardado), como em produção. */
export function makeRepos(store: VaultStore, clock: Clock) {
  return {
    tasks: new TaskRepository(store, clock),
    metas: new MetaRepository(store, clock),
    checkins: new CheckinRepository(store, clock),
    reviews: new ReviewRepository(store, clock),
  };
}

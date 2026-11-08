import { CheckinRepository } from "../../src/domain/checkin-repository.js";
import { VaultMetaRepository } from "../../src/domain/meta-repository.js";
import { ReviewRepository } from "../../src/domain/review-repository.js";
import { VaultTaskRepository } from "../../src/domain/task-repository.js";
import type { Clock } from "../../src/time/index.js";
import type { VaultStore } from "../../src/vault/store.js";

/** Todos os repositórios sobre o mesmo store (guardado), como em produção. */
export function makeRepos(store: VaultStore, clock: Clock) {
  return {
    tasks: new VaultTaskRepository(store, clock),
    metas: new VaultMetaRepository(store, clock),
    checkins: new CheckinRepository(store, clock),
    reviews: new ReviewRepository(store, clock),
  };
}

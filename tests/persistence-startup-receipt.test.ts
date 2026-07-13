import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { buildStartupReceipt, scanPersistentStores } from "../scripts/scan-persistent-stores.mjs";
import {
  FUTURE_EPOCH_COORDINATOR_PHASE,
  STARTUP_PHASES,
  startupPhaseIndex,
} from "../shared/persistence/startup-phases.ts";
import { PERSISTENT_STORES } from "../shared/persistence/store-registry.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STARTUP_RECEIPT_PATH = path.join(ROOT, "build", "persistence-startup-receipt.json");

describe("persistence startup receipt", () => {
  it("uses the canonical phase order and records every registered store", () => {
    expect(STARTUP_PHASES).toEqual([
      "home_guard",
      "epoch_preflight",
      "transport_bind",
      "first_run_seed",
      "identity_seed",
      "engine_construct",
      "engine_init_legacy_migrations",
      "runtime_ready",
    ]);
    expect(FUTURE_EPOCH_COORDINATOR_PHASE).toBe("epoch_preflight");

    const receipt = buildStartupReceipt(PERSISTENT_STORES);
    expect(receipt.stores).toHaveLength(PERSISTENT_STORES.length);
    expect(receipt.stores.map((store) => store.id).sort()).toEqual(PERSISTENT_STORES.map((store) => store.id).sort());
  });

  it("derives pre-coordinator risk and required access moves from the declared phases", () => {
    const receipt = buildStartupReceipt(PERSISTENT_STORES);
    const coordinatorIndex = startupPhaseIndex(FUTURE_EPOCH_COORDINATOR_PHASE);

    for (const entry of receipt.stores) {
      const descriptor = PERSISTENT_STORES.find((store) => store.id === entry.id)!;
      expect(entry.opensBeforeFutureCoordinator)
        .toBe(startupPhaseIndex(descriptor.firstPossibleOpenPhase) < coordinatorIndex);
      expect(entry.writesBeforeFutureCoordinator)
        .toBe(startupPhaseIndex(descriptor.firstPossibleWritePhase) < coordinatorIndex);
      expect(entry.breakingMigrationRequiresAccessMove).toBe(
        descriptor.affectedByEpochMigration
          && (startupPhaseIndex(descriptor.firstPossibleOpenPhase) <= coordinatorIndex
            || startupPhaseIndex(descriptor.firstPossibleWritePhase) <= coordinatorIndex),
      );
    }

    const epochStamp = receipt.stores.find((store) => store.id === "data-epoch-stamp")!;
    expect(epochStamp.firstPossibleOpenPhase).toBe("epoch_preflight");
    expect(epochStamp.firstPossibleWritePhase).toBe("epoch_preflight");
    expect(epochStamp.breakingMigrationRequiresAccessMove).toBe(false);
  });

  it("matches the committed deterministic startup receipt", () => {
    const generated = scanPersistentStores({ rootDir: ROOT, today: "2026-07-13" }).startupReceipt;
    const committed = JSON.parse(fs.readFileSync(STARTUP_RECEIPT_PATH, "utf-8"));

    expect(committed).toEqual(generated);
    expect(JSON.stringify(committed)).not.toMatch(/(?:\/Users\/|\/home\/|[A-Za-z]:\\)/);
  });
});

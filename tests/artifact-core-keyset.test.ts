import { createPublicKey } from "crypto";
import { createRequire } from "module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

describe("artifact-core keyset loader", () => {
  it("loads the pinned keyset as an array whose first entry is keyId 2026a", () => {
    const { loadPinnedKeyset } = require("../shared/artifact-core/keyset.cjs");
    const keyset = loadPinnedKeyset();
    expect(Array.isArray(keyset)).toBe(true);
    expect(keyset.length).toBeGreaterThanOrEqual(1);
    expect(keyset[0].keyId).toBe("2026a");
  });

  it("every entry carries a PEM string that parses as an ed25519 public key", () => {
    const { loadPinnedKeyset } = require("../shared/artifact-core/keyset.cjs");
    for (const entry of loadPinnedKeyset()) {
      expect(typeof entry.keyId).toBe("string");
      expect(entry.keyId.length).toBeGreaterThan(0);
      expect(typeof entry.publicKey).toBe("string");
      const keyObject = createPublicKey(entry.publicKey);
      expect(keyObject.asymmetricKeyType).toBe("ed25519");
    }
  });

  it("returns a fresh array per call so callers cannot mutate the pinned source", () => {
    const { loadPinnedKeyset } = require("../shared/artifact-core/keyset.cjs");
    const first = loadPinnedKeyset();
    first.pop();
    const second = loadPinnedKeyset();
    expect(second.length).toBeGreaterThanOrEqual(1);
  });

  it("pinned key matches the recorded 2026a public key bytes exactly", () => {
    const { loadPinnedKeyset } = require("../shared/artifact-core/keyset.cjs");
    const entry = loadPinnedKeyset().find((e: { keyId: string }) => e.keyId === "2026a");
    expect(entry.publicKey).toBe(
      "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEABxlmYzrnEDdrKL7lW+KQsvO5omvy8Wyuj1G3YIs7eFo=\n-----END PUBLIC KEY-----\n",
    );
  });
});

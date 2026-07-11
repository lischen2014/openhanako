import { generateKeyPairSync, sign as cryptoSign } from "crypto";
import { describe, expect, it } from "vitest";

import manifestModule from "../shared/artifact-core/manifest.cjs";

const { parseManifest, validateManifest, verifyManifest, checkMonotonic } = manifestModule as {
  parseManifest: (bytes: Buffer | string) => any;
  validateManifest: (value: unknown) => any;
  verifyManifest: (manifestBytes: Buffer, sigBytes: Buffer, keyset: Array<{ keyId: string; publicKey: string }>) => any;
  checkMonotonic: (manifest: { train: number }, currentTrain: number | null | undefined) => void;
};

function baseManifest(overrides: Record<string, unknown> = {}) {
  return {
    schema: 1,
    train: 412,
    channel: "stable",
    releasedAt: "2026-08-01T12:00:00Z",
    keyId: "2026a",
    minShell: "1.2.0",
    contract: { preload: 3, serverProtocol: 5 },
    urgent: false,
    rollout: { percent: 100, salt: "abc123" },
    artifacts: {
      renderer: {
        version: "0.9.3",
        sha256: "a".repeat(64),
        size: 41234567,
        path: "renderer-0.9.3.tar.gz",
      },
      server: {
        "darwin-arm64": {
          version: "1.4.0",
          sha256: "b".repeat(64),
          size: 12345,
          path: "server-1.4.0-darwin-arm64.tar.gz",
        },
      },
    },
    mirrors: ["https://github.com/liliMozi/openhanako/releases/download/train-412"],
    ...overrides,
  };
}

function makeKeypair(keyId = "2026a") {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return { keyId, publicKey, privateKey, publicPem };
}

function signManifestBytes(manifestBytes: Buffer, privateKey: any): Buffer {
  return cryptoSign(null, manifestBytes, privateKey);
}

describe("manifest: parse/validate", () => {
  it("accepts a well-formed schema-1 manifest", () => {
    const manifest = baseManifest();
    expect(() => validateManifest(manifest)).not.toThrow();
  });

  it("parses canonical JSON bytes", () => {
    const manifest = baseManifest();
    const bytes = Buffer.from(JSON.stringify(manifest), "utf8");
    const parsed = parseManifest(bytes);
    expect(parsed.train).toBe(412);
    expect(parsed.channel).toBe("stable");
  });

  it("rejects an unsupported schema version", () => {
    expect(() => validateManifest(baseManifest({ schema: 2 }))).toThrow(/schema/i);
  });

  it("rejects a non-integer train", () => {
    expect(() => validateManifest(baseManifest({ train: 1.5 }))).toThrow(/train/i);
  });

  it("rejects malformed JSON bytes", () => {
    expect(() => parseManifest(Buffer.from("{not json", "utf8"))).toThrow(/JSON/i);
  });

  it("rejects a server artifact entry with a bad sha256", () => {
    const manifest = baseManifest();
    (manifest.artifacts.server as any)["darwin-arm64"].sha256 = "not-hex";
    expect(() => validateManifest(manifest)).toThrow(/sha256/i);
  });

  // Schema compatibility rule: `artifacts`
  // requires AT LEAST ONE known kind; every present entry is fully
  // validated; an absent kind is legal for legacy server-only seeds.
  it("accepts a server-only manifest (no renderer entry)", () => {
    const manifest = baseManifest();
    delete (manifest.artifacts as any).renderer;
    expect(() => validateManifest(manifest)).not.toThrow();
  });

  it("accepts a renderer-only manifest (no server entry)", () => {
    const manifest = baseManifest();
    delete (manifest.artifacts as any).server;
    expect(() => validateManifest(manifest)).not.toThrow();
  });

  it("rejects an empty artifacts object", () => {
    const manifest = baseManifest({ artifacts: {} });
    expect(() => validateManifest(manifest)).toThrow(/at least one/i);
  });

  it("rejects an unknown artifact kind", () => {
    const manifest = baseManifest();
    (manifest.artifacts as any).firmware = {
      version: "1.0.0",
      sha256: "d".repeat(64),
      size: 1,
      path: "firmware-1.0.0.tar.gz",
    };
    expect(() => validateManifest(manifest)).toThrow(/unknown/i);
  });

  it("rejects a present-but-empty server kind (a kind that is present must carry entries)", () => {
    const manifest = baseManifest();
    (manifest.artifacts as any).server = {};
    expect(() => validateManifest(manifest)).toThrow(/server/i);
  });

  it("still fully validates a renderer entry when it is present", () => {
    const manifest = baseManifest();
    (manifest.artifacts as any).renderer.sha256 = "not-hex";
    expect(() => validateManifest(manifest)).toThrow(/sha256/i);
  });
});

describe("manifest: verifyManifest (ed25519)", () => {
  it("verifies a correctly signed manifest and returns the parsed object", () => {
    const { keyId, privateKey, publicPem } = makeKeypair();
    const manifest = baseManifest({ keyId });
    const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
    const sigBytes = signManifestBytes(manifestBytes, privateKey);

    const result = verifyManifest(manifestBytes, sigBytes, [{ keyId, publicKey: publicPem }]);
    expect(result.train).toBe(412);
  });

  it("rejects a tampered manifest (one byte flipped after signing)", () => {
    const { keyId, privateKey, publicPem } = makeKeypair();
    const manifest = baseManifest({ keyId });
    const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
    const sigBytes = signManifestBytes(manifestBytes, privateKey);

    const tampered = Buffer.from(manifestBytes);
    // Flip one byte within the JSON body (not whitespace) to guarantee a semantic change.
    const flipIdx = tampered.indexOf(Buffer.from("412"));
    tampered[flipIdx] = "4".charCodeAt(0) === tampered[flipIdx] ? "5".charCodeAt(0) : tampered[flipIdx] ^ 0xff;

    expect(() => verifyManifest(tampered, sigBytes, [{ keyId, publicKey: publicPem }])).toThrow(
      /signature verification failed|invalid JSON/i,
    );
  });

  it("rejects a tampered signature (one byte flipped)", () => {
    const { keyId, privateKey, publicPem } = makeKeypair();
    const manifest = baseManifest({ keyId });
    const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
    const sigBytes = signManifestBytes(manifestBytes, privateKey);
    const tamperedSig = Buffer.from(sigBytes);
    tamperedSig[0] ^= 0xff;

    expect(() => verifyManifest(manifestBytes, tamperedSig, [{ keyId, publicKey: publicPem }])).toThrow(
      /signature verification failed/i,
    );
  });

  it("rejects when manifest.keyId is not present in the keyset", () => {
    const { privateKey, publicPem } = makeKeypair("2026a");
    const manifest = baseManifest({ keyId: "2099z" }); // not in keyset below
    const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
    const sigBytes = signManifestBytes(manifestBytes, privateKey);

    expect(() => verifyManifest(manifestBytes, sigBytes, [{ keyId: "2026a", publicKey: publicPem }])).toThrow(
      /keyId.*not present/i,
    );
  });

  it("rejects a signature produced by a different key even with a matching keyId string", () => {
    const legit = makeKeypair("2026a");
    const attacker = makeKeypair("2026a"); // same keyId label, different actual key
    const manifest = baseManifest({ keyId: "2026a" });
    const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
    const sigBytes = signManifestBytes(manifestBytes, attacker.privateKey);

    expect(() =>
      verifyManifest(manifestBytes, sigBytes, [{ keyId: "2026a", publicKey: legit.publicPem }]),
    ).toThrow(/signature verification failed/i);
  });
});

describe("manifest: checkMonotonic (anti-rollback)", () => {
  it("passes when train is strictly greater than current", () => {
    expect(() => checkMonotonic({ train: 413 }, 412)).not.toThrow();
  });

  it("passes when there is no current train yet (seed case)", () => {
    expect(() => checkMonotonic({ train: 0 }, null)).not.toThrow();
    expect(() => checkMonotonic({ train: 0 }, undefined)).not.toThrow();
  });

  it("rejects a train equal to the current train", () => {
    expect(() => checkMonotonic({ train: 412 }, 412)).toThrow(/not greater/i);
  });

  it("rejects a train regression (train less than current)", () => {
    expect(() => checkMonotonic({ train: 400 }, 412)).toThrow(/not greater/i);
  });
});

import contractVersions from "./contract-versions.cjs";

// ESM wrapper so renderer TypeScript imports THIS file instead of the .cjs
// directly — Vite dev never needs to serve raw CommonJS to the browser this
// way. The .cjs remains the actual value source (required by Node-context
// consumers: build scripts, the shell's OTA gate, the server route); this
// file only re-exports the same two constants under the same names, no
// duplicated literals. Mirrors the existing shared/quick-chat-preferences.ts
// / shared/hana-runtime-paths.ts wrapper pattern.
export const { PRELOAD_API_VERSION, SERVER_PROTOCOL_VERSION, DATA_EPOCH } = contractVersions;

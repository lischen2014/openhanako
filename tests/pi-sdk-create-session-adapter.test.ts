import { describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", async () => ({
  createAgentSession: vi.fn(async opts => ({ session: { opts }, modelFallbackMessage: null })),
  SessionManager: { create: vi.fn(), open: vi.fn() },
  SettingsManager: { inMemory: vi.fn() },
  createReadTool: vi.fn(),
  createWriteTool: vi.fn(),
  createEditTool: vi.fn(),
  createBashTool: vi.fn(),
  createGrepTool: vi.fn(),
  createFindTool: vi.fn(),
  createLsTool: vi.fn(),
  DefaultResourceLoader: class {},
  formatSkillsForPrompt: vi.fn(),
  getLastAssistantUsage: vi.fn(),
  AuthStorage: class {},
  estimateTokens: vi.fn(),
  findCutPoint: vi.fn(),
  generateSummary: vi.fn(),
  serializeConversation: vi.fn(),
  shouldCompact: vi.fn(),
  parseSessionEntries: vi.fn(),
  buildSessionContext: vi.fn(),
  ModelRegistry: { create: vi.fn() },
  resizeImage: vi.fn(),
  formatDimensionNote: vi.fn(),
  convertToLlm: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai", async () => ({
  StringEnum: vi.fn(values => values),
  AssistantMessageEventStream: class {},
  createAssistantMessageEventStream: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai/compat", async () => ({
  completeSimple: vi.fn(),
  getModel: vi.fn(),
}));

vi.mock("../lib/pi-sdk/session-options.js", async () => ({
  PI_BUILTIN_TOOL_NAMES: Object.freeze(["read", "write", "edit", "exec_command", "write_stdin", "grep", "find", "ls"]),
  normalizeCreateAgentSessionOptions: vi.fn(opts => ({
    ...opts,
    normalizedByAdapter: true,
  })),
}));

describe("Pi SDK createAgentSession adapter", () => {
  it("normalizes options before calling the raw SDK", async () => {
    const sdk = await import("@earendil-works/pi-coding-agent");
    const adapter = await import("../lib/pi-sdk/index.ts");
    const sessionOptions = {
      cwd: "/tmp/project",
      tools: [{ name: "read", execute: vi.fn() }],
      customTools: [{ name: "web_search", execute: vi.fn() }],
    };

    await adapter.createAgentSession(sessionOptions);

    expect(adapter.PI_BUILTIN_TOOL_NAMES).toEqual(["read", "write", "edit", "exec_command", "write_stdin", "grep", "find", "ls"]);
    expect(sdk.createAgentSession).toHaveBeenCalledWith({
      ...sessionOptions,
      normalizedByAdapter: true,
    });
  });

  it("uses the resource loader agentDir as the SDK agentDir when omitted", async () => {
    const sdk = await import("@earendil-works/pi-coding-agent");
    const adapter = await import("../lib/pi-sdk/index.ts");
    const resourceLoader = { agentDir: "/hana-home/runtime/pi-sdk/resource-loader/agent" };

    await adapter.createAgentSession({
      cwd: "/tmp/project",
      resourceLoader,
    });

    expect(sdk.createAgentSession).toHaveBeenLastCalledWith({
      cwd: "/tmp/project",
      resourceLoader,
      agentDir: "/hana-home/runtime/pi-sdk/resource-loader/agent",
      normalizedByAdapter: true,
    });
  });
});

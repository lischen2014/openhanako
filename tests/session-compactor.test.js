import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  completeSimpleMock,
  convertAgentMessagesToLlmMock,
  prepareCompactionMock,
} = vi.hoisted(() => ({
  completeSimpleMock: vi.fn(),
  convertAgentMessagesToLlmMock: vi.fn(async (messages) => messages),
  prepareCompactionMock: vi.fn(),
}));

vi.mock("../lib/pi-sdk/index.js", () => ({
  completeSimple: completeSimpleMock,
  convertAgentMessagesToLlm: convertAgentMessagesToLlmMock,
  prepareCompaction: prepareCompactionMock,
}));

import {
  buildActiveToolContext,
  compactSessionWithCachePreservation,
  createCachePreservingCompactionResult,
  runCachePreservingCompactionForSession,
} from "../core/session-compactor.js";

describe("session-compactor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    convertAgentMessagesToLlmMock.mockImplementation(async (messages) => messages);
  });

  it("builds active tool context without leaking disabled tools", () => {
    const tools = buildActiveToolContext(["read"], [
      { name: "read", description: "Read files", parameters: { type: "object" }, extra: "ignored" },
      { name: "bash", description: "Run commands", parameters: { type: "object" } },
    ]);

    expect(tools).toEqual([
      { name: "read", description: "Read files", parameters: { type: "object" } },
    ]);
  });

  it("appends an internal compaction instruction and disables tool choice for the summary call", async () => {
    const signal = new AbortController().signal;
    const resultStream = {
      result: vi.fn(async () => ({
        stopReason: "stop",
        content: [{ type: "text", text: " checkpoint summary " }],
      })),
    };
    const streamFn = vi.fn(async () => resultStream);
    const convertToLlm = vi.fn(async (messages) => messages);

    const result = await createCachePreservingCompactionResult({
      preparation: {
        firstKeptEntryId: "entry-keep",
        tokensBefore: 1234,
        settings: { reserveTokens: 1000 },
        fileOps: {
          read: new Set(["/tmp/read.md", "/tmp/edited.md"]),
          written: new Set(["/tmp/written.md"]),
          edited: new Set(["/tmp/edited.md"]),
        },
      },
      model: { id: "model", reasoning: true },
      systemPrompt: "system prompt",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }],
      tools: [{ name: "read", description: "Read files", parameters: { type: "object" } }],
      customInstructions: "focus on decisions",
      signal,
      thinkingLevel: "high",
      streamFn,
      convertToLlm,
    });

    expect(convertToLlm).toHaveBeenCalledOnce();
    expect(streamFn).toHaveBeenCalledOnce();
    const [model, context, options] = streamFn.mock.calls[0];
    expect(model).toEqual({ id: "model", reasoning: true });
    expect(context.systemPrompt).toBe("system prompt");
    expect(context.tools).toEqual([{ name: "read", description: "Read files", parameters: { type: "object" } }]);
    expect(context.messages).toHaveLength(2);
    expect(context.messages[1].role).toBe("user");
    expect(context.messages[1].content[0].text).toContain("Hana cache-preserving compaction");
    expect(context.messages[1].content[0].text).toContain("focus on decisions");
    expect(options).toEqual(expect.objectContaining({
      maxTokens: 800,
      reasoning: "high",
      signal,
      toolChoice: "none",
    }));

    expect(result).toEqual({
      summary: [
        "checkpoint summary",
        "",
        "<read-files>",
        "/tmp/read.md",
        "</read-files>",
        "",
        "<modified-files>",
        "/tmp/edited.md",
        "/tmp/written.md",
        "</modified-files>",
      ].join("\n"),
      firstKeptEntryId: "entry-keep",
      tokensBefore: 1234,
      details: {
        readFiles: ["/tmp/read.md"],
        modifiedFiles: ["/tmp/edited.md", "/tmp/written.md"],
      },
    });
  });

  it("writes cache-preserving compaction results back into the session branch", async () => {
    const preparation = {
      firstKeptEntryId: "entry-keep",
      tokensBefore: 4321,
      settings: { reserveTokens: 2000 },
    };
    const branch = [{ type: "message", id: "entry-old" }, { type: "message", id: "entry-keep" }];
    const compactedMessages = [{ role: "user", content: "after compaction" }];
    prepareCompactionMock.mockReturnValue(preparation);

    const appendCompaction = vi.fn();
    const replaceMessages = vi.fn();
    const session = {
      model: { id: "model", reasoning: false },
      settingsManager: {
        getCompactionSettings: vi.fn(() => ({ enabled: true, reserveTokens: 2000 })),
      },
      sessionManager: {
        getBranch: vi.fn(() => branch),
        appendCompaction,
        buildSessionContext: vi.fn(() => ({ messages: compactedMessages })),
      },
      agent: {
        state: {
          systemPrompt: "system prompt",
          messages: [{ role: "user", content: "before compaction" }],
          tools: [],
          thinkingLevel: "off",
        },
        transformContext: vi.fn(async (messages) => [
          ...messages,
          { role: "assistant", content: "latest streamed answer" },
        ]),
        streamFn: vi.fn(async () => ({
          result: vi.fn(async () => ({
            stopReason: "stop",
            content: [{ type: "text", text: "cache summary" }],
          })),
        })),
        convertToLlm: vi.fn(async (messages) => messages),
        replaceMessages,
      },
    };

    const result = await runCachePreservingCompactionForSession(session);

    expect(prepareCompactionMock).toHaveBeenCalledWith(branch, { enabled: true, reserveTokens: 2000 });
    expect(session.agent.transformContext).toHaveBeenCalledWith(
      [{ role: "user", content: "before compaction" }],
      undefined,
    );
    expect(appendCompaction).toHaveBeenCalledWith(
      "cache summary",
      "entry-keep",
      4321,
      { readFiles: [], modifiedFiles: [] },
      true,
    );
    expect(replaceMessages).toHaveBeenCalledWith(compactedMessages);
    expect(result.summary).toBe("cache summary");
  });

  it("refuses the manual wrapper when the compaction hook is missing", async () => {
    const session = {
      compact: vi.fn(),
      extensionRunner: { hasHandlers: vi.fn(() => false) },
    };

    await expect(compactSessionWithCachePreservation(session)).rejects.toThrow(
      "Cache-preserving compaction extension is not installed",
    );
    expect(session.compact).not.toHaveBeenCalled();
  });

  it("keeps Pi lifecycle events by delegating manual compaction through session.compact", async () => {
    const session = {
      compact: vi.fn(async () => "ok"),
      extensionRunner: { hasHandlers: vi.fn(() => true) },
    };

    await expect(compactSessionWithCachePreservation(session, "extra focus")).resolves.toBe("ok");
    expect(session.compact).toHaveBeenCalledWith("extra focus");
  });
});

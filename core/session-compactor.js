import {
  completeSimple,
  convertAgentMessagesToLlm,
  prepareCompaction,
} from "../lib/pi-sdk/index.js";

const COMPACTION_REQUEST_PREFIX = `[Hana cache-preserving compaction]

You are performing an internal context compaction for this same assistant session.
The full conversation prefix above is the source of truth. Do not answer the user
or continue the task. Produce only a structured checkpoint summary that a future
turn can use after older history is replaced by this summary.

Use this exact format:

## Goal
[What the user is trying to accomplish.]

## Constraints & Preferences
- [Important user constraints, project rules, tone preferences, or "(none)".]

## Progress
### Done
- [x] [Completed work]

### In Progress
- [ ] [Current unfinished work]

### Blocked
- [Blockers, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Concrete next step]

## Critical Context
- [Exact file paths, commands, errors, identifiers, dates, issue links, or facts needed to continue.]

Keep it concise, but preserve technical facts exactly. If recent messages will be
kept by the compactor, summarize them only when they clarify the older context.`;

function textBlock(text) {
  return { type: "text", text };
}

export function buildCachePreservingCompactionInstruction({ preparation, customInstructions } = {}) {
  const retainedNote = preparation?.firstKeptEntryId
    ? `\n\nThe compactor will keep the recent tail starting at session entry id ${preparation.firstKeptEntryId}. Focus the summary on context that may be removed, while preserving current intent and decisions.`
    : "";
  const splitTurnNote = preparation?.isSplitTurn
    ? "\n\nThe cut point is inside a turn. Include enough turn-prefix context for the retained suffix to make sense."
    : "";
  const customNote = customInstructions
    ? `\n\nAdditional focus from the caller: ${customInstructions}`
    : "";

  return {
    role: "user",
    content: [textBlock(`${COMPACTION_REQUEST_PREFIX}${retainedNote}${splitTurnNote}${customNote}`)],
    timestamp: Date.now(),
  };
}

function computeFileDetails(fileOps) {
  const read = fileOps?.read instanceof Set ? fileOps.read : new Set(fileOps?.read || []);
  const written = fileOps?.written instanceof Set ? fileOps.written : new Set(fileOps?.written || []);
  const edited = fileOps?.edited instanceof Set ? fileOps.edited : new Set(fileOps?.edited || []);
  const modified = new Set([...edited, ...written]);
  return {
    readFiles: [...read].filter((file) => !modified.has(file)).sort(),
    modifiedFiles: [...modified].sort(),
  };
}

function appendFileOperationContext(summary, details) {
  const sections = [];
  if (details.readFiles.length > 0) {
    sections.push(`<read-files>\n${details.readFiles.join("\n")}\n</read-files>`);
  }
  if (details.modifiedFiles.length > 0) {
    sections.push(`<modified-files>\n${details.modifiedFiles.join("\n")}\n</modified-files>`);
  }
  if (sections.length === 0) return summary;
  return `${summary.trimEnd()}\n\n${sections.join("\n\n")}`;
}

function extractSummaryText(response) {
  return response?.content
    ?.filter((block) => block?.type === "text" && typeof block.text === "string")
    ?.map((block) => block.text)
    ?.join("\n")
    ?.trim();
}

function isErrorResponse(response) {
  return response?.stopReason === "error" || response?.stopReason === "aborted";
}

export function buildActiveToolContext(activeToolNames = [], allTools = []) {
  const active = new Set(activeToolNames);
  return allTools
    .filter((tool) => active.has(tool?.name))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
}

export async function createCachePreservingCompactionResult({
  preparation,
  model,
  systemPrompt,
  messages,
  tools = [],
  customInstructions,
  signal,
  thinkingLevel,
  streamFn,
  streamOptions = {},
  convertToLlm = convertAgentMessagesToLlm,
}) {
  if (!preparation) throw new Error("Cache-preserving compaction requires preparation");
  if (!model) throw new Error("Cache-preserving compaction requires a model");
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("Cache-preserving compaction requires conversation messages");
  }

  const instruction = buildCachePreservingCompactionInstruction({ preparation, customInstructions });
  const agentMessages = [...messages, instruction];
  const llmMessages = await convertToLlm(agentMessages);
  const maxTokens = Math.max(512, Math.floor((preparation.settings?.reserveTokens ?? 4096) * 0.8));
  const options = {
    ...streamOptions,
    maxTokens,
    signal,
    toolChoice: "none",
    ...(model.reasoning && thinkingLevel && thinkingLevel !== "off" ? { reasoning: thinkingLevel } : {}),
  };

  const context = {
    systemPrompt,
    messages: llmMessages,
    ...(tools?.length ? { tools } : {}),
  };
  const response = streamFn
    ? await (await streamFn(model, context, options)).result()
    : await completeSimple(model, context, options);

  if (isErrorResponse(response)) {
    throw new Error(`Cache-preserving compaction failed: ${response.errorMessage || response.stopReason || "unknown error"}`);
  }

  const text = extractSummaryText(response);
  if (!text) {
    throw new Error("Cache-preserving compaction failed: empty summary");
  }

  const details = computeFileDetails(preparation.fileOps);
  return {
    summary: appendFileOperationContext(text, details),
    firstKeptEntryId: preparation.firstKeptEntryId,
    tokensBefore: preparation.tokensBefore,
    details,
  };
}

function replaceSessionMessages(session) {
  const context = session.sessionManager.buildSessionContext();
  if (session.agent?.replaceMessages) {
    session.agent.replaceMessages(context.messages);
  } else if (session.agent?.state) {
    session.agent.state.messages = context.messages;
  }
}

export async function runCachePreservingCompactionForSession(session, {
  settings,
  model = session?.model,
  customInstructions,
  signal,
} = {}) {
  if (!session?.sessionManager) throw new Error("runCachePreservingCompactionForSession: missing session manager");
  if (!session?.agent) throw new Error("runCachePreservingCompactionForSession: missing agent");
  if (!model) throw new Error("runCachePreservingCompactionForSession: missing model");

  const compactionSettings = settings || session.settingsManager?.getCompactionSettings?.();
  if (!compactionSettings) throw new Error("runCachePreservingCompactionForSession: missing compaction settings");

  const branchEntries = session.sessionManager.getBranch();
  const preparation = prepareCompaction(branchEntries, compactionSettings);
  if (!preparation) {
    const lastEntry = branchEntries[branchEntries.length - 1];
    if (lastEntry?.type === "compaction") throw new Error("Already compacted");
    throw new Error("Nothing to compact (session too small)");
  }

  let messages = session.agent.state?.messages?.length
    ? session.agent.state.messages
    : session.sessionManager.buildSessionContext().messages;
  if (session.agent.transformContext) {
    messages = await session.agent.transformContext(messages, signal);
  }

  const result = await createCachePreservingCompactionResult({
    preparation,
    model,
    systemPrompt: session.agent.state?.systemPrompt ?? session.systemPrompt,
    messages,
    tools: session.agent.state?.tools || [],
    customInstructions,
    signal,
    thinkingLevel: session.thinkingLevel ?? session.agent.state?.thinkingLevel,
    streamFn: session.agent.streamFn,
    streamOptions: {
      sessionId: session.agent.sessionId,
      onPayload: session.agent.onPayload,
      onResponse: session.agent.onResponse,
      transport: session.agent.transport,
      thinkingBudgets: session.agent.thinkingBudgets,
      maxRetryDelayMs: session.agent.maxRetryDelayMs,
    },
    convertToLlm: session.agent.convertToLlm,
  });

  session.sessionManager.appendCompaction(
    result.summary,
    result.firstKeptEntryId,
    result.tokensBefore,
    result.details,
    true,
  );
  replaceSessionMessages(session);
  return result;
}

export async function compactSessionWithCachePreservation(session, customInstructions) {
  if (!session?.extensionRunner?.hasHandlers?.("session_before_compact")) {
    throw new Error("Cache-preserving compaction extension is not installed for this session");
  }
  return await session.compact(customInstructions);
}

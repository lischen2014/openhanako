/**
 * compile.js — 记忆编译器（v4：按天滚动传送带 + assemble）
 *
 * compileToday()         → today.md（当天 sessions）
 * compileDaily()         → memory/daily/{date}.md（已结束那天的两三句话日记，独立指纹缓存）
 * assembleWeekFromDaily() → week.md（纯文件装配最近 6-7 天的日记条目，零 LLM）
 * rollDailyWindow()      → 把滚出窗口的 daily 条目 fold 进 longterm.md 后删除源文件
 * compileLongterm()      → longterm.md（fold 任意内容到长期，被 rollDailyWindow /
 *                          migrateLegacyWeekToLongterm 复用的通用入口）
 * migrateLegacyWeekToLongterm() → 一次性、幂等地把旧 week.md 整段 fold 进 longterm
 * compileEditableFacts() → facts.md（重要事实，增量编译 + 水位线跟踪，唯一路径）
 *
 * 传送带：session 摘要 → compileDaily → assembleWeekFromDaily → rollDailyWindow → longterm。
 * assemble() 同步读取四个文件，拼成 memory.md（≤2000 token）。
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { getLogicalDay, getLogicalDayForDate, shiftLogicalDate } from "../time-utils.ts";
import { callText } from "../../core/llm-client.ts";
import { getLocale } from "../i18n.ts";
import { atomicWriteSync, safeReadFile } from "../../shared/safe-fs.ts";
import { normalizeCompiledLLMResult, normalizeCompiledSectionBody } from "./compiled-memory-state.ts";
import { attachPromptLayoutMetadata, buildUtilityPromptLayout } from "../llm/prompt-layout.ts";
import {
  buildCompileDailyPrompt,
  buildCompileEditableFactsPrompt,
  buildCompileLongtermPrompt,
  buildCompileTodayPrompt,
} from "./prompts/compile.ts";
import { withMemoryReasoningBuffer } from "./llm-budget.ts";
import {
  FACT_SECTION_TITLES,
  extractFactSection,
  hasFactSectionHeading,
  isEmptyFactSection,
} from "./rolling-summary-format.ts";
import { createModuleLogger } from "../debug-log.ts";

const log = createModuleLogger("memory-compile");

function _isZh() { return getLocale().startsWith("zh"); }

const EMPTY_MEMORY_ZH = "（暂无记忆）\n";
const EMPTY_MEMORY_EN = "(No memory yet)\n";
export function getEmptyMemory() { return _isZh() ? EMPTY_MEMORY_ZH : EMPTY_MEMORY_EN; }

// editable-facts-state.json 只做增量编译水位线跟踪，与产物文件名（facts.md）解耦。
export const EDITABLE_FACTS_STATE_FILE = "editable-facts-state.json";

// daily 传送带默认参数：week 段展示最近 7 天，超过这个天数的条目 fold 进 longterm 后删除。
export const DAILY_WINDOW_RETENTION_DAYS = 7;
// week.md 硬性总长上限（字符数）：7 条 daily（单条极紧的 budget）加合理结构开销后的总量级，
// 与被取代的 LLM week 段体量大致相当。
export const WEEK_ASSEMBLY_MAX_CHARS = 1200;
const DAILY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.md$/;

const COMPILE_PROMPT_BUILDERS = {
  compile_today: buildCompileTodayPrompt,
  compile_daily: buildCompileDailyPrompt,
  compile_longterm: buildCompileLongtermPrompt,
  compile_editable_facts: buildCompileEditableFactsPrompt,
};

// ════════════════════════════
//  v4 传送带：daily 编译 + week 装配 + 滚动 fold + assemble
// ════════════════════════════

/**
 * 编译今天的 session 摘要 → today.md
 * @param {import('./session-summary.ts').SessionSummaryManager} summaryManager
 * @param {string} outputPath
 * @param {{ model: string, api: string, api_key: string, base_url: string }} resolvedModel
 * @returns {Promise<"compiled"|"skipped">}
 */
export async function compileToday(summaryManager, outputPath, resolvedModel, opts: { since?: any } = {}) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const { rangeStart } = getLogicalDay();
  const sessions = summaryManager.getSummariesInRange(rangeStart, new Date(), { since: opts.since || null });
  const fpPath = outputPath + ".fingerprint";

  // 空 sessions 不写 fingerprint：rollingSummary 失败期会让 sessions 持续为空，
  // 若落下 "empty" 指纹，之后 summary 恢复前该指纹仍会命中（因为下一次也是 empty），
  // 导致 today.md 永远卡在 0 bytes。只在有真实 session 摘要时用 fingerprint 去重。
  if (sessions.length === 0) {
    try { fs.unlinkSync(fpPath); } catch {}
    const cur = safeReadFile(outputPath, "");
    if (cur.length > 0) atomicWrite(outputPath, "");
    return "compiled";
  }

  const fpKeys = sessions.map((s) => `${s.session_id}:${s.updated_at}`);
  const fp = computeFingerprint(fpKeys);
  try {
    if (fs.readFileSync(fpPath, "utf-8").trim() === fp && fs.existsSync(outputPath)) return "skipped";
  } catch {}

  const input = sessions.map((s) => s.summary).join("\n\n---\n\n");
  const isZh = _isZh();
  const result = await _compactLLM(
    input,
    isZh
      ? `请把今天的对话摘要整理成一份"用户近况与大主题清单"。

提炼原则：
- 把同一主题/项目的多次往返归并为一件事，不要逐条流水账
- 时间标注用主时段（"上午/傍晚"或粗略 HH:MM 区间），不需精确到分钟
- 记忆的核心职责是维护用户模型，优先记录用户是谁、喜欢什么、在意什么、最近关注什么
- 工作相关内容只允许保留到大主题层级：只写用户最近关注的领域/项目/主题，不写该主题里的细节

可以记录：
- 用户的身份、人格特质、审美、兴趣、喜欢或讨厌的事物
- 用户最近关注的大主题，例如"记忆系统""Project Hana""AI Agent"
- 用户生活、创作、关系或长期关注方向的变化

不要记录：
- 不要记录执行步骤、文件名、工具、命令、检查顺序、协作偏好、工作细节
- 任务过程中的方法论选择、工具偏好、格式要求、术语规则
- 具体子问题、具体方案、具体改法、具体测试或发布流程
- 助手具体产出的内容（"生成了一篇关于 X 的文章"够了，不要摘录文章内容）
- 来回修改、重试、被打断又恢复这类过程波动

输出 3-5 条粗颗粒事件，每条 1-2 句。最多 300 字。一天平淡就写得短。不要输出 Markdown 标题，不要以 #、##、### 开头；直接输出正文列表或段落。`
      : `Distill today's conversation summaries into a "user-current-state and broad-theme list".

Principles:
- Merge multiple back-and-forth on the same topic/project into ONE event; do not enumerate line by line
- Time markers use major periods ("morning/evening" or rough HH:MM range), no minute-level precision
- Memory's core job is to maintain a user model: prioritize who the user is, what they like, what they care about, and what they are broadly focused on recently
- Work-related content may only be kept at the broad-theme level: record the domain/project/theme, not details inside that theme

May record:
- The user's identity, personality traits, aesthetics, interests, likes, and dislikes
- Broad themes the user is currently focused on, such as "memory systems", "Project Hana", or "AI Agent"
- Changes in the user's life, creative work, relationships, or long-term areas of attention

Do NOT record:
- Execution steps, filenames, tools, commands, validation order, collaboration preferences, or work details
- Task-level methodology choices, tool preferences, format requirements, terminology rules
- Specific subproblems, concrete solutions, concrete code changes, tests, or release flows
- Specific content of assistant's output ("wrote an article about X" is enough; do not excerpt the article)
- Revisions, retries, interruptions and resumptions — these are process noise

Output 3-5 coarse events, 1-2 sentences each. Max 180 words. Keep it short on quiet days. Do not output Markdown headings. Do not start with #, ##, or ###; output body text only.`,
    resolvedModel,
    450,
    "compile_today",
  );

  atomicWrite(outputPath, normalizeCompiledLLMResult(result, "compileToday"));
  fs.writeFileSync(fpPath, fp);
  return "compiled";
}

/**
 * 编译已结束那天的 session 摘要 → memory/daily/{logicalDate}.md
 *
 * 与 compileToday 的关键区别：compileToday 编译"当天进行中"的摘要，每次新摘要
 * 出现都可能重跑；compileDaily 编译"已经翻篇的那天"，一天只落一次盘（除非当天
 * 摘要事后发生变化，此时按 fingerprint 重新覆盖，不追加）。
 *
 * 当天没有任何摘要时不产文件（零占位），避免 daily/ 目录被大量空文件污染。
 *
 * @param {import('./session-summary.ts').SessionSummaryManager} summaryManager
 * @param {string} dailyDir - memory/daily 目录
 * @param {string} logicalDate - YYYY-MM-DD，要编译的那个逻辑日
 * @param {object} resolvedModel
 * @returns {Promise<"compiled"|"skipped">}
 */
export async function compileDaily(summaryManager, dailyDir, logicalDate, resolvedModel, opts: { since?: any } = {}) {
  fs.mkdirSync(dailyDir, { recursive: true });

  const { rangeStart, rangeEnd } = getLogicalDayForDate(logicalDate);
  const sessions = summaryManager.getSummariesInRange(rangeStart, rangeEnd, { since: opts.since || null });
  const outputPath = path.join(dailyDir, `${logicalDate}.md`);
  const fpPath = outputPath + ".fingerprint";

  if (sessions.length === 0) {
    // 零占位：当天确实没有摘要就不落文件；同时清掉可能存在的旧指纹，
    // 避免摘要之后补齐时被过期指纹挡住（理由同 compileToday 的空 sessions 分支）。
    try { fs.unlinkSync(fpPath); } catch {}
    return "skipped";
  }

  const fpKeys = sessions.map((s) => `${s.session_id}:${s.updated_at}`);
  const fp = computeFingerprint(fpKeys);
  try {
    if (fs.readFileSync(fpPath, "utf-8").trim() === fp && fs.existsSync(outputPath)) return "skipped";
  } catch {}

  const input = sessions.map((s) => s.summary).join("\n\n---\n\n");
  const promptSpec = buildCompileDailyPrompt(getLocale());
  const result = await _compactLLM(
    input,
    promptSpec,
    resolvedModel,
    // week 段过去是 600 tokens／7 条 ≈ 85/条；daily 单条 budget 从紧，
    // 保证 7 条装配起来的总量不超过原 week 段体量。
    100,
    "compile_daily",
  );

  const body = normalizeCompiledLLMResult(result, "compileDaily");
  atomicWrite(outputPath, body ? `## ${logicalDate}\n\n${body}\n` : "");
  fs.writeFileSync(fpPath, fp);
  return "compiled";
}

function _listDailyEntries(dailyDir) {
  let names;
  try {
    names = fs.readdirSync(dailyDir);
  } catch {
    return [];
  }
  return names
    .map((name) => name.match(DAILY_FILE_RE))
    .filter(Boolean)
    .map((match) => ({ date: match[1], filePath: path.join(dailyDir, match[0]) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 从 memory/daily/ 目录纯文件装配 week.md：取最近 N 天的日记条目按日期正序
 * 拼接。零 LLM 调用——week 段不再是独立编译产物，而是 daily 条目的滚动列表。
 *
 * 总长超过硬上限时从最老的条目开始截断，并显式 log（不静默丢弃）。
 *
 * @param {string} dailyDir
 * @param {string} weekPath
 * @param {{ maxDays?: number, maxChars?: number }} [opts]
 */
export function assembleWeekFromDaily(dailyDir, weekPath, opts: { maxDays?: number; maxChars?: number } = {}) {
  const maxDays = opts.maxDays || DAILY_WINDOW_RETENTION_DAYS;
  const maxChars = opts.maxChars || WEEK_ASSEMBLY_MAX_CHARS;

  const entries = _listDailyEntries(dailyDir).slice(-maxDays);
  const blocks = entries.map(({ filePath }) => safeReadFile(filePath, "").trim()).filter(Boolean);

  let content = blocks.join("\n\n");
  if (content.length > maxChars) {
    // 从最老的条目（数组开头）开始丢，直到总长回到上限内。
    const kept = [...blocks];
    while (kept.length > 1 && kept.join("\n\n").length > maxChars) {
      kept.shift();
    }
    content = kept.join("\n\n");
    // 仅剩一条也超限：保留头部（含日期抬头），从尾部截断，而不是丢掉日期标识。
    if (content.length > maxChars) content = content.slice(0, maxChars);
    log.warn(`assembleWeekFromDaily: 总长超过上限（${maxChars} 字），已从最老条目开始截断`);
  }

  atomicWrite(weekPath, content ? `${content}\n` : "");
}

/**
 * 把滚出 N 日窗口的 daily 条目 fold 进 longterm.md，成功后删除源文件；
 * 失败的条目保留在 daily/ 目录，交给下一轮重试，不静默丢弃。
 *
 * @param {string} dailyDir
 * @param {string} longtermPath
 * @param {object} resolvedModel
 * @param {{ referenceDate?: string, retentionDays?: number }} [opts]
 * @returns {Promise<{ folded: string[], failed: string[] }>}
 */
export async function rollDailyWindow(dailyDir, longtermPath, resolvedModel, opts: { referenceDate?: string; retentionDays?: number } = {}) {
  const retentionDays = opts.retentionDays || DAILY_WINDOW_RETENTION_DAYS;
  const referenceDate = opts.referenceDate || getLogicalDay().logicalDate;
  const cutoffDate = shiftLogicalDate(referenceDate, -retentionDays);

  const entries = _listDailyEntries(dailyDir).filter(({ date }) => date < cutoffDate);
  if (entries.length === 0) return { folded: [], failed: [] };

  const combined = entries
    .map(({ date, filePath }) => {
      const body = safeReadFile(filePath, "").trim();
      return body ? `## ${date}\n\n${body}` : "";
    })
    .filter(Boolean)
    .join("\n\n");

  if (!combined) {
    // 全是空文件：直接清掉，不必调用 LLM。
    for (const { filePath } of entries) removeFileIfExists(filePath);
    return { folded: entries.map((e) => e.date), failed: [] };
  }

  try {
    // combined 非空，compileLongterm 只会返回 "compiled" 或因 fingerprint 命中返回
    // "skipped"——两种情况都意味着这批内容已经安全落在 longterm 里，可以删源文件。
    await compileLongterm(combined, longtermPath, resolvedModel);
    for (const { filePath } of entries) removeFileIfExists(filePath);
    return { folded: entries.map((e) => e.date), failed: [] };
  } catch (err) {
    log.error(`rollDailyWindow: fold 进 longterm 失败，保留 ${entries.length} 份 daily 条目待下轮重试: ${err.message}`);
    return { folded: [], failed: entries.map((e) => e.date) };
  }
}

/**
 * 将任意内容 fold 进 longterm.md（每日一次，指纹按内容去重）。
 *
 * 通用 fold 入口：被 rollDailyWindow（滚出窗口的 daily 条目）和
 * migrateLegacyWeekToLongterm（旧 week.md 一次性迁移）共用。
 *
 * @param {string} content - 待吸收的原始内容（调用方已读好的文本，不是文件路径）
 * @param {string} longtermPath
 * @param {object} resolvedModel
 * @returns {Promise<"compiled"|"skipped">}
 */
export async function compileLongterm(content, longtermPath, resolvedModel) {
  fs.mkdirSync(path.dirname(longtermPath), { recursive: true });

  const newContent = String(content || "").trim();
  if (!newContent) return "skipped";

  // fingerprint：内容没变就跳过，避免同一批内容被反复折叠
  const fp = computeFingerprint([newContent]);
  const fpPath = longtermPath + ".fingerprint";
  try {
    if (fs.readFileSync(fpPath, "utf-8").trim() === fp && fs.existsSync(longtermPath)) return "skipped";
  } catch {}

  const prevLongterm = safeReadFile(longtermPath, "").trim();

  const isZh = _isZh();
  const input = prevLongterm
    ? (isZh
        ? `## 上一份长期情况\n\n${prevLongterm}\n\n## 新沉淀内容\n\n${newContent}`
        : `## Previous long-term context\n\n${prevLongterm}\n\n## Newly settled content\n\n${newContent}`)
    : (isZh
        ? `## 新沉淀内容\n\n${newContent}`
        : `## Newly settled content\n\n${newContent}`);

  const result = await _compactLLM(
    input,
    buildCompileLongtermPrompt(getLocale()),
    resolvedModel,
    600,
    "compile_longterm",
  );

  atomicWrite(longtermPath, normalizeCompiledLLMResult(result, "compileLongterm"));
  fs.writeFileSync(fpPath, fp);
  return "compiled";
}

/**
 * 一次性、幂等的读时迁移：旧版按周编译的 week.md 无法按日拆分，整段 fold 进
 * longterm 一次，随后把 week.md 更名为 .migrated.bak 防止重复迁移。
 * daily 传送带自迁移日起独立积累，不回填迁移前的历史。
 *
 * 三种现场：
 *   1. week.md 不存在（从未迁移过 / 已迁移过）：no-op。
 *   2. week.md 存在且非空：fold 进 longterm，成功后更名为 .migrated.bak。
 *   3. week.md 存在但为空：没有内容可 fold，直接更名，不调用 LLM。
 *
 * @param {string} memoryDir
 * @param {string} longtermPath
 * @param {object} resolvedModel
 * @returns {Promise<{ migrated: boolean }>}
 */
export async function migrateLegacyWeekToLongterm(memoryDir, longtermPath, resolvedModel) {
  const weekPath = path.join(memoryDir, "week.md");
  if (!fs.existsSync(weekPath)) return { migrated: false };

  const weekContent = safeReadFile(weekPath, "").trim();
  if (weekContent) {
    await compileLongterm(weekContent, longtermPath, resolvedModel);
  }

  const backupPath = `${weekPath}.migrated.bak`;
  atomicWrite(backupPath, weekContent);
  removeFileIfExists(weekPath);
  return { migrated: true };
}

export function editableFactsStatePath(memoryDir) {
  return path.join(memoryDir, EDITABLE_FACTS_STATE_FILE);
}

export function readEditableFactsText(memoryDir) {
  return normalizeCompiledSectionBody(safeReadFile(path.join(memoryDir, "facts.md"), ""));
}

export function readCompiledMemorySections(memoryDir, opts: Record<string, any> = {}) {
  ensureEditableFactsBaseline(memoryDir, opts.summaryManager || null, {});
  return {
    facts: normalizeCompiledSectionBody(safeReadFile(path.join(memoryDir, "facts.md"), "")),
    today: normalizeCompiledSectionBody(safeReadFile(path.join(memoryDir, "today.md"), "")),
    week: normalizeCompiledSectionBody(safeReadFile(path.join(memoryDir, "week.md"), "")),
    longterm: normalizeCompiledSectionBody(safeReadFile(path.join(memoryDir, "longterm.md"), "")),
  };
}

export function writeEditableFactsSection(memoryDir, facts, opts: Record<string, any> = {}) {
  ensureEditableFactsBaseline(memoryDir, opts.summaryManager || null, {});
  const targetPath = path.join(memoryDir, "facts.md");
  const normalizedFacts = normalizeCompiledSectionBody(String(facts ?? ""));
  atomicWrite(targetPath, normalizedFacts ? `${normalizedFacts}\n` : "");
  assemble(
    targetPath,
    path.join(memoryDir, "today.md"),
    path.join(memoryDir, "week.md"),
    path.join(memoryDir, "longterm.md"),
    opts.memoryMdPath || path.join(memoryDir, "memory.md"),
  );
  return normalizedFacts;
}

/**
 * 确保 facts.md 存在，并在增量编译状态文件里补上首次水位线，避免把已经
 * 沉淀过的旧摘要重新计入下一次 compileEditableFacts。
 * facts.md 转正后，输出目标与继承来源是同一份文件，因此这里不再需要
 * "从别的文件种子拷贝"这一步，只保留文件存在性兜底 + 水位线回填。
 *
 * 注意：这里不内嵌 migrateLegacyEditableFacts——本函数接受任意 outputPath
 * （调用方可以传自定义路径用于测试/一次性场景），把迁移收在这里会在
 * outputPath 不是规范 facts.md 时误伤。迁移改为在真正触达 facts.md 的入口显式
 * 调用：memory-ticker 创建时、REST 路由 /memories/compiled 读写、
 * update-settings-tool 的 memory.facts get/apply（见各调用点注释）。
 */
export function ensureEditableFactsBaseline(memoryDir, summaryManager = null, opts: Record<string, any> = {}) {
  fs.mkdirSync(memoryDir, { recursive: true });
  const outputPath = opts.outputPath || path.join(memoryDir, "facts.md");
  const statePath = opts.statePath || editableFactsStatePath(memoryDir);
  const summaries = opts.summaries || getAllSummariesForFacts(summaryManager);
  const latestSummaryUpdatedAt = latestSummaryUpdate(summaries);
  let changed = false;

  if (!fs.existsSync(outputPath)) {
    atomicWrite(outputPath, "");
    changed = true;
  }

  const state = readEditableFactsState(statePath);
  if (!state.lastCompiledSummaryUpdatedAt && latestSummaryUpdatedAt) {
    writeEditableFactsState(statePath, latestSummaryUpdatedAt);
    changed = true;
  }

  return { changed, latestSummaryUpdatedAt };
}

/**
 * 一次性、幂等的读时迁移：把 alpha 阶段遗留的 editable-facts.md 并入
 * 规范产物 facts.md。
 *
 * 三种现场：
 *   1. 只有旧 facts.md（或都没有）：facts.md 已经是规范产物，不动。
 *   2. 只有 editable-facts.md：直接更名为 facts.md。
 *   3. 两者共存：以 editable-facts.md 为主体，把旧 facts.md 里未出现过的
 *      条目（按行做宽松文本去重）并入末尾，写出新 facts.md；旧两份各自
 *      留一份 .bak 快照。
 *
 * 幂等性：迁移完成后 editable-facts.md 会被移走（改名为 .bak 或删除），
 * 所以重复调用会直接落到"只有 facts.md"分支，不会重复并入。
 */
export function migrateLegacyEditableFacts(memoryDir) {
  const legacyEditablePath = path.join(memoryDir, "editable-facts.md");
  const canonicalFactsPath = path.join(memoryDir, "facts.md");

  if (!fs.existsSync(legacyEditablePath)) {
    return { migrated: false, reason: "no-legacy-file" };
  }

  const editableContent = safeReadFile(legacyEditablePath, "");
  const hasCanonical = fs.existsSync(canonicalFactsPath);
  const canonicalContent = hasCanonical ? safeReadFile(canonicalFactsPath, "") : "";

  const merged = hasCanonical
    ? mergeFactsEntries(editableContent, canonicalContent)
    : editableContent;

  if (hasCanonical) {
    atomicWrite(`${canonicalFactsPath}.bak`, canonicalContent);
  }
  atomicWrite(`${legacyEditablePath}.bak`, editableContent);
  atomicWrite(canonicalFactsPath, merged);
  removeFileIfExists(legacyEditablePath);

  return { migrated: true, reason: hasCanonical ? "merged" : "renamed" };
}

/**
 * 条目级（按行）去重合并：以 primary（editable-facts.md）为主体，
 * 把 secondary（旧 facts.md）里未曾出现过的非空行追加到末尾。
 * 语义判断从宽：trim 后的整行文本相等即视为重复，不调用 LLM。
 */
function mergeFactsEntries(primary, secondary) {
  const primaryText = normalizeCompiledSectionBody(primary);
  const secondaryText = normalizeCompiledSectionBody(secondary);
  if (!secondaryText) return primaryText;
  if (!primaryText) return secondaryText;

  const seen = new Set(
    primaryText.split(/\r?\n/).map((line) => normalizeFactLineForDedup(line)).filter(Boolean),
  );
  const extraLines = secondaryText
    .split(/\r?\n/)
    .filter((line) => {
      const key = normalizeFactLineForDedup(line);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  if (extraLines.length === 0) return primaryText;
  return [primaryText, ...extraLines].join("\n");
}

function normalizeFactLineForDedup(line) {
  return String(line || "").trim().replace(/^[-*]\s+/, "").toLowerCase();
}

function removeFileIfExists(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
}

export async function compileEditableFacts(summaryManager, outputPath, resolvedModel, opts: Record<string, any> = {}) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const statePath = opts.statePath || path.join(path.dirname(outputPath), EDITABLE_FACTS_STATE_FILE);
  const summaries = getAllSummariesForFacts(summaryManager);
  const baseline = ensureEditableFactsBaseline(path.dirname(outputPath), summaryManager, {
    ...opts,
    outputPath,
    statePath,
    summaries,
  });
  if (baseline.changed) return "compiled";

  const state = readEditableFactsState(statePath);
  const since = latestIso(state.lastCompiledSummaryUpdatedAt, opts.since || null);
  const sessions = summaries.filter((s) => {
    const updated = s?.updated_at || s?.created_at || "";
    return updated && (!since || updated > since);
  });
  if (sessions.length === 0) return "skipped";

  const factParts = [];
  const skippedSessionIds = [];
  for (const s of sessions) {
    if (!s.summary) continue;
    if (!hasFactSectionHeading(s.summary)) {
      skippedSessionIds.push(s.session_id);
      continue;
    }
    const text = extractFactSection(s.summary);
    if (text && !isEmptyFactSection(text)) factParts.push(text);
  }
  if (skippedSessionIds.length > 0) {
    log.warn(`compileEditableFacts: ${skippedSessionIds.length} 份摘要缺少 ${FACT_SECTION_TITLES.join("/")} 标题段，已跳过: ${skippedSessionIds.join(", ")}`);
  }

  const nextWatermark = latestSummaryUpdate(sessions);
  if (factParts.length === 0) {
    if (nextWatermark) writeEditableFactsState(statePath, nextWatermark);
    return "compiled";
  }

  const prevFacts = normalizeCompiledSectionBody(safeReadFile(outputPath, ""));
  const newFacts = factParts.join("\n");
  const isZh = _isZh();
  const combined = prevFacts
    ? (isZh
        ? `## 当前可信 Facts\n\n${prevFacts}\n\n## 新增候选 Facts\n\n${newFacts}`
        : `## Current Trusted Facts\n\n${prevFacts}\n\n## New Candidate Facts\n\n${newFacts}`)
    : (isZh
        ? `## 新增候选 Facts\n\n${newFacts}`
        : `## New Candidate Facts\n\n${newFacts}`);
  const result = await _compactLLM(
    combined,
    buildCompileEditableFactsPrompt(getLocale()),
    resolvedModel,
    300,
    "compile_editable_facts",
  );

  atomicWrite(outputPath, normalizeCompiledLLMResult(result, "compileEditableFacts"));
  if (nextWatermark) writeEditableFactsState(statePath, nextWatermark);
  return "compiled";
}

/**
 * 将四个中间文件组装成 memory.md（同步，不调 LLM）
 * @param {string} factsPath
 * @param {string} todayPath
 * @param {string} weekPath
 * @param {string} longtermPath
 * @param {string} memoryMdPath
 */
export function assemble(factsPath, todayPath, weekPath, longtermPath, memoryMdPath) {
  const read = (p) => { try { return fs.readFileSync(p, "utf-8").trim(); } catch { return ""; } };

  const facts    = normalizeCompiledSectionBody(read(factsPath));
  const today    = normalizeCompiledSectionBody(read(todayPath));
  const week     = normalizeCompiledSectionBody(read(weekPath));
  const longterm = normalizeCompiledSectionBody(read(longtermPath));

  atomicWrite(memoryMdPath, buildCompiledMemoryMarkdown({ facts, today, week, longterm }));
}

export function buildCompiledMemoryMarkdown({ facts = "", today = "", week = "", longterm = "" } = {}) {
  // 四个标题始终保留，空栏写占位符，避免格式漂移
  const isZh = _isZh();
  const empty = isZh ? "（暂无）" : "(none)";
  const section = (title, content) =>
    `## ${title}\n\n${normalizeCompiledSectionBody(content) || empty}`;

  return [
    section(isZh ? "重要事实" : "Key facts", facts),
    section(isZh ? "今天" : "Today", today),
    section(isZh ? "本周早些时候" : "Earlier this week", week),
    section(isZh ? "长期情况" : "Long-term context", longterm),
  ].join("\n\n") + "\n";
}

/**
 * 通用 LLM 压缩调用（内部）
 * @param {string} input
 * @param {string} systemPrompt
 * @param {{ model: string, api: string, api_key: string, base_url: string }} resolvedModel
 * @param {number} maxTokens
 */
async function _compactLLM(input, systemPrompt, resolvedModel, maxTokens, operation) {
  const { model, api, api_key, base_url } = resolvedModel;
  const fallbackPromptSpec = {
    systemPrompt,
    templateVersion: `${operation || "compile"}.v1`,
    cacheGroup: `memory.${operation || "compile"}`,
  };
  const promptSpec = typeof systemPrompt === "object" && systemPrompt !== null
    ? systemPrompt
    : _compilePromptSpecForOperation(operation, systemPrompt) || fallbackPromptSpec;
  const layout = buildUtilityPromptLayout({
    cacheGroup: promptSpec.cacheGroup,
    templateVersion: promptSpec.templateVersion,
    systemPrompt: promptSpec.systemPrompt,
    userContent: input,
  });
  const usageContext = attachPromptLayoutMetadata({
    source: {
      subsystem: "memory",
      operation: operation || "compile",
      surface: "system",
      trigger: "daily",
    },
    attribution: {
      kind: "memory",
      agentId: resolvedModel.usageAgentId || null,
    },
  }, layout.usageMetadata);
  return callText({
    api, model,
    apiKey: api_key,
    baseUrl: base_url,
    headers: undefined,
    messages: layout.messages,
    systemPrompt: layout.systemPrompt,
    temperature: 0.3,
    maxTokens: withMemoryReasoningBuffer(maxTokens, resolvedModel),
    timeoutMs: 60_000,
    signal: undefined,
    usageLedger: resolvedModel.usageLedger,
    usageContext,
  });
}

function _compilePromptSpecForOperation(operation, systemPrompt) {
  const builder = COMPILE_PROMPT_BUILDERS[operation];
  if (!builder) return null;
  const promptSpec = builder(getLocale());
  return promptSpec.systemPrompt === systemPrompt ? promptSpec : null;
}

// ════════════════════════════
//  辅助
// ════════════════════════════

function computeFingerprint(keys) {
  return crypto.createHash("md5").update(keys.join("\n")).digest("hex");
}

function atomicWrite(filePath, content) {
  atomicWriteSync(filePath, content);
}

function readEditableFactsState(statePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    const value = raw?.lastCompiledSummaryUpdatedAt;
    return {
      lastCompiledSummaryUpdatedAt: value && !Number.isNaN(Date.parse(value)) ? value : null,
    };
  } catch {
    return { lastCompiledSummaryUpdatedAt: null };
  }
}

function writeEditableFactsState(statePath, lastCompiledSummaryUpdatedAt) {
  if (!lastCompiledSummaryUpdatedAt || Number.isNaN(Date.parse(lastCompiledSummaryUpdatedAt))) return;
  atomicWrite(statePath, JSON.stringify({
    lastCompiledSummaryUpdatedAt,
    updatedAt: new Date().toISOString(),
  }, null, 2) + "\n");
}

function getAllSummariesForFacts(summaryManager) {
  if (!summaryManager) return [];
  if (typeof summaryManager.getAllSummaries === "function") {
    return summaryManager.getAllSummaries().filter((s) => s?.summary);
  }
  if (typeof summaryManager.getSummariesInRange === "function") {
    return summaryManager.getSummariesInRange(new Date(0), new Date()).filter((s) => s?.summary);
  }
  return [];
}

function latestSummaryUpdate(summaries) {
  return (summaries || [])
    .map((s) => s?.updated_at || s?.created_at || "")
    .filter((value) => value && !Number.isNaN(Date.parse(value)))
    .sort()
    .at(-1) || null;
}

function latestIso(a, b) {
  const values = [a, b]
    .filter((value) => value && !Number.isNaN(Date.parse(value)))
    .sort();
  return values.at(-1) || null;
}

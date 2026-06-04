const DEFAULT_QUICK_CHAT_SHORTCUT = "Alt+Space";

function normalizeShortcut(value) {
  if (typeof value !== "string") return DEFAULT_QUICK_CHAT_SHORTCUT;
  const trimmed = value.trim();
  return trimmed || DEFAULT_QUICK_CHAT_SHORTCUT;
}

function normalizeQuickChatPreferences(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    shortcut: normalizeShortcut(source.shortcut),
  };
}

function mergeQuickChatPreferences(existing = {}, patch = {}) {
  return normalizeQuickChatPreferences({
    ...normalizeQuickChatPreferences(existing),
    ...(patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {}),
  });
}

module.exports = {
  DEFAULT_QUICK_CHAT_SHORTCUT,
  normalizeQuickChatPreferences,
  mergeQuickChatPreferences,
};

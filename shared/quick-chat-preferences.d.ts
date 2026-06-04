export interface QuickChatPreferences {
  shortcut: string;
}

export const DEFAULT_QUICK_CHAT_SHORTCUT: string;
export function normalizeQuickChatPreferences(value?: unknown): QuickChatPreferences;
export function mergeQuickChatPreferences(existing?: unknown, patch?: unknown): QuickChatPreferences;

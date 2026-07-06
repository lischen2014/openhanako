import type { AudioWaveform } from './chat-types';
import type { JSONContent } from '@tiptap/core';
import { sessionScopedKey } from './session-slice';

export interface AttachedFile {
  fileId?: string;
  path: string;
  name: string;
  isDirectory?: boolean;
  /** 内联 base64 数据（粘贴图片时使用，跳过文件读取） */
  base64Data?: string;
  mimeType?: string;
  waveform?: AudioWaveform;
}

export interface DocContextFile {
  path: string;
  name: string;
}

export interface FloatingAnchorRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

export interface QuotedSelection {
  text: string;
  sourceTitle: string;
  sourceKind: 'preview' | 'chat';
  sourceFilePath?: string;
  sourceSessionPath?: string;
  sourceMessageId?: string;
  sourceRole?: 'user' | 'assistant';
  lineStart?: number;
  lineEnd?: number;
  selectionAnchorKind?: 'native' | 'codemirror';
  charCount: number;
  anchorRect?: FloatingAnchorRect;
  updatedAt?: number;
}

export interface InputSlice {
  attachedFiles: AttachedFile[];
  /** 按 session path 存储的附件（权威源） */
  attachedFilesBySession: Record<string, AttachedFile[]>;
  /** 按 session path 存储的草稿文本（内存级，关窗口清空） */
  drafts: Record<string, string>;
  /** 按 session path 存储的输入框富文本草稿（内存级，关窗口清空） */
  draftDocs: Record<string, JSONContent>;
  deskContextAttached: boolean;
  docContextAttached: boolean;
  inputFocusTrigger: number;
  /** Source of the most recent requestInputFocus() call; consumers gate 'restore' by surface. */
  inputFocusTriggerSource: 'gesture' | 'restore';
  quoteCandidate: QuotedSelection | null;
  quotedSelections: QuotedSelection[];
  /** @deprecated Use quotedSelections for committed quotes and quoteCandidate for transient selection UI. */
  quotedSelection: QuotedSelection | null;
  addAttachedFile: (file: AttachedFile) => void;
  removeAttachedFile: (index: number) => void;
  setAttachedFiles: (files: AttachedFile[]) => void;
  clearAttachedFiles: () => void;
  setDraft: (sessionPath: string, text: string, doc?: JSONContent | null) => void;
  clearDraft: (sessionPath: string) => void;
  setDeskContextAttached: (attached: boolean) => void;
  toggleDeskContext: () => void;
  setDocContextAttached: (attached: boolean) => void;
  toggleDocContext: () => void;
  requestInputFocus: (source?: 'gesture' | 'restore') => void;
  setQuoteCandidate: (sel: QuotedSelection) => void;
  clearQuoteCandidate: () => void;
  addQuotedSelection: (sel: QuotedSelection) => void;
  removeQuotedSelection: (index: number) => void;
  clearQuotedSelections: () => void;
  setQuotedSelections: (sels: QuotedSelection[]) => void;
  /** @deprecated Use addQuotedSelection or setQuoteCandidate. */
  setQuotedSelection: (sel: QuotedSelection) => void;
  /** @deprecated Use clearQuotedSelections and clearQuoteCandidate. */
  clearQuotedSelection: () => void;
}

function syncCurrentSessionAttachments(state: InputSlice & { currentSessionPath?: string | null }, files: AttachedFile[]) {
  const patch: Partial<InputSlice> & { attachedFilesBySession?: Record<string, AttachedFile[]> } = {
    attachedFiles: files,
  };
  const currentSessionPath = state.currentSessionPath;
  if (currentSessionPath) {
    const key = sessionScopedKey(state as any, currentSessionPath) || currentSessionPath;
    patch.attachedFilesBySession = {
      ...state.attachedFilesBySession,
      [key]: files,
    };
    if (key !== currentSessionPath) delete patch.attachedFilesBySession[currentSessionPath];
  }
  return patch;
}

export const createInputSlice = (
  set: (partial: Partial<InputSlice> | ((s: InputSlice) => Partial<InputSlice>)) => void
): InputSlice => ({
  attachedFiles: [],
  attachedFilesBySession: {},
  drafts: {},
  draftDocs: {},
  deskContextAttached: false,
  docContextAttached: false,
  inputFocusTrigger: 0,
  inputFocusTriggerSource: 'gesture',
  quoteCandidate: null,
  quotedSelections: [],
  quotedSelection: null,
  addAttachedFile: (file) =>
    set((s) => syncCurrentSessionAttachments(s as InputSlice & { currentSessionPath?: string | null }, [...s.attachedFiles, file])),
  removeAttachedFile: (index) =>
    set((s) => syncCurrentSessionAttachments(
      s as InputSlice & { currentSessionPath?: string | null },
      s.attachedFiles.filter((_, i) => i !== index),
    )),
  setAttachedFiles: (files) =>
    set((s) => syncCurrentSessionAttachments(s as InputSlice & { currentSessionPath?: string | null }, files)),
  clearAttachedFiles: () =>
    set((s) => syncCurrentSessionAttachments(s as InputSlice & { currentSessionPath?: string | null }, [])),
  setDraft: (sessionPath, text, doc) =>
    set((s) => {
      const key = sessionScopedKey(s as any, sessionPath) || sessionPath;
      const drafts = { ...s.drafts, [key]: text };
      const draftDocs = { ...s.draftDocs };
      if (doc) draftDocs[key] = doc;
      else delete draftDocs[key];
      if (key !== sessionPath) delete drafts[sessionPath];
      if (key !== sessionPath) delete draftDocs[sessionPath];
      return { drafts, draftDocs };
    }),
  clearDraft: (sessionPath) =>
    set((s) => {
      const key = sessionScopedKey(s as any, sessionPath) || sessionPath;
      const rest = { ...s.drafts };
      const draftDocs = { ...s.draftDocs };
      delete rest[key];
      delete rest[sessionPath];
      delete draftDocs[key];
      delete draftDocs[sessionPath];
      return { drafts: rest, draftDocs };
    }),
  setDeskContextAttached: (attached) => set({ deskContextAttached: attached }),
  toggleDeskContext: () =>
    set((s) => ({ deskContextAttached: !s.deskContextAttached })),
  setDocContextAttached: (attached) => set({ docContextAttached: attached }),
  toggleDocContext: () =>
    set((s) => ({ docContextAttached: !s.docContextAttached })),
  requestInputFocus: (source = 'gesture') =>
    set((s) => ({ inputFocusTrigger: s.inputFocusTrigger + 1, inputFocusTriggerSource: source })),
  setQuoteCandidate: (sel) => set({ quoteCandidate: sel }),
  clearQuoteCandidate: () => set({ quoteCandidate: null }),
  addQuotedSelection: (sel) =>
    set((s) => {
      const quotedSelections = [...s.quotedSelections, sel];
      return { quotedSelections, quotedSelection: quotedSelections[0] ?? null };
    }),
  removeQuotedSelection: (index) =>
    set((s) => {
      const quotedSelections = s.quotedSelections.filter((_, i) => i !== index);
      return { quotedSelections, quotedSelection: quotedSelections[0] ?? null };
    }),
  clearQuotedSelections: () => set({ quotedSelections: [], quotedSelection: null }),
  setQuotedSelections: (sels) => set({ quotedSelections: sels, quotedSelection: sels[0] ?? null }),
  setQuotedSelection: (sel) => set({ quotedSelections: [sel], quotedSelection: sel }),
  clearQuotedSelection: () => set({ quoteCandidate: null, quotedSelections: [], quotedSelection: null }),
});

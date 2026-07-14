import {
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
} from '@codemirror/state';
import {
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import {
  collectMarkdownBlocks,
  type MarkdownBlock,
} from './markdown-blocks';

const MARQUEE_DRAG_THRESHOLD = 4;

export interface MarkdownBlockSelection {
  readonly anchor: number;
  readonly head: number;
}

const markdownBlockCache = new WeakMap<object, {
  readonly tree: ReturnType<typeof syntaxTree>;
  readonly blocks: MarkdownBlock[];
}>();

function blocksForState(state: EditorState): MarkdownBlock[] {
  const tree = syntaxTree(state);
  const cached = markdownBlockCache.get(state.doc);
  if (cached?.tree === tree) return cached.blocks;
  const blocks = collectMarkdownBlocks(state);
  markdownBlockCache.set(state.doc, { tree, blocks });
  return blocks;
}

function firstBlockAfter(blocks: readonly MarkdownBlock[], position: number): number {
  let low = 0;
  let high = blocks.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (blocks[middle].from <= position) low = middle + 1;
    else high = middle;
  }
  return low;
}

export const setMarkdownBlockSelection = StateEffect.define<MarkdownBlockSelection | null>({
  map: (value, changes) => value ? {
    anchor: changes.mapPos(value.anchor, 1),
    head: changes.mapPos(value.head, 1),
  } : null,
});

export const markdownBlockSelectionField = StateField.define<MarkdownBlockSelection | null>({
  create: () => null,
  update(value, transaction) {
    let next = transaction.docChanged ? null : value;
    for (const effect of transaction.effects) {
      if (effect.is(setMarkdownBlockSelection)) next = effect.value;
    }
    return next;
  },
});

function indexForStoredPosition(blocks: readonly MarkdownBlock[], position: number): number {
  const following = firstBlockAfter(blocks, position);
  const previous = following - 1;
  if (previous >= 0 && position >= blocks[previous].from && position <= blocks[previous].to) {
    return previous;
  }
  return following < blocks.length ? following : blocks.length - 1;
}

export function selectedMarkdownBlocks(state: EditorState): MarkdownBlock[] {
  const selection = state.field(markdownBlockSelectionField, false);
  if (!selection) return [];
  const blocks = blocksForState(state);
  if (blocks.length === 0) return [];
  const anchorIndex = indexForStoredPosition(blocks, selection.anchor);
  const headIndex = indexForStoredPosition(blocks, selection.head);
  if (anchorIndex < 0 || headIndex < 0) return [];
  return blocks.slice(Math.min(anchorIndex, headIndex), Math.max(anchorIndex, headIndex) + 1);
}

function eventTargetNode(target: EventTarget | null): Node | null {
  return target && typeof target === 'object' && 'nodeType' in target
    ? target as Node
    : null;
}

function isHandleTarget(target: EventTarget | null): boolean {
  const node = eventTargetNode(target);
  const element = node?.nodeType === 1 ? node as Element : node?.parentElement;
  return Boolean(element?.closest('.cm-markdown-block-handle'));
}

interface ContentColumnBounds {
  readonly left: number;
  readonly right: number;
}

function contentColumnBounds(view: EditorView): ContentColumnBounds {
  const contentSurfaces = [...view.contentDOM.querySelectorAll<HTMLElement>([
    '.cm-line:not(.cm-markdown-cover-line)',
    '.cm-table-widget',
    '.cm-mermaid-widget',
    '.cm-image-widget',
    '.cm-math-block-widget',
  ].join(', '))];
  const measured = contentSurfaces
    .map(element => element.getBoundingClientRect())
    .filter(rect => rect.width > 0);
  if (measured.length > 0) {
    const widest = measured.reduce((best, rect) => rect.width > best.width ? rect : best);
    return { left: widest.left, right: widest.right };
  }

  const contentRect = view.contentDOM.getBoundingClientRect();
  return { left: contentRect.left, right: contentRect.right };
}

function blockContainsLine(block: MarkdownBlock, lineNumber: number): boolean {
  return lineNumber >= block.startLine && lineNumber <= block.endLine;
}

function isTopLevelBlockGap(view: EditorView, x: number, y: number): boolean {
  const bounds = contentColumnBounds(view);
  if (x < bounds.left || x > bounds.right) return false;
  const blocks = blocksForState(view.state);
  if (blocks.length < 2) return false;
  const position = view.posAtCoords({ x: (bounds.left + bounds.right) / 2, y }, false);
  if (position === null) return false;
  const nextIndex = firstBlockAfter(blocks, position);
  const neighborhoodStart = Math.max(0, nextIndex - 2);
  const neighborhoodEnd = Math.min(blocks.length - 1, neighborhoodStart + 3);
  for (let index = neighborhoodStart; index < neighborhoodEnd; index += 1) {
    const current = blockVerticalBounds(view, blocks[index]);
    const next = blockVerticalBounds(view, blocks[index + 1]);
    if (next.top > current.bottom && y >= current.bottom && y <= next.top) return true;
  }
  if (blocks.slice(neighborhoodStart, neighborhoodEnd + 1).some(block => {
    const blockBounds = blockVerticalBounds(view, block);
    return y >= blockBounds.top && y <= blockBounds.bottom;
  })) return false;

  // Keep parser-owned blank lines selectable when a browser cannot expose a
  // measurable CSS gap (for example while the viewport is still settling).
  const line = view.state.doc.lineAt(position);
  return line.text.trim() === ''
    && !blocks.slice(neighborhoodStart, neighborhoodEnd + 1)
      .some(block => blockContainsLine(block, line.number));
}

function isMarqueeOrigin(view: EditorView, x: number, y: number): boolean {
  const bounds = contentColumnBounds(view);
  return x < bounds.left || x > bounds.right || isTopLevelBlockGap(view, x, y);
}

function blockIndexAtCoords(
  view: EditorView,
  blocks: readonly MarkdownBlock[],
  x: number,
  y: number,
  direction: -1 | 1,
): number {
  const scrollRect = view.scrollDOM.getBoundingClientRect();
  const safeY = Math.min(scrollRect.bottom - 1, Math.max(scrollRect.top + 1, y));
  const position = view.posAtCoords({ x, y: safeY }, false)
    ?? (y <= scrollRect.top ? 0 : view.state.doc.length);
  const next = firstBlockAfter(blocks, position);
  const previous = next - 1;
  if (previous >= 0 && position >= blocks[previous].from && position <= blocks[previous].to) {
    return previous;
  }
  if (direction > 0) return next < blocks.length ? next : blocks.length - 1;
  return next > 0 ? next - 1 : 0;
}

function blockVerticalBounds(view: EditorView, block: MarkdownBlock): { top: number; bottom: number } {
  const start = view.lineBlockAt(block.from);
  const end = view.lineBlockAt(Math.max(block.from, block.to - 1));
  return {
    top: view.documentTop + (start.top * view.scaleY),
    bottom: view.documentTop + (end.bottom * view.scaleY),
  };
}

class MarkdownBlockSelectionView {
  private readonly ownerDocument: Document;
  private readonly ownerWindow: Window;
  private readonly layer: HTMLDivElement;
  private readonly surface: HTMLDivElement;
  private pending: {
    readonly pointerId: number;
    readonly startX: number;
    readonly startY: number;
  } | null = null;
  private active = false;
  private anchorIndex: number | null = null;
  private lastPointerY = 0;
  private frameId: number | null = null;

  constructor(private readonly view: EditorView) {
    this.ownerDocument = view.dom.ownerDocument;
    this.ownerWindow = this.ownerDocument.defaultView ?? window;
    this.layer = this.ownerDocument.createElement('div');
    this.layer.className = 'cm-markdown-block-selection-layer';
    this.layer.setAttribute('aria-hidden', 'true');
    this.surface = this.ownerDocument.createElement('div');
    this.surface.className = 'cm-markdown-block-selection-surface';
    this.layer.appendChild(this.surface);
    view.dom.appendChild(this.layer);

    this.ownerDocument.addEventListener('pointerdown', this.onPointerDown, true);
    this.ownerDocument.addEventListener('pointermove', this.onPointerMove, true);
    this.ownerDocument.addEventListener('pointerup', this.onPointerUp, true);
    this.ownerDocument.addEventListener('pointercancel', this.onPointerCancel, true);
    view.dom.addEventListener('pointerleave', this.onPointerLeave);
    view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });
    this.ownerWindow.addEventListener('resize', this.scheduleRender);
    this.scheduleRender();
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.viewportChanged || update.geometryChanged
      || update.startState.field(markdownBlockSelectionField, false)
        !== update.state.field(markdownBlockSelectionField, false)) {
      this.scheduleRender();
    }
  }

  destroy(): void {
    if (this.frameId !== null) this.ownerWindow.cancelAnimationFrame(this.frameId);
    this.ownerDocument.removeEventListener('pointerdown', this.onPointerDown, true);
    this.ownerDocument.removeEventListener('pointermove', this.onPointerMove, true);
    this.ownerDocument.removeEventListener('pointerup', this.onPointerUp, true);
    this.ownerDocument.removeEventListener('pointercancel', this.onPointerCancel, true);
    this.view.dom.removeEventListener('pointerleave', this.onPointerLeave);
    this.view.scrollDOM.removeEventListener('scroll', this.onScroll);
    this.ownerWindow.removeEventListener('resize', this.scheduleRender);
    this.view.dom.classList.remove('cm-markdown-block-marquee-zone');
    this.view.dom.classList.remove('cm-markdown-block-selection-active');
    this.layer.remove();
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || isHandleTarget(event.target)) return;
    const targetNode = eventTargetNode(event.target);
    const insideEditor = Boolean(targetNode && this.view.dom.contains(targetNode));
    if (!insideEditor) {
      this.clearSelection();
      return;
    }

    if (!isMarqueeOrigin(this.view, event.clientX, event.clientY)) {
      this.clearSelection();
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    this.clearSelection();
    this.pending = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
    };
    this.lastPointerY = event.clientY;
    this.view.dom.setPointerCapture?.(event.pointerId);
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const pending = this.pending;
    if (!pending || pending.pointerId !== event.pointerId) {
      const targetNode = eventTargetNode(event.target);
      const insideEditor = Boolean(targetNode && this.view.dom.contains(targetNode));
      this.view.dom.classList.toggle(
        'cm-markdown-block-marquee-zone',
        insideEditor
          && !isHandleTarget(event.target)
          && isMarqueeOrigin(this.view, event.clientX, event.clientY),
      );
      return;
    }

    this.lastPointerY = event.clientY;
    const deltaX = event.clientX - pending.startX;
    const deltaY = event.clientY - pending.startY;
    if (!this.active && Math.hypot(deltaX, deltaY) < MARQUEE_DRAG_THRESHOLD) return;
    if (!this.active) {
      const blocks = blocksForState(this.view.state);
      if (blocks.length === 0) return;
      const bounds = contentColumnBounds(this.view);
      const documentX = (bounds.left + bounds.right) / 2;
      const direction = deltaY < 0 ? -1 : 1;
      this.anchorIndex = blockIndexAtCoords(
        this.view,
        blocks,
        documentX,
        pending.startY,
        direction,
      );
      this.active = true;
    }

    event.preventDefault();
    event.stopPropagation();
    this.updateSelectionAtPointer();
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (this.pending?.pointerId !== event.pointerId) return;
    if (this.active) {
      event.preventDefault();
      event.stopPropagation();
    }
    this.view.dom.releasePointerCapture?.(event.pointerId);
    this.resetGesture();
  };

  private readonly onPointerCancel = (event: PointerEvent): void => {
    if (this.pending?.pointerId !== event.pointerId) return;
    this.clearSelection();
    this.resetGesture();
  };

  private readonly onPointerLeave = (): void => {
    if (!this.pending) this.view.dom.classList.remove('cm-markdown-block-marquee-zone');
  };

  private readonly onScroll = (): void => {
    if (this.active) this.updateSelectionAtPointer();
    this.scheduleRender();
  };

  private updateSelectionAtPointer(): void {
    if (this.anchorIndex === null) return;
    const blocks = blocksForState(this.view.state);
    const anchorBlock = blocks[this.anchorIndex];
    if (!anchorBlock) {
      this.clearSelection();
      return;
    }
    const bounds = contentColumnBounds(this.view);
    const documentX = (bounds.left + bounds.right) / 2;
    const direction = this.lastPointerY < (this.pending?.startY ?? this.lastPointerY) ? -1 : 1;
    const headIndex = blockIndexAtCoords(
      this.view,
      blocks,
      documentX,
      this.lastPointerY,
      direction,
    );
    const headBlock = blocks[headIndex];
    if (!headBlock) return;
    const current = this.view.state.field(markdownBlockSelectionField, false);
    if (current?.anchor === anchorBlock.from && current.head === headBlock.from) return;
    this.view.dispatch({
      effects: setMarkdownBlockSelection.of({ anchor: anchorBlock.from, head: headBlock.from }),
    });
  }

  private clearSelection(): void {
    if (!this.view.state.field(markdownBlockSelectionField, false)) return;
    this.view.dispatch({ effects: setMarkdownBlockSelection.of(null) });
  }

  private resetGesture(): void {
    this.pending = null;
    this.active = false;
    this.anchorIndex = null;
  }

  private readonly scheduleRender = (): void => {
    if (this.frameId !== null) return;
    this.frameId = this.ownerWindow.requestAnimationFrame(() => {
      this.frameId = null;
      this.renderSelection();
    });
  };

  private renderSelection(): void {
    const blocks = selectedMarkdownBlocks(this.view.state);
    this.view.dom.classList.toggle('cm-markdown-block-selection-active', blocks.length > 0);
    if (blocks.length === 0) {
      this.surface.hidden = true;
      return;
    }

    const first = blockVerticalBounds(this.view, blocks[0]);
    const last = blockVerticalBounds(this.view, blocks[blocks.length - 1]);
    const editorRect = this.view.dom.getBoundingClientRect();
    const scrollRect = this.view.scrollDOM.getBoundingClientRect();
    const column = contentColumnBounds(this.view);
    const top = Math.max(first.top, scrollRect.top);
    const bottom = Math.min(last.bottom, scrollRect.bottom);
    if (bottom <= top) {
      this.surface.hidden = true;
      return;
    }

    this.surface.hidden = false;
    this.surface.classList.toggle('is-clipped-top', first.top < scrollRect.top);
    this.surface.classList.toggle('is-clipped-bottom', last.bottom > scrollRect.bottom);
    this.surface.style.left = `${column.left - editorRect.left}px`;
    this.surface.style.top = `${top - editorRect.top}px`;
    this.surface.style.width = `${Math.max(0, column.right - column.left)}px`;
    this.surface.style.height = `${bottom - top}px`;
  }
}

export function markdownBlockSelectionPlugin(): Extension {
  return [
    markdownBlockSelectionField,
    ViewPlugin.define(view => new MarkdownBlockSelectionView(view)),
  ];
}

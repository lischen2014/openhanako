/**
 * @vitest-environment jsdom
 */
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history, undo } from '@codemirror/commands';
import { fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  markdownBlockHandlePlugin,
  type MarkdownBlockMenuRequest,
} from '../../editor/markdown-block-handles';

function elementRect(): DOMRect {
  return {
    x: 0,
    y: 0,
    width: 960,
    height: 640,
    top: 0,
    right: 960,
    bottom: 640,
    left: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

function pointerEvent(type: string, pointerId: number, clientY: number, clientX = 40): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    button: { value: 0 },
    pointerId: { value: pointerId },
    clientX: { value: clientX },
    clientY: { value: clientY },
  });
  return event;
}

describe('markdown block handle rail', () => {
  let rectSpy: ReturnType<typeof vi.spyOn>;
  let coordsSpy: ReturnType<typeof vi.spyOn>;
  let lineBlockSpy: ReturnType<typeof vi.spyOn>;
  let lineBoundarySpy: ReturnType<typeof vi.spyOn>;
  let documentTopSpy: ReturnType<typeof vi.spyOn>;
  let scaleYSpy: ReturnType<typeof vi.spyOn>;
  let rafSpy: ReturnType<typeof vi.spyOn>;
  let cancelRafSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(elementRect);
    Range.prototype.getClientRects = vi.fn(() => [] as unknown as DOMRectList);
    Range.prototype.getBoundingClientRect = vi.fn(() => elementRect());
    coordsSpy = vi.spyOn(EditorView.prototype, 'coordsAtPos').mockImplementation(function coords(
      this: EditorView,
      pos: number,
    ) {
      const line = this.state.doc.lineAt(Math.min(pos, this.state.doc.length));
      const top = line.number * 32;
      return { left: 200, right: 400, top, bottom: top + 24 };
    });
    lineBlockSpy = vi.spyOn(EditorView.prototype, 'lineBlockAt').mockImplementation(function lineBlock(
      this: EditorView,
      pos: number,
    ) {
      const line = this.state.doc.lineAt(Math.min(pos, this.state.doc.length));
      const top = line.number * 32;
      return { top, height: 24 } as ReturnType<EditorView['lineBlockAt']>;
    });
    lineBoundarySpy = vi.spyOn(EditorView.prototype, 'moveToLineBoundary').mockImplementation(function boundary(
      this: EditorView,
      start,
    ) {
      return EditorSelection.cursor(this.state.doc.lineAt(start.head).to);
    });
    documentTopSpy = vi.spyOn(EditorView.prototype, 'documentTop', 'get').mockReturnValue(0);
    scaleYSpy = vi.spyOn(EditorView.prototype, 'scaleY', 'get').mockReturnValue(1);
    rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => (
      window.setTimeout(() => callback(0), 0)
    ));
    cancelRafSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => {
      window.clearTimeout(id);
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
    rectSpy.mockRestore();
    coordsSpy.mockRestore();
    lineBlockSpy.mockRestore();
    lineBoundarySpy.mockRestore();
    documentTopSpy.mockRestore();
    scaleYSpy.mockRestore();
    rafSpy.mockRestore();
    cancelRafSpy.mockRestore();
    vi.useRealTimers();
  });

  function createView(
    onOpenMenu = vi.fn<(request: MarkdownBlockMenuRequest) => void>(),
    doc = 'Alpha\n\nBeta\n\nGamma',
  ): {
    view: EditorView;
    onOpenMenu: typeof onOpenMenu;
  } {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        extensions: [
          markdown({ base: markdownLanguage }),
          history(),
          markdownBlockHandlePlugin({ onOpenMenu }),
        ],
      }),
    });
    vi.runOnlyPendingTimers();
    return { view, onOpenMenu };
  }

  it('opens the shared menu with the clicked top-level block as its target', () => {
    const { view, onOpenMenu } = createView();
    const handles = view.dom.querySelectorAll<HTMLButtonElement>('.cm-markdown-block-handle');

    expect(handles).toHaveLength(3);
    fireEvent.click(handles[1]);

    expect(onOpenMenu).toHaveBeenCalledWith(expect.objectContaining({
      target: expect.objectContaining({ type: 'Paragraph', source: 'Beta' }),
    }));
    view.destroy();
  });

  it('moves a block with pointer drag as one undoable transaction', () => {
    const { view } = createView();
    const firstHandle = view.dom.querySelectorAll<HTMLButtonElement>('.cm-markdown-block-handle')[0];

    fireEvent(firstHandle, pointerEvent('pointerdown', 7, 32));
    fireEvent(firstHandle, pointerEvent('pointermove', 7, 220));
    fireEvent(firstHandle, pointerEvent('pointerup', 7, 220));

    expect(view.state.doc.toString()).toBe('Beta\n\nGamma\n\nAlpha');
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('Alpha\n\nBeta\n\nGamma');
    view.destroy();
  });

  it('moves a translucent text copy while leaving the original block untouched', () => {
    const { view } = createView();
    const firstHandle = view.dom.querySelectorAll<HTMLButtonElement>('.cm-markdown-block-handle')[0];

    fireEvent(firstHandle, pointerEvent('pointerdown', 11, 32));
    fireEvent(firstHandle, pointerEvent('pointermove', 11, 110));

    expect(view.dom.querySelector('.cm-markdown-block-drag-source')).toBeNull();
    expect(view.dom.querySelector('.cm-markdown-block-drop-target')).toBeNull();
    const preview = view.dom.querySelector<HTMLElement>('.cm-markdown-block-drag-preview');
    expect(preview).toBeInstanceOf(HTMLElement);
    expect(preview?.textContent).toContain('Alpha');
    expect(preview?.style.transform).toBe('translate3d(0px, 78px, 0)');

    fireEvent(firstHandle, pointerEvent('pointermove', 11, 130, 52));
    expect(preview?.style.transform).toBe('translate3d(12px, 98px, 0)');

    fireEvent(firstHandle, pointerEvent('pointercancel', 11, 110));
    expect(view.dom.querySelector('.cm-markdown-block-drag-preview')).toBeNull();
    view.destroy();
  });

  it('centers the handle against the first visible text line', () => {
    coordsSpy.mockImplementation(() => ({ left: 200, right: 400, top: 96, bottom: 120 }));
    lineBlockSpy.mockImplementation(() => ({ top: 32, height: 40 }) as ReturnType<EditorView['lineBlockAt']>);
    const { view } = createView();
    const firstHandle = view.dom.querySelector<HTMLButtonElement>('.cm-markdown-block-handle');

    expect(firstHandle?.style.top).toBe('8px');
    view.destroy();
  });

  it('centers the handle on the first visual row when the first logical line wraps', () => {
    coordsSpy.mockImplementation(() => ({ left: 200, right: 400, top: 32, bottom: 56 }));
    lineBlockSpy.mockImplementation(() => ({ top: 32, height: 72 }) as ReturnType<EditorView['lineBlockAt']>);
    lineBoundarySpy.mockImplementation(function boundary(
      this: EditorView,
      start: Parameters<EditorView['moveToLineBoundary']>[0],
    ) {
      const line = this.state.doc.lineAt(start.head);
      return EditorSelection.cursor(Math.min(line.from + 3, line.to - 1));
    });
    const { view } = createView(
      vi.fn<(request: MarkdownBlockMenuRequest) => void>(),
      'A long first logical line that wraps visually\n\nAfter',
    );
    const firstHandle = view.dom.querySelector<HTMLButtonElement>('.cm-markdown-block-handle');

    expect(firstHandle?.style.top).toBe('0px');
    view.destroy();
  });

  it('renders the drop indicator inside CodeMirror content at a block boundary', () => {
    coordsSpy.mockImplementation(function coords(this: EditorView, pos: number) {
      const line = this.state.doc.lineAt(Math.min(pos, this.state.doc.length));
      const top = (line.number * 32) + 13;
      return { left: 200, right: 400, top, bottom: top + 24 };
    });
    const { view } = createView();
    const secondHandle = view.dom.querySelectorAll<HTMLButtonElement>('.cm-markdown-block-handle')[1];

    fireEvent(secondHandle, pointerEvent('pointerdown', 13, 96));
    fireEvent(secondHandle, pointerEvent('pointermove', 13, 40));

    const indicator = view.dom.querySelector<HTMLElement>('.cm-markdown-block-drop-indicator');
    expect(indicator).toBeInstanceOf(HTMLElement);
    expect(indicator?.closest('.cm-content')).toBe(view.contentDOM);
    expect(indicator?.style.top).toBe('');
    expect(indicator?.style.left).toBe('');
    fireEvent(secondHandle, pointerEvent('pointercancel', 13, 40));
    view.destroy();
  });

  it('leaves drop indicator width to the shared document-column CSS', () => {
    const { view } = createView();
    const secondHandle = view.dom.querySelectorAll<HTMLButtonElement>('.cm-markdown-block-handle')[1];

    fireEvent(secondHandle, pointerEvent('pointerdown', 14, 96));
    fireEvent(secondHandle, pointerEvent('pointermove', 14, 40));

    const indicator = view.dom.querySelector<HTMLElement>('.cm-markdown-block-drop-indicator');
    expect(indicator?.closest('.cm-content')).toBe(view.contentDOM);
    expect(indicator?.style.left).toBe('');
    expect(indicator?.style.right).toBe('');
    expect(indicator?.style.width).toBe('');
    fireEvent(secondHandle, pointerEvent('pointercancel', 14, 40));
    expect(indicator?.classList.contains('is-visible')).toBe(false);
    vi.advanceTimersByTime(100);
    expect(view.dom.querySelector('.cm-markdown-block-drop-indicator')).toBeNull();
    view.destroy();
  });

  it('keeps a fenced code block handle when its hidden fence lines have no coordinates', () => {
    coordsSpy.mockImplementation(function coords(this: EditorView, pos: number) {
      const line = this.state.doc.lineAt(Math.min(pos, this.state.doc.length));
      if (line.text.startsWith('```')) return null;
      const top = line.number * 32;
      return { left: 200, right: 400, top, bottom: top + 24 };
    });
    const { view } = createView(
      vi.fn<(request: MarkdownBlockMenuRequest) => void>(),
      '```ts\nconst value = 1;\n```\n\nAfter',
    );
    const handles = view.dom.querySelectorAll<HTMLButtonElement>('.cm-markdown-block-handle');

    expect(handles).toHaveLength(2);
    expect(handles[0].closest<HTMLElement>('.cm-markdown-block-rail-item')?.dataset.blockFrom).toBe('0');

    fireEvent(handles[1], pointerEvent('pointerdown', 12, 160));
    fireEvent(handles[1], pointerEvent('pointermove', 12, 50));
    expect(
      view.dom.querySelector<HTMLElement>('.cm-markdown-block-drop-indicator')?.classList.contains('is-visible'),
    ).toBe(true);
    fireEvent(handles[1], pointerEvent('pointercancel', 12, 50));
    view.destroy();
  });

  it('aligns a fenced code handle to the code text instead of a replacement widget edge', () => {
    coordsSpy.mockImplementation(function coords(this: EditorView, pos: number) {
      const line = this.state.doc.lineAt(Math.min(pos, this.state.doc.length));
      const left = line.text.startsWith('```') ? 800 : 200;
      const top = line.number * 32;
      return { left, right: left + 200, top, bottom: top + 24 };
    });
    const { view } = createView(
      vi.fn<(request: MarkdownBlockMenuRequest) => void>(),
      '```ts\nconst value = 1;\n```\n\nAfter',
    );
    const items = view.dom.querySelectorAll<HTMLElement>('.cm-markdown-block-rail-item');

    expect(items).toHaveLength(2);
    expect(items[0].style.left).toBe('172px');
    expect(items[1].style.left).toBe('172px');
    view.destroy();
  });

  it('never treats an unmeasured offscreen block as the drop target', () => {
    coordsSpy.mockImplementation(function coords(this: EditorView, pos: number) {
      const line = this.state.doc.lineAt(Math.min(pos, this.state.doc.length));
      if (line.number >= 5) return null;
      const top = line.number * 32;
      return { left: 200, right: 400, top, bottom: top + 24 };
    });
    const { view } = createView();
    const firstHandle = view.dom.querySelectorAll<HTMLButtonElement>('.cm-markdown-block-handle')[0];

    fireEvent(firstHandle, pointerEvent('pointerdown', 8, 32));
    fireEvent(firstHandle, pointerEvent('pointermove', 8, 220));
    fireEvent(firstHandle, pointerEvent('pointerup', 8, 220));

    expect(view.state.doc.toString()).toBe('Beta\n\nAlpha\n\nGamma');
    view.destroy();
  });

  it('remeasures visible blocks while scrolling during an active drag', () => {
    const viewportSpy = vi.spyOn(EditorView.prototype, 'viewport', 'get').mockImplementation(function viewport(
      this: EditorView,
    ) {
      return { from: 0, to: this.state.doc.length };
    });
    let scrollOffset = 0;
    coordsSpy.mockImplementation(function coords(this: EditorView, pos: number) {
      const line = this.state.doc.lineAt(Math.min(pos, this.state.doc.length));
      const top = (line.number * 32) - scrollOffset;
      return { left: 200, right: 400, top, bottom: top + 24 };
    });
    lineBlockSpy.mockImplementation(function lineBlock(this: EditorView, pos: number) {
      const line = this.state.doc.lineAt(Math.min(pos, this.state.doc.length));
      return { top: (line.number * 32) - scrollOffset, height: 24 } as ReturnType<EditorView['lineBlockAt']>;
    });
    const { view } = createView();
    const firstHandle = view.dom.querySelectorAll<HTMLButtonElement>('.cm-markdown-block-handle')[0];

    fireEvent(firstHandle, pointerEvent('pointerdown', 15, 32));
    fireEvent(firstHandle, pointerEvent('pointermove', 15, 100));

    scrollOffset = 100;
    fireEvent.scroll(view.scrollDOM);
    vi.runOnlyPendingTimers();
    fireEvent(firstHandle, pointerEvent('pointerup', 15, 100));

    expect(view.state.doc.toString()).toBe('Beta\n\nGamma\n\nAlpha');
    view.destroy();
    viewportSpy.mockRestore();
  });

  it('does not render editing handles in read-only configuration', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: 'Alpha\n\nBeta',
        extensions: [
          markdown({ base: markdownLanguage }),
          markdownBlockHandlePlugin({ readOnly: true, onOpenMenu: vi.fn() }),
        ],
      }),
    });
    vi.runOnlyPendingTimers();

    expect(view.dom.querySelector('.cm-markdown-block-handle')).toBeNull();
    view.destroy();
  });
});

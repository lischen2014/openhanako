/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore, type StoreState } from '../../stores';

const mockHanaFetch = vi.fn();

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: mockHanaFetch,
}));

describe('remote file preview workbench refs', () => {
  beforeEach(() => {
    useStore.setState({
      previewItems: [],
      openTabs: [],
    } as Partial<StoreState>);
    mockHanaFetch.mockReset();
    mockHanaFetch.mockResolvedValue({
      json: async () => ({ ok: true, version: { mtimeMs: 1, size: 4 } }),
    });
  });

  it('saves remote workbench content by mountId instead of producing a legacy rootId-only request', async () => {
    const { saveRemoteWorkbenchContent } = await import('../../utils/remote-file-preview');

    await saveRemoteWorkbenchContent({
      kind: 'workbench-file',
      mountId: 'mount_docs',
      subdir: 'notes',
      name: 'remote.md',
      contentPath: '/api/workbench/content?mountId=mount_docs&subdir=notes&name=remote.md',
    } as any, 'body');

    expect(mockHanaFetch).toHaveBeenCalledWith(
      '/api/workbench/actions',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          action: 'writeText',
          mountId: 'mount_docs',
          subdir: 'notes',
          name: 'remote.md',
          content: 'body',
          expectedVersion: null,
        }),
      }),
    );
    expect(String(mockHanaFetch.mock.calls[0][1].body)).not.toContain('"rootId"');
  });

  it('retries remote workbench refresh when the first cache-busted read is unchanged', async () => {
    const { refreshPreviewItemsFromRemoteWorkbenchTarget } = await import('../../utils/remote-file-preview');
    const target = {
      kind: 'workbench-file',
      mountId: 'mount_docs',
      subdir: 'notes',
      name: 'remote.md',
      contentPath: '/api/workbench/content?mountId=mount_docs&subdir=notes&name=remote.md',
      version: { mtimeMs: 2, size: 8 },
    } as any;
    useStore.setState({
      previewItems: [{
        id: 'remote-note',
        type: 'markdown',
        title: 'remote.md',
        content: 'old',
        storageKind: 'remote-content',
        remoteContentRef: {
          ...target,
          version: { mtimeMs: 1, size: 3 },
        },
      }],
    } as Partial<StoreState>);
    mockHanaFetch
      .mockResolvedValueOnce(new Response('old', { status: 200 }))
      .mockResolvedValueOnce(new Response('new', { status: 200 }));

    await refreshPreviewItemsFromRemoteWorkbenchTarget(target, {
      retryUnchanged: true,
      retryDelaysMs: [0],
    });

    const item = useStore.getState().previewItems[0];
    expect(mockHanaFetch).toHaveBeenCalledTimes(2);
    expect(item.content).toBe('new');
    expect(item.fileVersion).toEqual({ mtimeMs: 2, size: 8 });
    expect(item.remoteContentRef?.version).toEqual({ mtimeMs: 2, size: 8 });
  });

  it('uses the content response version when opening a remote workbench document', async () => {
    const { openMobileWorkbenchPreview } = await import('../../utils/remote-file-preview');
    const staleListVersion = new Date('2026-06-20T00:00:00.000Z').toISOString();
    mockHanaFetch.mockResolvedValueOnce(new Response('# fresh\n', {
      status: 200,
      headers: {
        'X-Hana-File-MtimeMs': '1781989413542',
        'X-Hana-File-Size': '8',
      },
    }));

    await openMobileWorkbenchPreview({
      mountId: 'mount_docs',
      subdir: 'notes',
      file: {
        name: 'remote.md',
        isDir: false,
        mtime: staleListVersion,
        size: 0,
      } as any,
    });

    const item = useStore.getState().previewItems[0];
    expect(item.content).toBe('# fresh\n');
    expect(item.fileVersion).toEqual({ mtimeMs: 1781989413542, size: 8 });
    expect(item.remoteContentRef?.version).toEqual({ mtimeMs: 1781989413542, size: 8 });
  });

  it('does not downgrade a remote workbench refresh to a stale target version', async () => {
    const { refreshPreviewItemsFromRemoteWorkbenchTarget } = await import('../../utils/remote-file-preview');
    const staleVersion = { mtimeMs: 1000, size: 0 };
    const savedVersion = { mtimeMs: 2000, size: 12 };
    const diskVersion = { mtimeMs: 3000, size: 18 };
    const target = {
      kind: 'workbench-file',
      mountId: 'mount_docs',
      subdir: 'notes',
      name: 'remote.md',
      contentPath: '/api/workbench/content?mountId=mount_docs&subdir=notes&name=remote.md',
      version: staleVersion,
    } as any;
    useStore.setState({
      previewItems: [{
        id: 'remote-note',
        type: 'markdown',
        title: 'remote.md',
        content: 'saved body',
        storageKind: 'remote-content',
        fileVersion: savedVersion,
        remoteContentRef: target,
      }],
    } as Partial<StoreState>);
    mockHanaFetch.mockResolvedValueOnce(new Response('fresh external body', {
      status: 200,
      headers: {
        'X-Hana-File-MtimeMs': String(diskVersion.mtimeMs),
        'X-Hana-File-Size': String(diskVersion.size),
      },
    }));

    await refreshPreviewItemsFromRemoteWorkbenchTarget(target);

    const item = useStore.getState().previewItems[0];
    expect(item.content).toBe('fresh external body');
    expect(item.fileVersion).toEqual(diskVersion);
    expect(item.remoteContentRef?.version).toEqual(diskVersion);
  });
});

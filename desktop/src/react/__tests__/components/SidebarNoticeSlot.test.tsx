/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutoUpdateState, TrainUpdateStatus } from '../../types';
import { SidebarUpdateNoticeCard } from '../../components/notices/SidebarNoticeSlot';

const labels: Record<string, string> = {
  'settings.about.trainStickerTitle': '新版本已就绪',
  'settings.about.shellStickerTitle': '平台更新可用，需重启',
  'settings.about.shellStickerTitleBlocking': '完成此更新后才能继续接收新版本',
  'window.close': '关闭',
};

function translate(key: string, vars?: Record<string, string | number>): string {
  let value = labels[key] ?? key;
  for (const [name, replacement] of Object.entries(vars ?? {})) {
    value = value.replace(`{${name}}`, String(replacement));
  }
  return value;
}

function shellState(partial: Partial<AutoUpdateState>): AutoUpdateState {
  return {
    status: 'idle',
    version: null,
    releaseNotes: null,
    releaseUrl: null,
    downloadUrl: null,
    progress: null,
    error: null,
    ...partial,
  };
}

function trainStatus(partial: Partial<TrainUpdateStatus>): TrainUpdateStatus {
  return {
    staged: false,
    train: null,
    version: null,
    minShellBlocked: false,
    ...partial,
  };
}

describe('SidebarUpdateNoticeCard', () => {
  beforeEach(() => {
    window.t = translate as typeof window.t;
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it('stays silent when neither update kind is pending', () => {
    const { container, rerender } = render(
      <SidebarUpdateNoticeCard shellState={shellState({ status: 'idle' })} trainStatus={null} />,
    );
    expect(container).toBeEmptyDOMElement();

    rerender(<SidebarUpdateNoticeCard shellState={shellState({ status: 'checking' })} trainStatus={trainStatus({ staged: false })} />);
    expect(container).toBeEmptyDOMElement();

    rerender(<SidebarUpdateNoticeCard shellState={shellState({ status: 'downloading' })} trainStatus={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the train sticker when a train is staged', () => {
    const onApplyTrain = vi.fn();
    render(
      <SidebarUpdateNoticeCard
        shellState={shellState({ status: 'idle' })}
        trainStatus={trainStatus({ staged: true, train: 3, version: '0.400.0' })}
        onApplyTrain={onApplyTrain}
      />,
    );

    expect(screen.getByText('新版本已就绪')).toBeInTheDocument();
    expect(screen.getByText('v0.400.0')).toBeInTheDocument();

    fireEvent.click(screen.getByText('新版本已就绪'));
    expect(onApplyTrain).toHaveBeenCalledTimes(1);
  });

  it('shows the shell sticker when a platform update is downloaded', () => {
    const onInstallShell = vi.fn();
    render(
      <SidebarUpdateNoticeCard
        shellState={shellState({ status: 'downloaded', version: '2.0.0' })}
        trainStatus={trainStatus({ staged: false })}
        onInstallShell={onInstallShell}
      />,
    );

    expect(screen.getByText('平台更新可用，需重启')).toBeInTheDocument();
    expect(screen.getByText('v2.0.0')).toBeInTheDocument();

    fireEvent.click(screen.getByText('平台更新可用，需重启'));
    expect(onInstallShell).toHaveBeenCalledTimes(1);
  });

  it('prioritizes the shell sticker over a simultaneously staged train (platform update wins)', () => {
    const onInstallShell = vi.fn();
    const onApplyTrain = vi.fn();
    render(
      <SidebarUpdateNoticeCard
        shellState={shellState({ status: 'downloaded', version: '2.0.0' })}
        trainStatus={trainStatus({ staged: true, train: 3, version: '0.400.0' })}
        onInstallShell={onInstallShell}
        onApplyTrain={onApplyTrain}
      />,
    );

    expect(screen.getByText('平台更新可用，需重启')).toBeInTheDocument();
    expect(screen.queryByText('新版本已就绪')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('平台更新可用，需重启'));
    expect(onInstallShell).toHaveBeenCalledTimes(1);
    expect(onApplyTrain).not.toHaveBeenCalled();
  });

  it('escalates the shell sticker copy when the train status reports minShellBlocked', () => {
    render(
      <SidebarUpdateNoticeCard
        shellState={shellState({ status: 'downloaded', version: '2.0.0' })}
        trainStatus={trainStatus({ staged: false, minShellBlocked: true })}
      />,
    );

    expect(screen.getByText('完成此更新后才能继续接收新版本')).toBeInTheDocument();
    expect(screen.queryByText('平台更新可用，需重启')).not.toBeInTheDocument();
  });

  it('dismissing the train sticker hides it for that version only; a newer staged version reappears', () => {
    const { container, rerender } = render(
      <SidebarUpdateNoticeCard
        shellState={shellState({ status: 'idle' })}
        trainStatus={trainStatus({ staged: true, train: 1, version: '0.400.0' })}
      />,
    );
    expect(screen.getByText('新版本已就绪')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(container).toBeEmptyDOMElement();

    // Re-rendering with the SAME staged version stays dismissed (persisted via storage).
    rerender(
      <SidebarUpdateNoticeCard
        shellState={shellState({ status: 'idle' })}
        trainStatus={trainStatus({ staged: true, train: 1, version: '0.400.0' })}
      />,
    );
    expect(container).toBeEmptyDOMElement();

    // A newer staged version reappears.
    rerender(
      <SidebarUpdateNoticeCard
        shellState={shellState({ status: 'idle' })}
        trainStatus={trainStatus({ staged: true, train: 2, version: '0.401.0' })}
      />,
    );
    expect(screen.getByText('新版本已就绪')).toBeInTheDocument();
  });

  it('dismissing the shell sticker hides it for this mount, without touching localStorage (session-only)', () => {
    const { container } = render(
      <SidebarUpdateNoticeCard
        shellState={shellState({ status: 'downloaded', version: '2.0.0' })}
        trainStatus={trainStatus({ staged: false })}
      />,
    );
    expect(screen.getByText('平台更新可用，需重启')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(container).toBeEmptyDOMElement();

    // Dismissing the shell sticker must never persist to storage — a fresh
    // mount (= next launch) always starts undismissed again.
    expect(window.localStorage.length).toBe(0);
  });

  it('a fresh mount after a shell dismissal (simulating next launch) shows the sticker again', () => {
    const first = render(
      <SidebarUpdateNoticeCard
        shellState={shellState({ status: 'downloaded', version: '2.0.0' })}
        trainStatus={trainStatus({ staged: false })}
      />,
    );
    fireEvent.click(first.getByRole('button', { name: '关闭' }));
    expect(first.container).toBeEmptyDOMElement();
    first.unmount();

    render(
      <SidebarUpdateNoticeCard
        shellState={shellState({ status: 'downloaded', version: '2.0.0' })}
        trainStatus={trainStatus({ staged: false })}
      />,
    );
    expect(screen.getByText('平台更新可用，需重启')).toBeInTheDocument();
  });
});

/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

let shellUpdateStateOverride: { status: string; version?: string | null } | null = null;

vi.mock('../../../hooks/use-auto-update-state', () => ({
  useAutoUpdateState: () => shellUpdateStateOverride ?? { status: 'idle' },
}));

const checkTrainNow = vi.fn();
const applyTrainNow = vi.fn();
let trainUpdateStateOverride: { status: string; version: string | null } | null = null;
let minShellBlockedOverride = false;

vi.mock('../../../hooks/use-train-update-state', () => ({
  useTrainUpdateState: () => ({
    state: trainUpdateStateOverride ?? { status: 'idle', version: null },
    minShellBlocked: minShellBlockedOverride,
    checkNow: checkTrainNow,
    applyNow: applyTrainNow,
  }),
}));

vi.mock('@/ui', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/ui')>(),
  Toggle: ({
    on,
    onChange,
    label,
    ariaLabel,
  }: {
    on: boolean | undefined;
    onChange: (next: boolean) => void;
    label?: string;
    ariaLabel?: string;
  }) => (
    <button
      type="button"
      aria-label={ariaLabel || label}
      aria-busy={on === undefined ? 'true' : undefined}
      aria-checked={on === undefined ? 'mixed' : on ? 'true' : 'false'}
      data-testid={`${ariaLabel || label}-${on === undefined ? 'loading' : on ? 'on' : 'off'}`}
      disabled={on === undefined}
      onClick={() => {
        if (on !== undefined) onChange(!on);
      }}
    >
      toggle
    </button>
  ),
}));

const autoSaveConfig = vi.fn();
const loadSettingsConfig = vi.fn();

vi.mock('../../helpers', () => ({
  t: (key: string) => key,
  autoSaveConfig: (...args: unknown[]) => autoSaveConfig(...args),
}));

vi.mock('../../actions', () => ({
  loadSettingsConfig: (...args: unknown[]) => loadSettingsConfig(...args),
}));

import { AboutTab } from '../AboutTab';
import { useSettingsStore } from '../../store';

afterEach(() => {
  cleanup();
  autoSaveConfig.mockReset();
  loadSettingsConfig.mockReset();
  checkTrainNow.mockReset();
  applyTrainNow.mockReset();
  trainUpdateStateOverride = null;
  shellUpdateStateOverride = null;
  minShellBlockedOverride = false;
  useSettingsStore.setState({ settingsConfig: null });
  vi.unstubAllGlobals();
});

function installHana(overrides: Record<string, unknown> = {}) {
  vi.stubGlobal('window', Object.assign(window, {
    hana: {
      getAppVersion: vi.fn().mockResolvedValue('0.160.2'),
      autoUpdateCheck: vi.fn(),
      autoUpdateInstall: vi.fn(),
      autoUpdateSetChannel: vi.fn(),
      openExternal: vi.fn(),
      getUpdateDigestHistory: vi.fn().mockResolvedValue({ entries: [], source: 'none', complete: false }),
      ...overrides,
    },
  }));
}

const digest = (version: string) => ({
  schemaVersion: 1 as const,
  tag: `v${version}`,
  version,
  previousTag: '',
  generatedAt: '2026-07-01T00:00:00.000Z',
  noUserFacingChanges: false,
  summary: { zh: `${version} 摘要`, en: `${version} summary` },
  counts: { feature: 0, fix: 1, improvement: 0, migration: 0 },
  items: [{
    id: `${version}-fix`,
    kind: 'fix' as const,
    importance: 'high' as const,
    title: { zh: `${version} 修复`, en: `${version} fix` },
    summary: { zh: `${version} 修复说明`, en: `${version} fix detail` },
    details: [],
    sources: [],
  }],
});

describe('AboutTab', () => {
  it('keeps startup and background controls out of the about page', () => {
    installHana();
    useSettingsStore.setState({ settingsConfig: { auto_check_updates: true, update_channel: 'stable' } });

    render(<AboutTab />);

    expect(screen.getByText('settings.about.autoCheckUpdates')).toBeTruthy();
    expect(screen.getByText('settings.about.betaUpdates')).toBeTruthy();
    expect(screen.queryByText('settings.general.launchAtLogin')).toBeNull();
    expect(screen.queryByText('settings.general.keepAwake')).toBeNull();
  });

  it('keeps update switches in loading state until settings config is ready', () => {
    installHana();
    useSettingsStore.setState({ settingsConfig: null });

    render(<AboutTab />);

    const switches = screen.getAllByRole('button').filter(
      el => el.getAttribute('aria-checked') === 'mixed',
    ) as HTMLButtonElement[];
    expect(switches).toHaveLength(2);
    for (const item of switches) {
      expect(item.disabled).toBe(true);
      fireEvent.click(item);
    }
    expect(autoSaveConfig).not.toHaveBeenCalled();
    expect(loadSettingsConfig).not.toHaveBeenCalled();
  });

  it('does not render the platform-update row when no shell update is pending', () => {
    installHana();
    useSettingsStore.setState({ settingsConfig: { auto_check_updates: true, update_channel: 'stable' } });
    shellUpdateStateOverride = { status: 'idle' };

    render(<AboutTab />);

    expect(screen.queryByText('settings.about.shellStickerTitle')).toBeNull();
  });

  it('renders the platform-update row only while a shell update is downloaded, and wires it to autoUpdateInstall', () => {
    const autoUpdateInstall = vi.fn();
    installHana({ autoUpdateInstall });
    useSettingsStore.setState({ settingsConfig: { auto_check_updates: true, update_channel: 'stable' } });
    shellUpdateStateOverride = { status: 'downloaded', version: '2.0.0' };

    render(<AboutTab />);

    expect(screen.getByText('settings.about.shellStickerTitle')).toBeTruthy();
    expect(screen.getByText('v2.0.0')).toBeTruthy();

    fireEvent.click(screen.getByText('settings.about.updateInstall'));
    expect(autoUpdateInstall).toHaveBeenCalledTimes(1);
  });

  it('escalates the platform-update row copy when minShellBlocked is true (two-tier copy)', () => {
    installHana();
    useSettingsStore.setState({ settingsConfig: { auto_check_updates: true, update_channel: 'stable' } });
    shellUpdateStateOverride = { status: 'downloaded', version: '2.0.0' };
    minShellBlockedOverride = true;

    render(<AboutTab />);

    expect(screen.getByText('settings.about.shellStickerTitleBlocking')).toBeTruthy();
    expect(screen.queryByText('settings.about.shellStickerTitle')).toBeNull();
  });

  it('the beta toggle drives both the shell channel IPC and a train update check', async () => {
    const autoUpdateSetChannel = vi.fn();
    installHana({ autoUpdateSetChannel });
    useSettingsStore.setState({ settingsConfig: { auto_check_updates: true, update_channel: 'stable' } });

    render(<AboutTab />);

    // Toggle rows render in JSX order: autoCheckUpdates, then betaUpdates —
    // pick the second toggle (mocked Toggle exposes aria-checked).
    const toggles = screen.getAllByRole('button').filter(b => b.hasAttribute('aria-checked'));
    expect(toggles).toHaveLength(2);
    await act(async () => {
      fireEvent.click(toggles[1]);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(autoUpdateSetChannel).toHaveBeenCalledWith('beta');
    expect(autoSaveConfig).toHaveBeenCalledWith({ update_channel: 'beta' }, { silent: true });
    expect(checkTrainNow).toHaveBeenCalledTimes(1);
  });

  it('loads the newest five releases only after the update-history dialog is opened', async () => {
    const getUpdateDigestHistory = vi.fn().mockResolvedValue({
      entries: [
        digest('0.400.5'),
        digest('0.400.4'),
        digest('0.400.3'),
        digest('0.400.2'),
        digest('0.400.1'),
      ],
      source: 'online',
      complete: true,
    });
    installHana({
      getUpdateDigestHistory,
    });
    useSettingsStore.setState({ settingsConfig: { auto_check_updates: true, update_channel: 'stable' } });

    render(<AboutTab />);

    expect(getUpdateDigestHistory).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'settings.about.updateHistoryTitle' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'settings.about.updateHistoryTitle' }));

    expect(await screen.findByRole('dialog', { name: 'settings.about.updateHistoryTitle' })).toBeTruthy();
    expect(await screen.findByText('v0.400.5')).toBeTruthy();
    expect(screen.getByText('v0.400.1')).toBeTruthy();
    expect(getUpdateDigestHistory).toHaveBeenCalledTimes(1);
  });

  it('shows an explicit bundled-history warning when online history is unavailable', async () => {
    installHana({
      getUpdateDigestHistory: vi.fn().mockResolvedValue({
        entries: [digest('0.400.0')],
        source: 'bundled',
        complete: false,
      }),
    });
    useSettingsStore.setState({ settingsConfig: { auto_check_updates: true, update_channel: 'stable' } });

    render(<AboutTab />);
    fireEvent.click(screen.getByRole('button', { name: 'settings.about.updateHistoryTitle' }));

    expect(await screen.findByText('settings.about.updateHistoryOffline')).toBeTruthy();
    expect(screen.getByText('v0.400.0')).toBeTruthy();
  });
});

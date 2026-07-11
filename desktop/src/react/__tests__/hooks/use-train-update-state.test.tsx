/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTrainUpdateState } from '../../hooks/use-train-update-state';
import type { PlatformApi, TrainUpdateStatus } from '../../types';

function Harness() {
  const { state, checkNow, applyNow } = useTrainUpdateState();
  return (
    <div>
      <div data-testid="status">{state.status}</div>
      <div data-testid="version">{state.version ?? 'none'}</div>
      <button onClick={() => void checkNow()}>check</button>
      <button onClick={() => void applyNow()}>apply</button>
    </div>
  );
}

describe('useTrainUpdateState', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('starts idle when nothing is staged', async () => {
    window.hana = {
      trainUpdateStatus: vi.fn().mockResolvedValue({ staged: false, train: null, version: null, minShellBlocked: false }),
    } as unknown as PlatformApi;

    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('idle'));
  });

  it('hydrates "downloaded" (apply-ready) status with the staged version on mount', async () => {
    window.hana = {
      trainUpdateStatus: vi.fn().mockResolvedValue({ staged: true, train: 5, version: '0.400.0', minShellBlocked: false }),
    } as unknown as PlatformApi;

    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('downloaded'));
    expect(screen.getByTestId('version').textContent).toBe('0.400.0');
  });

  it('checkNow transitions checking -> downloaded when a train becomes staged', async () => {
    let staged: TrainUpdateStatus = { staged: false, train: null, version: null, minShellBlocked: false };
    const trainUpdateCheck = vi.fn().mockImplementation(async () => {
      staged = { staged: true, train: 9, version: '0.401.0', minShellBlocked: false };
      return { outcome: 'staged', train: 9 };
    });
    window.hana = {
      trainUpdateStatus: vi.fn().mockImplementation(async () => staged),
      trainUpdateCheck,
    } as unknown as PlatformApi;

    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('idle'));

    await act(async () => {
      screen.getByText('check').click();
    });

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('downloaded'));
    expect(screen.getByTestId('version').textContent).toBe('0.401.0');
    expect(trainUpdateCheck).toHaveBeenCalledTimes(1);
  });

  it('checkNow transitions to "latest" when the check finds nothing staged', async () => {
    window.hana = {
      trainUpdateStatus: vi.fn().mockResolvedValue({ staged: false, train: null, version: null, minShellBlocked: false }),
      trainUpdateCheck: vi.fn().mockResolvedValue({ outcome: 'not-modified' }),
    } as unknown as PlatformApi;

    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('idle'));

    await act(async () => {
      screen.getByText('check').click();
    });

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('latest'));
  });

  it('checkNow surfaces an error outcome as status "error"', async () => {
    window.hana = {
      trainUpdateStatus: vi.fn().mockResolvedValue({ staged: false, train: null, version: null, minShellBlocked: false }),
      trainUpdateCheck: vi.fn().mockResolvedValue({ outcome: 'error', error: 'network down' }),
    } as unknown as PlatformApi;

    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('idle'));

    await act(async () => {
      screen.getByText('check').click();
    });

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('error'));
  });

  it('applyNow delegates straight to window.hana.trainUpdateApply', async () => {
    const trainUpdateApply = vi.fn().mockResolvedValue({ ok: true });
    window.hana = {
      trainUpdateStatus: vi.fn().mockResolvedValue({ staged: true, train: 1, version: '0.1.0', minShellBlocked: false }),
      trainUpdateApply,
    } as unknown as PlatformApi;

    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('downloaded'));

    await act(async () => {
      screen.getByText('apply').click();
    });

    expect(trainUpdateApply).toHaveBeenCalledTimes(1);
  });
});

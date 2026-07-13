// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MentionMenu } from '../../components/input/MentionMenu';

describe('MentionMenu', () => {
  afterEach(cleanup);

  it('switches among Files, Sessions, and Agents without changing selection implicitly', () => {
    const onTabChange = vi.fn();
    render(
      <MentionMenu
        tab="sessions"
        items={[{
          kind: 'session', id: 'session:sess_a', sessionId: 'sess_a', name: 'Earlier plan',
          detail: 'Hana · sess_a', agentId: 'hana', agentName: 'Hana',
        }]}
        selected={0}
        busy={false}
        agents={[]}
        onTabChange={onTabChange}
        onSelect={vi.fn()}
        onHover={vi.fn()}
      />,
    );

    expect(screen.getByRole('tab', { name: 'input.mention.tab.sessions' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'input.mention.tab.agents' }));
    expect(onTabChange).toHaveBeenCalledWith('agents');
    expect(screen.getByText(/sess_a/)).toBeInTheDocument();
  });
});

import { describe, expect, it } from 'vitest';
import { buildAgentMentionItems, buildSessionMentionItems } from '../../utils/mention-items';

describe('mention items', () => {
  it('builds Session candidates only from stable Session IDs', () => {
    const items = buildSessionMentionItems({
      query: 'plan',
      sessions: [{
        path: '/tmp/a.jsonl', sessionId: 'sess_a', title: 'Plan review', firstMessage: '', modified: '',
        messageCount: 1, agentId: 'hana', agentName: 'Hana', cwd: null,
      }, {
        path: '/tmp/legacy.jsonl', sessionId: null, title: 'Legacy plan', firstMessage: '', modified: '',
        messageCount: 1, agentId: 'hana', agentName: 'Hana', cwd: null,
      }],
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ sessionId: 'sess_a', name: 'Plan review' });
  });

  it('excludes the current Agent while filtering by name and model', () => {
    const items = buildAgentMentionItems({
      query: 'review',
      currentAgentId: 'hana',
      agents: [
        { id: 'hana', name: 'Review Hana', yuan: 'hana', isPrimary: true },
        { id: 'critic', name: 'Reviewer', yuan: 'critic', isPrimary: false, chatModel: { id: 'review-model' } },
      ],
    });

    expect(items.map(item => item.agentId)).toEqual(['critic']);
  });
});

import { memo, useMemo, useState } from 'react';
import type { ChatMessage } from '../../stores/chat-types';
import { AgentAvatar, resolveAgentDisplayInfo } from '../../utils/agent-display';
import { useStore } from '../../stores';
import styles from './Chat.module.css';

const COLLAPSE_LINES = 12;
const COLLAPSE_CHARS = 900;

export const AgentOriginMessage = memo(function AgentOriginMessage({ message }: { message: ChatMessage }) {
  const agents = useStore(s => s.agents);
  const [expanded, setExpanded] = useState(false);

  const origin = message.origin;
  if (!origin) {
    throw new Error('AgentOriginMessage requires message.origin to be set');
  }

  const info = resolveAgentDisplayInfo({
    id: origin.agentId,
    agents,
    fallbackAgentName: origin.agentName || origin.agentId || 'Agent',
    fallbackAgentYuan: origin.agentId || '',
  });
  const text = message.text || '';
  const collapsible = useMemo(
    () => text.split('\n').length > COLLAPSE_LINES || text.length > COLLAPSE_CHARS,
    [text],
  );

  return (
    <div className={styles.agentOriginRow}>
      <div className={styles.agentOriginCard}>
        <div className={styles.agentOriginHeader}>
          <AgentAvatar info={info} className={styles.agentOriginAvatar} />
          <span className={styles.agentOriginName}>
            {window.t('sessionCollab.fromAgent', { name: origin.agentName || origin.agentId || 'Agent' })}
          </span>
        </div>
        <div className={`${styles.agentOriginBody}${collapsible && !expanded ? ` ${styles.agentOriginBodyCollapsed}` : ''}`}>
          {text}
        </div>
        {collapsible && (
          <button
            type="button"
            className={styles.agentOriginToggle}
            onClick={() => setExpanded(v => !v)}
          >
            {expanded ? window.t('sessionCollab.collapse') : window.t('sessionCollab.expand')}
          </button>
        )}
      </div>
    </div>
  );
});

import { NodeViewWrapper } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import styles from './MentionBadgeView.module.css';

export function MentionBadgeView({ node }: NodeViewProps) {
  const label = String(node.attrs.label || node.attrs.sessionId || node.attrs.agentId || '');
  const kind = node.type.name === 'agentBadge' ? 'agent' : 'session';

  return (
    <NodeViewWrapper as="span" className={styles.badge} data-mention-kind={kind}>
      <span className={styles.at} aria-hidden="true">@</span>
      <span className={styles.icon} aria-hidden="true">
        {kind === 'agent' ? <AgentMentionIcon /> : <SessionMentionIcon />}
      </span>
      <span className={styles.name}>{label}</span>
    </NodeViewWrapper>
  );
}

function AgentMentionIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="8" r="4" />
      <path d="M5 21a7 7 0 0 1 14 0" />
    </svg>
  );
}

function SessionMentionIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="4" y="3" width="16" height="18" rx="1" />
      <path d="M8 8h8M8 12h8M8 16h5" />
    </svg>
  );
}

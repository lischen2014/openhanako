import { memo, useCallback, useMemo, useState } from 'react';
import type { AgentReviewContext } from '../../stores/chat-types';
import { useStore } from '../../stores';
import { loadSessions, switchSession } from '../../stores/session-actions';
import { AgentAvatar, resolveAgentDisplayInfo } from '../../utils/agent-display';
import { renderMarkdown } from '../../utils/markdown';
import { MarkdownContent } from './MarkdownContent';
import styles from './Chat.module.css';
import { ConversationEventCard } from './ConversationEventCard';
import { useI18n } from '../../hooks/use-i18n';

export const AgentReviewCard = memo(function AgentReviewCard({ review }: { review: AgentReviewContext }) {
  const agents = useStore(state => state.agents);
  const [opening, setOpening] = useState(false);
  const { t } = useI18n();
  const info = useMemo(() => resolveAgentDisplayInfo({
    id: review.reviewerAgentId,
    agents,
    fallbackAgentName: review.reviewerAgentName,
  }), [agents, review.reviewerAgentId, review.reviewerAgentName]);

  const openReviewerSession = useCallback(async () => {
    const sessionId = review.reviewerSessionId?.trim();
    if (!sessionId || opening) return;
    setOpening(true);
    try {
      let target = useStore.getState().sessions.find(session => session.sessionId === sessionId);
      if (!target) {
        await loadSessions();
        target = useStore.getState().sessions.find(session => session.sessionId === sessionId);
      }
      if (!target) {
        useStore.getState().addToast(t('agentReview.sessionUnavailable'), 'error', 5000);
        return;
      }
      await switchSession(target.path);
    } finally {
      setOpening(false);
    }
  }, [opening, review.reviewerSessionId, t]);

  const statusLabel = review.status === 'running'
    ? t('agentReview.running')
    : review.status === 'completed'
      ? t('agentReview.completed')
      : review.status === 'cancelled'
        ? t('agentReview.cancelled')
        : t('agentReview.failed');

  return (
    <ConversationEventCard
      align="end"
      size="expanded"
      cardClassName={styles.agentReviewCard}
      status={review.status}
    >
      <header className={styles.agentReviewHeader}>
        <AgentAvatar info={info} className={styles.agentReviewAvatar} alt="" />
        <div className={styles.agentReviewHeading}>
          <span className={styles.agentReviewName}>{review.reviewerAgentName}</span>
          <span className={styles.agentReviewStatus}>{statusLabel}</span>
        </div>
        {review.status === 'running' && <span className={styles.agentReviewPulse} aria-hidden="true" />}
      </header>
      {review.status === 'completed' && review.text && (
        <div className={styles.agentReviewBody}>
          <MarkdownContent html={renderMarkdown(review.text)} />
        </div>
      )}
      {(review.status === 'failed' || review.status === 'cancelled') && (
        <div className={styles.agentReviewError}>{review.error || statusLabel}</div>
      )}
      {review.reviewerSessionId && (
        <footer className={styles.agentReviewFooter}>
          <button type="button" onClick={() => { void openReviewerSession(); }} disabled={opening}>
            {opening ? t('common.loading') : t('agentReview.openSession')}
          </button>
          <span>{review.reviewerSessionId}</span>
        </footer>
      )}
    </ConversationEventCard>
  );
});

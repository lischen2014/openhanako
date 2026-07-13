import { memo, useCallback, useState } from 'react';
import type { AgentReviewRequestContext } from '../../stores/chat-types';
import { useStore } from '../../stores';
import { loadSessions, switchSession } from '../../stores/session-actions';
import styles from './Chat.module.css';
import { useI18n } from '../../hooks/use-i18n';

export const AgentReviewRequestCard = memo(function AgentReviewRequestCard({
  request,
}: {
  request: AgentReviewRequestContext;
}) {
  const [opening, setOpening] = useState(false);
  const { t } = useI18n();
  const openReviewedSession = useCallback(async () => {
    if (opening) return;
    setOpening(true);
    try {
      let target = useStore.getState().sessions.find(session => session.sessionId === request.reviewedSessionId);
      if (!target) {
        await loadSessions();
        target = useStore.getState().sessions.find(session => session.sessionId === request.reviewedSessionId);
      }
      if (!target) {
        useStore.getState().addToast(t('agentReview.sessionUnavailable'), 'error', 5000);
        return;
      }
      await switchSession(target.path);
    } finally {
      setOpening(false);
    }
  }, [opening, request.reviewedSessionId, t]);

  return (
    <aside className={styles.agentReviewRequestCard}>
      <span>{t('agentReview.requestReceived')}</span>
      <button type="button" onClick={() => { void openReviewedSession(); }} disabled={opening}>
        {opening ? t('common.loading') : t('agentReview.openReviewedSession')}
      </button>
      <code>{request.reviewedSessionId}</code>
    </aside>
  );
});

import type { ReactNode } from 'react';
import styles from './Chat.module.css';

export function ConversationEventCard({
  children,
  align = 'center',
  size = 'compact',
  rowClassName = '',
  cardClassName = '',
  status,
}: {
  children: ReactNode;
  align?: 'center' | 'end';
  size?: 'compact' | 'expanded';
  rowClassName?: string;
  cardClassName?: string;
  status?: string;
}) {
  return (
    <div className={`${styles.conversationEventRow} ${styles[`conversationEventRow-${align}`]} ${rowClassName}`.trim()}>
      <section
        className={`${styles.conversationEventCard} ${styles[`conversationEventCard-${size}`]} ${cardClassName}`.trim()}
        {...(status ? { 'data-event-status': status } : {})}
      >
        {children}
      </section>
    </div>
  );
}

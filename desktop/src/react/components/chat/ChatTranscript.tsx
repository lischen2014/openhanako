import { memo, useCallback, useMemo } from 'react';
import type { ChatListItem, ChatMessage } from '../../stores/chat-types';
import { UserMessage } from './UserMessage';
import { AgentOriginMessage } from './AgentOriginMessage';
import { AssistantMessage } from './AssistantMessage';
import { ProcessFoldBlock } from './ProcessFoldBlock';
import { InterludeBlock } from './InterludeBlock';
import { buildTranscriptRenderItems, type TranscriptRenderItem } from './process-fold';
import { useStore } from '../../stores';
import { selectIsStreamingSession, selectSelectedIdsBySession } from '../../stores/session-selectors';
import { resolveAgentDisplayInfo, type AgentDisplayInfo } from '../../utils/agent-display';

interface Props {
  items: ChatListItem[];
  sessionPath: string;
  agentId?: string | null;
  readOnly?: boolean;
  hideUserIdentity?: boolean;
  userIdentity?: { name?: string | null; avatarUrl?: string | null };
  registerMessageElement?: (messageId: string, element: HTMLDivElement | null) => void;
  enableProcessFold?: boolean;
}

export const ChatTranscript = memo(function ChatTranscript({
  items,
  sessionPath,
  agentId,
  readOnly = false,
  hideUserIdentity = false,
  userIdentity,
  registerMessageElement,
  enableProcessFold = false,
}: Props) {
  const isStreaming = useStore(s => selectIsStreamingSession(s, sessionPath));
  const agents = useStore(s => s.agents);
  const globalAgentName = useStore(s => s.agentName) || 'Hanako';
  const globalYuan = useStore(s => s.agentYuan) || 'hanako';
  const selectedIds = useStore(s => selectSelectedIdsBySession(s, sessionPath));
  const userAvatarUrl = useStore(s => s.userAvatarUrl);
  const storeUserName = useStore(s => s.userName);
  const t = window.t ?? ((p: string) => p);
  const agentDisplay = useMemo<AgentDisplayInfo & { yuan: string }>(() => {
    const info = resolveAgentDisplayInfo({
      id: agentId || null,
      agents,
      fallbackAgentName: globalAgentName,
      fallbackAgentYuan: globalYuan,
    });
    return { ...info, yuan: info.yuan || globalYuan };
  }, [agentId, agents, globalAgentName, globalYuan]);
  const viewerIdentity = useMemo(() => ({
    name: storeUserName || t('common.me'),
    avatarUrl: userAvatarUrl,
  }), [storeUserName, userAvatarUrl, t]);
  const renderItems = useMemo(
    () => enableProcessFold
      ? buildTranscriptRenderItems(items, { isStreaming })
      : items.map((item, originalIndex) => ({ type: 'source' as const, item, originalIndex })),
    [enableProcessFold, isStreaming, items],
  );
  const turnState = useMemo(() => buildTurnState(items), [items]);

  return (
    <>
      {renderItems.map((renderItem) => (
        <TranscriptRenderItemView
          key={renderItemKey(renderItem)}
          renderItem={renderItem}
          sourceItems={items}
          sessionPath={sessionPath}
          agentId={agentId}
          readOnly={readOnly}
          hideUserIdentity={hideUserIdentity}
          userIdentity={userIdentity}
          latestUserMessage={turnState.latestUserMessage}
          latestUserIndex={turnState.latestUserIndex}
          latestAssistantIndex={turnState.latestAssistantIndex}
          turnCompletionAssistantIndexes={turnState.turnCompletionAssistantIndexes}
          assistantTurnSelectionIdsByCompletionIndex={turnState.assistantTurnSelectionIdsByCompletionIndex}
          isStreamingSession={isStreaming}
          agentDisplay={agentDisplay}
          viewerIdentity={viewerIdentity}
          selectedIds={selectedIds}
          registerMessageElement={registerMessageElement}
        />
      ))}
    </>
  );
});

function renderItemKey(renderItem: TranscriptRenderItem): string {
  if (renderItem.type === 'process_fold') return renderItem.id;
  const item = renderItem.item;
  if (item.type === 'message') return item.data.id;
  if (item.type === 'interlude') return `i-${item.id}`;
  return `c-${renderItem.originalIndex}`;
}

function buildTurnState(items: ChatListItem[]): {
  latestUserIndex: number;
  latestAssistantIndex: number;
  latestUserMessage: ChatMessage | null;
  turnCompletionAssistantIndexes: ReadonlySet<number>;
  assistantTurnSelectionIdsByCompletionIndex: ReadonlyMap<number, readonly string[]>;
} {
  let latestUserIndex = -1;
  let latestAssistantIndex = -1;
  let latestUserMessage: ChatMessage | null = null;
  let pendingAssistantIndex = -1;
  let pendingAssistantTurnIds: string[] = [];
  const turnCompletionAssistantIndexes = new Set<number>();
  const assistantTurnSelectionIdsByCompletionIndex = new Map<number, readonly string[]>();

  const completePendingAssistantTurn = () => {
    if (pendingAssistantIndex < 0) return;
    turnCompletionAssistantIndexes.add(pendingAssistantIndex);
    assistantTurnSelectionIdsByCompletionIndex.set(pendingAssistantIndex, pendingAssistantTurnIds);
    pendingAssistantIndex = -1;
    pendingAssistantTurnIds = [];
  };

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item.type !== 'message') continue;

    if (item.data.role === 'user') {
      completePendingAssistantTurn();
      latestUserIndex = i;
      latestUserMessage = item.data;
      continue;
    }

    if (item.data.role === 'assistant') {
      pendingAssistantIndex = i;
      pendingAssistantTurnIds = [...pendingAssistantTurnIds, item.data.id];
      latestAssistantIndex = i;
    }
  }

  completePendingAssistantTurn();

  return {
    latestUserIndex,
    latestAssistantIndex,
    latestUserMessage,
    turnCompletionAssistantIndexes,
    assistantTurnSelectionIdsByCompletionIndex,
  };
}

const TranscriptRenderItemView = memo(function TranscriptRenderItemView({
  renderItem,
  sourceItems,
  sessionPath,
  agentId,
  readOnly,
  hideUserIdentity,
  userIdentity,
  latestUserMessage,
  latestUserIndex,
  latestAssistantIndex,
  turnCompletionAssistantIndexes,
  assistantTurnSelectionIdsByCompletionIndex,
  isStreamingSession,
  agentDisplay,
  viewerIdentity,
  selectedIds,
  registerMessageElement,
}: {
  renderItem: TranscriptRenderItem;
  sourceItems: ChatListItem[];
  sessionPath: string;
  agentId?: string | null;
  readOnly: boolean;
  hideUserIdentity: boolean;
  userIdentity?: { name?: string | null; avatarUrl?: string | null };
  latestUserMessage?: ChatMessage | null;
  latestUserIndex: number;
  latestAssistantIndex: number;
  turnCompletionAssistantIndexes: ReadonlySet<number>;
  assistantTurnSelectionIdsByCompletionIndex: ReadonlyMap<number, readonly string[]>;
  isStreamingSession: boolean;
  agentDisplay: AgentDisplayInfo & { yuan: string };
  viewerIdentity: { name: string; avatarUrl: string | null };
  selectedIds: readonly string[];
  registerMessageElement?: (messageId: string, element: HTMLDivElement | null) => void;
}) {
  const originalIndex = renderItem.originalIndex;
  const prevMessageItem = previousMessageItem(sourceItems, originalIndex);

  if (renderItem.type === 'process_fold') {
    const prevRole = prevMessageItem?.data.role ?? null;
    return (
      <ProcessFoldBlock
        group={renderItem}
        showAvatar={prevRole !== 'assistant'}
        sessionPath={sessionPath}
        agentId={agentId}
        readOnly={readOnly}
        turnCompletionAssistantIndexes={turnCompletionAssistantIndexes}
        assistantTurnSelectionIdsByCompletionIndex={assistantTurnSelectionIdsByCompletionIndex}
        completionTimePersistent={
          turnCompletionAssistantIndexes.has(groupLastOriginalIndex(renderItem))
          && groupLastOriginalIndex(renderItem) === latestAssistantIndex
          && latestAssistantIndex > latestUserIndex
          && !isStreamingSession
        }
        agentDisplay={agentDisplay}
        isStreaming={isStreamingSession}
        selectedIds={selectedIds}
        registerMessageElement={registerMessageElement}
      />
    );
  }

  const showTurnCompletionTime = turnCompletionAssistantIndexes.has(originalIndex)
    && !(
      isStreamingSession
      && originalIndex === latestAssistantIndex
      && latestAssistantIndex > latestUserIndex
    );

  return (
    <TranscriptItemView
      item={renderItem.item}
      prevItem={prevMessageItem}
      sessionPath={sessionPath}
      agentId={agentId}
      readOnly={readOnly}
      hideUserIdentity={hideUserIdentity}
      userIdentity={userIdentity}
      latestUserMessage={latestUserMessage}
      isLatestUserMessage={originalIndex === latestUserIndex}
      isLatestAssistantMessage={
        originalIndex === latestAssistantIndex
        && latestAssistantIndex > latestUserIndex
      }
      showTurnCompletionTime={showTurnCompletionTime}
      assistantTurnSelectionIds={showTurnCompletionTime
        ? assistantTurnSelectionIdsByCompletionIndex.get(originalIndex)
        : undefined}
      agentDisplay={agentDisplay}
      viewerIdentity={viewerIdentity}
      isStreaming={isStreamingSession}
      selectedIds={selectedIds}
      registerMessageElement={registerMessageElement}
    />
  );
});

function previousMessageItem(items: ChatListItem[], beforeIndex: number): Extract<ChatListItem, { type: 'message' }> | undefined {
  for (let i = beforeIndex - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.type === 'message') return item;
  }
  return undefined;
}

function groupLastOriginalIndex(renderItem: Extract<TranscriptRenderItem, { type: 'process_fold' }>): number {
  return renderItem.items[renderItem.items.length - 1]?.originalIndex ?? renderItem.originalIndex;
}

const TranscriptItemView = memo(function TranscriptItemView({
  item,
  prevItem,
  sessionPath,
  agentId,
  readOnly,
  hideUserIdentity,
  userIdentity,
  latestUserMessage,
  isLatestUserMessage,
  isLatestAssistantMessage,
  showTurnCompletionTime,
  assistantTurnSelectionIds,
  agentDisplay,
  viewerIdentity,
  isStreaming,
  selectedIds,
  registerMessageElement,
}: {
  item: ChatListItem;
  prevItem?: ChatListItem;
  sessionPath: string;
  agentId?: string | null;
  readOnly: boolean;
  hideUserIdentity: boolean;
  userIdentity?: { name?: string | null; avatarUrl?: string | null };
  latestUserMessage?: ChatMessage | null;
  isLatestUserMessage: boolean;
  isLatestAssistantMessage: boolean;
  showTurnCompletionTime: boolean;
  assistantTurnSelectionIds?: readonly string[];
  agentDisplay: AgentDisplayInfo & { yuan: string };
  viewerIdentity: { name: string; avatarUrl: string | null };
  isStreaming: boolean;
  selectedIds: readonly string[];
  registerMessageElement?: (messageId: string, element: HTMLDivElement | null) => void;
}) {
  const messageId = item.type === 'message' ? item.data.id : null;
  const messageRef = useCallback((element: HTMLDivElement | null) => {
    if (messageId) registerMessageElement?.(messageId, element);
  }, [messageId, registerMessageElement]);

  if (item.type === 'compaction') return null;
  if (item.type === 'interlude') return <InterludeBlock block={item.data} />;

  const msg = item.data;
  const prevRole = prevItem?.type === 'message' ? prevItem.data.role : null;
  const showAvatar = msg.role !== prevRole;

  if (msg.role === 'user') {
    return msg.origin ? (
      <AgentOriginMessage message={msg} />
    ) : (
      <UserMessage
        message={msg}
        showAvatar={showAvatar}
        sessionPath={sessionPath}
        readOnly={readOnly}
        hideIdentity={hideUserIdentity}
        userIdentity={userIdentity}
        viewerIdentity={viewerIdentity}
        isStreaming={isStreaming}
        isSelected={selectedIds.includes(msg.id)}
        isLatestUserMessage={isLatestUserMessage}
        messageRef={messageRef}
      />
    );
  }

  return (
    <AssistantMessage
      message={msg}
      showAvatar={showAvatar}
      sessionPath={sessionPath}
      agentId={agentId}
      readOnly={readOnly}
      agentDisplay={agentDisplay}
      isStreaming={isStreaming}
      isSelected={selectedIds.includes(msg.id)}
      isLatestAssistantMessage={isLatestAssistantMessage}
      showTurnCompletionTime={showTurnCompletionTime}
      assistantTurnSelectionIds={assistantTurnSelectionIds}
      retrySourceMessage={latestUserMessage}
      messageRef={messageRef}
    />
  );
});

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  appendConnectionAuth,
  buildConnectionUrl,
  buildConnectionWsUrl,
  createLocalServerConnection,
  type ServerConnection,
} from '../services/server-connection';
import styles from './QuickChatApp.module.css';

type PermissionMode = 'auto' | 'operate' | 'ask' | 'read_only';

interface AgentOption {
  id: string;
  name: string;
  yuan?: string | null;
  isPrimary?: boolean;
  isCurrent?: boolean;
}

interface QuickAttachment {
  id: string;
  file: File;
  name: string;
  mimeType: string;
  previewUrl: string;
}

interface QuickMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  attachments?: Array<{ id: string; name: string; previewUrl: string }>;
  error?: boolean;
  streaming?: boolean;
}

interface DetachedSessionResponse {
  ok?: boolean;
  path?: string;
  permissionMode?: PermissionMode;
  error?: string;
}

function ShieldIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3.5 19 6v5.4c0 4.1-2.7 7.5-7 9.1-4.3-1.6-7-5-7-9.1V6l7-2.5Z" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h13" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function classNames(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(' ');
}

function modeLabel(mode: PermissionMode | null) {
  if (mode === 'auto') return '自动审核';
  if (mode === 'operate') return '完整权限';
  if (mode === 'read_only') return '只读模式';
  return '操作前询问';
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      resolve(dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl);
    };
    reader.onerror = () => reject(reader.error || new Error('read file failed'));
    reader.readAsDataURL(file);
  });
}

function normalizeAgentName(agent: AgentOption | null | undefined) {
  return agent?.name?.trim() || agent?.id || 'Agent';
}

function agentInitial(agent: AgentOption | null | undefined) {
  return normalizeAgentName(agent).slice(0, 1).toUpperCase();
}

export function QuickChatApp() {
  const [connection, setConnection] = useState<ServerConnection | null>(null);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('ask');
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<QuickAttachment[]>([]);
  const [messages, setMessages] = useState<QuickMessage[]>([]);
  const [sessionPath, setSessionPath] = useState<string | null>(null);
  const [agentOpen, setAgentOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const sessionPathRef = useRef<string | null>(null);
  const connectionRef = useRef<ServerConnection | null>(null);
  const agentMenuRef = useRef<HTMLDivElement | null>(null);
  const objectUrlsRef = useRef<Set<string>>(new Set());

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId) || agents[0] || null,
    [agents, selectedAgentId],
  );

  useEffect(() => {
    let cancelled = false;
    async function bootstrap() {
      try {
        const [serverPort, serverToken] = await Promise.all([
          window.hana?.getServerPort?.(),
          window.hana?.getServerToken?.(),
        ]);
        const local = createLocalServerConnection({ serverPort, serverToken });
        if (!local) throw new Error('server connection unavailable');
        if (cancelled) return;
        setConnection(local);
        connectionRef.current = local;

        const [agentsRes, healthRes, permissionRes] = await Promise.all([
          fetch(buildConnectionUrl(local, '/api/agents'), {
            headers: appendConnectionAuth(local),
          }),
          fetch(buildConnectionUrl(local, '/api/health'), {
            headers: appendConnectionAuth(local),
          }),
          fetch(buildConnectionUrl(local, '/api/session-permission-mode'), {
            headers: appendConnectionAuth(local),
          }),
        ]);
        const [agentsData, healthData, permissionData] = await Promise.all([
          agentsRes.json(),
          healthRes.json(),
          permissionRes.json(),
        ]);
        if (cancelled) return;
        const nextAgents = Array.isArray(agentsData.agents) ? agentsData.agents : [];
        setAgents(nextAgents);
        const preferred =
          nextAgents.find((agent: AgentOption) => agent.isCurrent)
          || nextAgents.find((agent: AgentOption) => agent.id === healthData.agentId)
          || nextAgents.find((agent: AgentOption) => agent.isPrimary)
          || nextAgents[0]
          || null;
        setSelectedAgentId(preferred?.id || null);
        setPermissionMode((permissionData.defaultMode || permissionData.mode || 'ask') as PermissionMode);
      } catch (err) {
        console.error('[quick-chat] bootstrap failed:', err);
        if (!cancelled) setError('无法连接 Hana 服务');
      }
    }
    bootstrap();
    return () => {
      cancelled = true;
      wsRef.current?.close();
      for (const url of objectUrlsRef.current) URL.revokeObjectURL(url);
      objectUrlsRef.current.clear();
    };
  }, []);

  useEffect(() => {
    sessionPathRef.current = sessionPath;
  }, [sessionPath]);

  useEffect(() => {
    const dispose = window.hana?.onQuickChatShown?.(() => {
      setTimeout(() => textareaRef.current?.focus(), 40);
    });
    return () => { if (typeof dispose === 'function') dispose(); };
  }, []);

  useEffect(() => {
    if (!agentOpen) return;
    const handler = (event: MouseEvent) => {
      if (agentMenuRef.current && !agentMenuRef.current.contains(event.target as Node)) {
        setAgentOpen(false);
        if (messages.length === 0) window.hana?.quickChatResize?.('compact');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [agentOpen, messages.length]);

  const apiFetch = useCallback(async (path: string, init: RequestInit = {}) => {
    const conn = connectionRef.current || connection;
    if (!conn) throw new Error('server connection unavailable');
    const res = await fetch(buildConnectionUrl(conn, path), {
      ...init,
      headers: appendConnectionAuth(conn, init.headers),
    });
    if (!res.ok) throw new Error(`${path}: ${res.status} ${res.statusText}`);
    return res;
  }, [connection]);

  const ensureSocket = useCallback(() => {
    const conn = connectionRef.current || connection;
    if (!conn) throw new Error('server connection unavailable');
    const current = wsRef.current;
    if (current && (current.readyState === WebSocket.OPEN || current.readyState === WebSocket.CONNECTING)) {
      return current;
    }
    const ws = new WebSocket(buildConnectionWsUrl(conn, '/ws'));
    wsRef.current = ws;
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data || '{}'));
        const activeSessionPath = sessionPathRef.current;
        if (msg.sessionPath && activeSessionPath && msg.sessionPath !== activeSessionPath) return;
        if (msg.type === 'text_delta' && typeof msg.delta === 'string') {
          setMessages((items) => items.map((item) => item.role === 'assistant' && item.streaming
            ? { ...item, text: item.text + msg.delta }
            : item));
        } else if (msg.type === 'status') {
          if (msg.isStreaming === false) {
            setMessages((items) => items.map((item) => item.streaming ? { ...item, streaming: false } : item));
            setSending(false);
          }
        } else if (msg.type === 'turn_end') {
          setMessages((items) => items.map((item) => item.streaming
            ? { ...item, streaming: false, text: item.text || '完成了。' }
            : item));
          setSending(false);
        } else if (msg.type === 'error') {
          const text = typeof msg.message === 'string' ? msg.message : '发送失败';
          setMessages((items) => items.map((item) => item.streaming
            ? { ...item, streaming: false, error: true, text }
            : item));
          setError(text);
          setSending(false);
        }
      } catch (err) {
        console.warn('[quick-chat] ws message ignored:', err);
      }
    };
    ws.onclose = () => {
      if (wsRef.current === ws) wsRef.current = null;
    };
    return ws;
  }, [connection]);

  const addFiles = useCallback((files: File[]) => {
    const imageFiles = files.filter((file) => file.type.startsWith('image/'));
    if (imageFiles.length === 0) return;
    setAttachments((prev) => {
      const slots = Math.max(0, 10 - prev.length);
      if (slots === 0) return prev;
      const nextItems = imageFiles.slice(0, slots).map((file) => {
        const previewUrl = URL.createObjectURL(file);
        objectUrlsRef.current.add(previewUrl);
        return {
          id: `${Date.now()}-${file.name}-${Math.random().toString(36).slice(2)}`,
          file,
          name: file.name || 'image',
          mimeType: file.type || 'image/png',
          previewUrl,
        };
      });
      return [...prev, ...nextItems];
    });
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const target = prev.find((item) => item.id === id);
      if (target) {
        URL.revokeObjectURL(target.previewUrl);
        objectUrlsRef.current.delete(target.previewUrl);
      }
      return prev.filter((item) => item.id !== id);
    });
  }, []);

  const ensureDetachedSession = useCallback(async () => {
    if (sessionPathRef.current) return sessionPathRef.current;
    const modeRes = await apiFetch('/api/session-permission-mode');
    const modeData = await modeRes.json();
    const mode = (modeData.defaultMode || modeData.mode || 'ask') as PermissionMode;
    setPermissionMode(mode);
    const res = await apiFetch('/api/sessions/new-detached', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: selectedAgentId,
        permissionMode: mode,
        launchContext: null,
        contextAttachments: [],
      }),
    });
    const data = await res.json() as DetachedSessionResponse;
    if (!data.path) throw new Error(data.error || '创建会话失败');
    setSessionPath(data.path);
    sessionPathRef.current = data.path;
    return data.path;
  }, [apiFetch, selectedAgentId]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if ((!text && attachments.length === 0) || sending) return;
    setSending(true);
    setError(null);
    try {
      const nextSessionPath = await ensureDetachedSession();
      const outgoingAttachments = attachments;
      const images = await Promise.all(outgoingAttachments.map(async (item) => ({
        type: 'image',
        data: await fileToBase64(item.file),
        mimeType: item.mimeType,
      })));
      const userMessage: QuickMessage = {
        id: `user-${Date.now()}`,
        role: 'user',
        text,
        attachments: outgoingAttachments.map((item) => ({
          id: item.id,
          name: item.name,
          previewUrl: item.previewUrl,
        })),
      };
      const assistantMessage: QuickMessage = {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        text: '',
        streaming: true,
      };
      setMessages((items) => [...items, userMessage, assistantMessage]);
      setDraft('');
      setAttachments([]);
      window.hana?.quickChatResize?.('chat');

      const ws = ensureSocket();
      const sendPayload = () => ws.send(JSON.stringify({
        type: 'prompt',
        text,
        sessionPath: nextSessionPath,
        images,
        displayMessage: {
          text,
          attachments: outgoingAttachments.map((item) => ({
            name: item.name,
            mimeType: item.mimeType,
          })),
        },
      }));
      if (ws.readyState === WebSocket.OPEN) {
        sendPayload();
      } else {
        ws.addEventListener('open', sendPayload, { once: true });
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : '发送失败';
      setError(text);
      setSending(false);
    }
  }, [attachments, draft, ensureDetachedSession, ensureSocket, sending]);

  const handlePaste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files: File[] = [];
    for (const item of Array.from(event.clipboardData.items || [])) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file && file.type.startsWith('image/')) files.push(file);
      }
    }
    if (files.length > 0) addFiles(files);
  }, [addFiles]);

  const handleDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    addFiles(Array.from(event.dataTransfer.files || []));
  }, [addFiles]);

  const openAgentMenu = useCallback(() => {
    if (sessionPathRef.current) return;
    const next = !agentOpen;
    setAgentOpen(next);
    window.hana?.quickChatResize?.(next ? 'chat' : (messages.length > 0 ? 'chat' : 'compact'));
  }, [agentOpen, messages.length]);

  const pickAgent = useCallback((agentId: string) => {
    setSelectedAgentId(agentId);
    setAgentOpen(false);
    if (messages.length === 0) window.hana?.quickChatResize?.('compact');
  }, [messages.length]);

  const openFullSession = useCallback(() => {
    if (sessionPathRef.current) window.hana?.quickChatOpenSession?.(sessionPathRef.current);
  }, []);

  const canSend = (!!draft.trim() || attachments.length > 0) && !sending && !!connection;
  const expanded = messages.length > 0 || agentOpen;

  return (
    <div
      className={classNames(styles.host, expanded && styles.expanded)}
      onDrop={handleDrop}
      onDragOver={(event) => event.preventDefault()}
    >
      <section className={styles.panel}>
        {messages.length > 0 && (
          <div className={styles.thread}>
            <div className={styles.threadHeader}>
              <div className={styles.threadTitle}>{normalizeAgentName(selectedAgent)}</div>
              <button className={styles.openSessionButton} onClick={openFullSession} disabled={!sessionPath}>
                打开完整会话
              </button>
            </div>
            <div className={styles.messages}>
              {messages.map((message) => (
                <div key={message.id} className={classNames(styles.message, styles[message.role], message.error && styles.errorMessage)}>
                  {message.text && <div className={styles.messageText}>{message.text}</div>}
                  {message.streaming && !message.text && <div className={styles.typing}>思考中</div>}
                  {message.attachments && message.attachments.length > 0 && (
                    <div className={styles.messageAttachments}>
                      {message.attachments.map((item) => (
                        <img key={item.id} src={item.previewUrl} alt={item.name} />
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className={styles.composer}>
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onPaste={handlePaste}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            placeholder="说点什么..."
            rows={expanded ? 2 : 3}
          />

          {attachments.length > 0 && (
            <div className={styles.attachmentRow}>
              {attachments.map((item) => (
                <button key={item.id} className={styles.attachmentChip} onClick={() => removeAttachment(item.id)} title={item.name}>
                  <img src={item.previewUrl} alt={item.name} />
                </button>
              ))}
            </div>
          )}

          <div className={styles.controlRow}>
            <div className={styles.leftControls}>
              <button className={styles.iconButton} title="添加图片" onClick={() => fileInputRef.current?.click()}>
                <PlusIcon />
              </button>
              <button className={styles.approvalPill} title="跟随主聊天窗口的 Approval 状态" disabled>
                <ShieldIcon />
                <span>{modeLabel(permissionMode)}</span>
              </button>
            </div>

            <div className={styles.rightControls}>
              <div className={styles.agentPicker} ref={agentMenuRef}>
                <button className={styles.agentButton} onClick={openAgentMenu} disabled={agents.length === 0 || !!sessionPath}>
                  <span className={styles.agentAvatarWrap}>
                    {selectedAgent && connection ? (
                      <img
                        className={styles.agentAvatar}
                        src={buildConnectionUrl(connection, `/api/agents/${encodeURIComponent(selectedAgent.id)}/avatar`, { includeTokenQuery: true })}
                        alt=""
                        onError={(event) => { (event.currentTarget as HTMLImageElement).style.display = 'none'; }}
                      />
                    ) : null}
                    <span className={styles.agentInitial}>{agentInitial(selectedAgent)}</span>
                  </span>
                  <span className={styles.agentName}>{normalizeAgentName(selectedAgent)}</span>
                  <ChevronIcon />
                </button>

                {agentOpen && (
                  <div className={styles.agentMenu}>
                    {agents.map((agent) => (
                      <button
                        key={agent.id}
                        className={classNames(styles.agentOption, agent.id === selectedAgentId && styles.agentOptionActive)}
                        onClick={() => pickAgent(agent.id)}
                      >
                        <span className={styles.agentAvatarWrap}>
                          {connection ? (
                            <img
                              className={styles.agentAvatar}
                              src={buildConnectionUrl(connection, `/api/agents/${encodeURIComponent(agent.id)}/avatar`, { includeTokenQuery: true })}
                              alt=""
                              onError={(event) => { (event.currentTarget as HTMLImageElement).style.display = 'none'; }}
                            />
                          ) : null}
                          <span className={styles.agentInitial}>{agentInitial(agent)}</span>
                        </span>
                        <span className={styles.agentOptionText}>
                          <strong>{normalizeAgentName(agent)}</strong>
                          <small>{agent.isPrimary ? '主助手' : agent.id}</small>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <button className={styles.sendButton} onClick={() => void send()} disabled={!canSend} title="发送">
                <ArrowIcon />
              </button>
            </div>
          </div>

          {error && <div className={styles.errorLine}>{error}</div>}
          <input
            ref={fileInputRef}
            className={styles.fileInput}
            type="file"
            accept="image/*"
            multiple
            onChange={(event) => {
              addFiles(Array.from(event.currentTarget.files || []));
              event.currentTarget.value = '';
            }}
          />
        </div>

        <div className={styles.dragStrip} />
      </section>
    </div>
  );
}

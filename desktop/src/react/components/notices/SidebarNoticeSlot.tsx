import { useEffect, useMemo, useState } from 'react';
import { useAutoUpdateState } from '../../hooks/use-auto-update-state';
import { useTrainUpdateState } from '../../hooks/use-train-update-state';
import type { AutoUpdateState, TrainUpdateStatus } from '../../types';
import styles from './SidebarNoticeSlot.module.css';

/**
 * 左下角更新贴纸：列车更新与平台
 * （壳）更新共用同一张贴纸——同一时刻两种态都存在时平台更新优先展示
 * （更稀少、更挡路）。整张贴纸是一颗按钮，点击即触发对应动作；右上角的叉
 * 单独可点，不冒泡到主动作。
 *
 * 两种触发态的叉号语义不同：
 * - 平台更新 = "本 session 安静，下次启动重新出现" —— 用组件内存状态
 *   （不落 localStorage），进程重启即天然重置，不需要额外的"下次启动"判断。
 * - 列车更新 = 沿用既有 dismissed-key 机制（按 "status:version" 存
 *   localStorage，出现新版本自然重新弹出）。
 */
const DISMISSED_TRAIN_UPDATE_KEY = 'hana-sidebar-train-update-dismissed-key';

type NoticeStorage = Pick<Storage, 'getItem' | 'setItem'>;

interface SidebarUpdateNoticeCardProps {
  shellState: AutoUpdateState | null;
  trainStatus: TrainUpdateStatus | null;
  onInstallShell?: () => void | Promise<unknown>;
  onApplyTrain?: () => void | Promise<unknown>;
  storage?: NoticeStorage | null;
}

const tr = (key: string, vars?: Record<string, string | number>) => window.t?.(key, vars) ?? key;

function safeStorage(): NoticeStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readDismissedKey(storage: NoticeStorage | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeDismissedKey(storage: NoticeStorage | null, storageKey: string, value: string): void {
  try {
    storage?.setItem(storageKey, value);
  } catch {
    // Ignore storage failures; the in-memory dismissed state still hides the card for this mount.
  }
}

function trainNoticeKey(status: TrainUpdateStatus | null): string | null {
  if (!status?.staged) return null;
  return status.version ? `version:${status.version}` : 'staged';
}

function RefreshIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 2v6h-6" />
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M3 22v-6h6" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

/**
 * 两态选择，平台更新优先：壳更新待命（'downloaded'）比列车更新更
 * 稀少也更挡路，两者同时存在时优先展示壳更新那张。纯函数，独立可测。
 */
function resolveStickerContent(
  shellState: AutoUpdateState | null,
  trainStatus: TrainUpdateStatus | null,
): { kind: 'shell' | 'train'; title: string; version: string | null } | null {
  if (shellState?.status === 'downloaded') {
    const title = trainStatus?.minShellBlocked
      ? tr('settings.about.shellStickerTitleBlocking')
      : tr('settings.about.shellStickerTitle');
    return { kind: 'shell', title, version: shellState.version };
  }
  if (trainStatus?.staged) {
    return { kind: 'train', title: tr('settings.about.trainStickerTitle'), version: trainStatus.version };
  }
  return null;
}

export function SidebarUpdateNoticeCard({
  shellState,
  trainStatus,
  onInstallShell,
  onApplyTrain,
  storage,
}: SidebarUpdateNoticeCardProps) {
  const resolvedStorage = storage === undefined ? safeStorage() : storage;

  // 平台更新的叉号状态只活在组件内存里（不落 localStorage）：进程重启 =
  // 组件重新挂载 = 天然重置为"未叉过"，这正是"下次启动重新出现"的实现。
  const [shellDismissed, setShellDismissed] = useState(false);

  const trainKey = trainNoticeKey(trainStatus);
  const [trainDismissedKey, setTrainDismissedKey] = useState<string | null>(
    () => readDismissedKey(resolvedStorage, DISMISSED_TRAIN_UPDATE_KEY),
  );
  useEffect(() => {
    setTrainDismissedKey(readDismissedKey(resolvedStorage, DISMISSED_TRAIN_UPDATE_KEY));
  }, [trainKey, resolvedStorage]);

  const content = useMemo(() => resolveStickerContent(shellState, trainStatus), [shellState, trainStatus]);

  if (!content) return null;
  if (content.kind === 'shell' && shellDismissed) return null;
  if (content.kind === 'train' && trainKey && trainDismissedKey === trainKey) return null;

  const dismiss = () => {
    if (content.kind === 'shell') {
      setShellDismissed(true);
      return;
    }
    if (trainKey) {
      writeDismissedKey(resolvedStorage, DISMISSED_TRAIN_UPDATE_KEY, trainKey);
      setTrainDismissedKey(trainKey);
    }
  };

  const handleAction = () => {
    if (content.kind === 'shell') {
      void onInstallShell?.();
    } else {
      void onApplyTrain?.();
    }
  };

  return (
    <div className={styles.slot}>
      <section className={styles.card} role="status" aria-live="polite">
        <button type="button" className={styles.cardButton} onClick={handleAction}>
          <span className={styles.textBlock}>
            <span className={styles.title}>{content.title}</span>
            {content.version && <span className={styles.subtitle}>{`v${content.version}`}</span>}
          </span>
          <span className={styles.refreshIcon}>
            <RefreshIcon />
          </span>
        </button>
        <button type="button" className={styles.closeButton} aria-label={tr('window.close')} onClick={dismiss}>
          <CloseIcon />
        </button>
      </section>
    </div>
  );
}

export function SidebarNoticeSlot() {
  const shellState = useAutoUpdateState();
  const { state: trainState, minShellBlocked, applyNow } = useTrainUpdateState();

  // useTrainUpdateState() 的 state 是 AutoUpdateState 形状（给 AutoUpdateStatus
  // 组件复用）；贴纸这里换算回 TrainUpdateStatus 形状——'downloaded' 就是
  // "已暂存待应用"（hook 头部注释里的状态映射）。
  const trainStatus: TrainUpdateStatus = {
    staged: trainState.status === 'downloaded',
    train: null,
    version: trainState.version,
    minShellBlocked,
  };

  return (
    <SidebarUpdateNoticeCard
      shellState={shellState}
      trainStatus={trainStatus}
      onInstallShell={() => window.hana?.autoUpdateInstall?.()}
      onApplyTrain={() => applyNow()}
    />
  );
}

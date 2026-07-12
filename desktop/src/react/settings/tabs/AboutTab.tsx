import React, { useState, useCallback } from 'react';
import { useSettingsStore } from '../store';
import { autoSaveConfig, t } from '../helpers';
import { Toggle } from '@/ui';
import { loadSettingsConfig } from '../actions';
import { loadUpdateDigestHistory } from '../update-history-actions';
import { readConfigBoolean } from '../resource-state';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsRow } from '../components/SettingsRow';
import { ExpandableRow } from '../components/ExpandableRow';
import { digestLocale, digestText, kindLabel } from '../../components/shared/release-digest-text';
import { useAutoUpdateState } from '../../hooks/use-auto-update-state';
import { useTrainUpdateState } from '../../hooks/use-train-update-state';
import { Overlay } from '../../ui';
import type { UpdateDigestHistoryResult } from '../../types';
import appIconUrl from '../../../icon.png';
import styles from '../Settings.module.css';
import updateStyles from '../../components/AutoUpdateStatus.module.css';

const EMPTY_HISTORY: UpdateDigestHistoryResult = { entries: [], source: 'none', complete: false };

function UpdateHistoryDialog({
  open,
  loading,
  history,
  onClose,
}: {
  open: boolean;
  loading: boolean;
  history: UpdateDigestHistoryResult;
  onClose: () => void;
}) {
  const locale = digestLocale();
  const showNotice = !loading
    && history.entries.length > 0
    && (history.source !== 'online' || !history.complete);
  const noticeKey = history.source === 'bundled'
    ? 'settings.about.updateHistoryOffline'
    : history.source === 'online'
      ? 'settings.about.updateHistoryPartial'
      : 'settings.about.updateHistoryUnavailable';

  return (
    <Overlay
      scope="inline"
      open={open}
      onClose={onClose}
      backdrop="blur"
      zIndex={100}
      className={`${styles['memory-viewer']} ${styles['update-history-viewer']}`}
      backdropClassName={styles['memory-viewer-backdrop']}
      disableContainerAnimation
      contentProps={{
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'update-history-dialog-title',
      }}
    >
      <div className={styles['memory-viewer-header']}>
        <div>
          <h3 id="update-history-dialog-title" className={styles['memory-viewer-title']}>
            {t('settings.about.updateHistoryTitle')}
          </h3>
          <div className={styles['update-history-subtitle']}>
            {t('settings.about.updateHistorySubtitle')}
          </div>
        </div>
        <button
          type="button"
          className={styles['memory-viewer-close']}
          aria-label={t('settings.about.updateDigestClose')}
          onClick={onClose}
        >
          ✕
        </button>
      </div>
      <div className={`${styles['memory-viewer-body']} ${styles['update-history-body']}`}>
        {loading && (
          <div className={styles['update-history-state']}>{t('settings.about.updateHistoryLoading')}</div>
        )}
        {showNotice && (
          <div className={styles['update-history-notice']}>{t(noticeKey)}</div>
        )}
        {!loading && history.entries.length === 0 && (
          <div className={styles['update-history-state']}>{t('settings.about.updateHistoryUnavailable')}</div>
        )}
        {!loading && history.entries.map((digest) => (
          <article key={digest.version} className={styles['update-history-release']}>
            <header className={styles['update-history-release-header']}>
              <h4 className={styles['update-history-version']}>v{digest.version}</h4>
            </header>
            <p className={styles['update-history-summary']}>{digestText(digest.summary, locale)}</p>
            {digest.items.length > 0 && (
              <div className={styles['update-history-items']}>
                {digest.items.map((item) => (
                  <section
                    key={`${digest.version}-${item.id || item.kind}-${item.title.en}`}
                    className={styles['update-history-item']}
                  >
                    <div className={styles['update-history-item-heading']}>
                      <span className={styles['update-history-kind']}>{kindLabel(item.kind)}</span>
                      <h5 className={styles['update-history-item-title']}>{digestText(item.title, locale)}</h5>
                    </div>
                    <p className={styles['update-history-item-summary']}>{digestText(item.summary, locale)}</p>
                  </section>
                ))}
              </div>
            )}
          </article>
        ))}
      </div>
    </Overlay>
  );
}

function updatePercentOf(progress: { receivedBytes: number; totalBytes: number } | null): number {
  if (!progress || !progress.totalBytes) return 0;
  return Math.max(0, Math.min(100, Math.round((progress.receivedBytes / progress.totalBytes) * 100)));
}

function formatCheckedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

// 货架清单签发日期：只取日期，不带时间——这条是"清单本身多新"的中性背景
// 信息，不是"我刚检查过"那个已经有独立时间戳的结论（formatCheckedAt）。
function formatManifestDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString();
}

/**
 * 更新区状态机：四态互斥，phase 优先于 idle 分支——一轮检查/下载/应用
 * 正在进行时不该同时冒出"已是最新"这类只在真正 idle 时才成立的结论。
 * available 在 idle 分支里优先于 lastError：哪怕最近一次后台检查失败了，
 * 只要手头还攥着一个之前发现的可用更新，用户能做的动作就是去点它，
 * 不该被一条过期的错误信息挡住。
 */
function TrainUpdateArea({
  agentName,
  available,
  lastError,
  lastCheckedAt,
  manifestReleasedAt,
  originUnreachable,
  phase,
  progress,
  onApply,
  onRetry,
}: {
  agentName: string;
  available: { version: string } | null;
  lastError: string | null;
  lastCheckedAt: string | null;
  manifestReleasedAt: string | null;
  originUnreachable: boolean;
  phase: 'idle' | 'checking' | 'downloading' | 'applying';
  progress: { receivedBytes: number; totalBytes: number } | null;
  onApply: () => void;
  onRetry: () => void;
}) {
  if (phase === 'checking') {
    return (
      <div className={updateStyles.root}>
        <div className={updateStyles.row}>
          <span className={updateStyles.message}>{t('settings.about.updateChecking')}</span>
        </div>
      </div>
    );
  }

  if (phase === 'downloading') {
    // 文字进度，不画填充条：填充条需要按百分比算内联宽度，会撞上
    // settings/tabs 目录的内联样式 ratchet（`settings-primitives-contract.test.ts`
    // 只允许往下迁移、不允许新增）。贴纸（SidebarNoticeSlot）同样是纯文字
    // 进度，两处一致，不是各自将就。
    const percent = updatePercentOf(progress);
    return (
      <div className={updateStyles.root}>
        <div className={updateStyles.row} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
          <span className={updateStyles.message}>
            {t('settings.about.updateDownloading', { agentName, percent })}
          </span>
          <span className={updateStyles.progressValue}>{t('settings.about.updateProgress', { percent })}</span>
        </div>
      </div>
    );
  }

  if (phase === 'applying') {
    return (
      <div className={updateStyles.root}>
        <div className={updateStyles.row}>
          <span className={updateStyles.message}>{t('settings.about.trainStickerApplying')}</span>
        </div>
      </div>
    );
  }

  // phase === 'idle' 以下——available 优先，其次 lastError，最后才是"已是最新"。
  if (available) {
    return (
      <div className={updateStyles.root}>
        <div className={updateStyles.row}>
          <span className={updateStyles.message}>{t('settings.about.updateAvailable', { version: available.version })}</span>
          <button type="button" className={updateStyles.action} onClick={onApply}>
            {t('settings.about.updateApply')}
          </button>
        </div>
      </div>
    );
  }

  if (lastError) {
    return (
      <div className={updateStyles.root}>
        <div className={updateStyles.row}>
          <span className={`${updateStyles.message} ${updateStyles.error}`}>{t('settings.about.updateError')}</span>
          <span className={updateStyles.errorDetail} title={lastError}>{lastError}</span>
          <button type="button" className={updateStyles.action} onClick={onRetry}>
            {t('settings.about.updateRetryBtn')}
          </button>
        </div>
      </div>
    );
  }

  if (lastCheckedAt) {
    return (
      <div className={updateStyles.root}>
        <div className={updateStyles.row}>
          <span className={updateStyles.message}>
            {t('settings.about.updateLatestCheckedAt', { time: formatCheckedAt(lastCheckedAt) })}
          </span>
        </div>
        {/* 中性背景信息：货架清单本身的签发日期，不是告警——不设阈值、不
            设颜色。仅当产地这一轮没能参与比较时才追加"经备用源"，镜像与
            产地同车号而采信镜像不算异常，不标注（见 artifact-ota.cjs 的
            "dual-source manifest fetch" 设计注释）。 */}
        {manifestReleasedAt && (
          <div className={updateStyles.row}>
            <span className={updateStyles.message}>
              {t(
                originUnreachable
                  ? 'settings.about.updateManifestReleasedAtViaMirror'
                  : 'settings.about.updateManifestReleasedAt',
                { date: formatManifestDate(manifestReleasedAt) },
              )}
            </span>
          </div>
        )}
      </div>
    );
  }

  // 从未检查过（既没有 available，也没有 lastError/lastCheckedAt）：不渲染
  // 任何结论性文案，只留下方的"检查更新"按钮可点。
  return null;
}

export function AboutTab() {
  const hana = window.hana;
  const settingsConfig = useSettingsStore(s => s.settingsConfig);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [history, setHistory] = useState<UpdateDigestHistoryResult>(EMPTY_HISTORY);
  const shellUpdate = useAutoUpdateState();
  const {
    currentVersion,
    available,
    minShellBlocked,
    lastError,
    lastCheckedAt,
    manifestReleasedAt,
    originUnreachable,
    phase,
    progress,
    checkNow: checkTrainNow,
    applyNow: applyTrainNow,
  } = useTrainUpdateState();
  const isBeta = readConfigBoolean(settingsConfig, cfg => cfg.update_channel === 'beta', false);
  // 默认 true：老用户（preferences 里没写这个字段）保持原有"自动检查"行为
  const autoCheck = readConfigBoolean(settingsConfig, cfg => cfg.auto_check_updates, true);

  const handleCheck = useCallback(() => {
    void checkTrainNow();
  }, [checkTrainNow]);

  const handleApply = useCallback(() => {
    void applyTrainNow();
  }, [applyTrainNow]);

  const handleInstallShell = useCallback(async () => {
    await hana?.autoUpdateInstall?.();
  }, [hana]);

  const handleHistoryOpen = useCallback(async () => {
    setHistoryOpen(true);
    setHistoryLoading(true);
    try {
      setHistory(await loadUpdateDigestHistory());
    } catch {
      setHistory(EMPTY_HISTORY);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const handleBetaToggle = useCallback(async (on: boolean) => {
    const channel = on ? 'beta' : 'stable';
    hana?.autoUpdateSetChannel?.(channel);
    await autoSaveConfig({ update_channel: channel }, { silent: true });
    await loadSettingsConfig();
    hana?.autoUpdateCheck?.();
    void checkTrainNow();
  }, [checkTrainNow, hana]);

  const handleAutoCheckToggle = useCallback(async (on: boolean) => {
    await autoSaveConfig({ auto_check_updates: on }, { silent: true });
    await loadSettingsConfig();
  }, []);

  // 平台更新条件行：仅当壳更新待命时出现，平时不渲染——一个
  // 一年两次的事件不该常年占一行。两层文案：minShell 真的挡住
  // 新列车时升级成更明确的警告措辞。这一行是唯一还会触发壳安装
  // （autoUpdateInstall）的地方——Hero 区的主更新按钮只会走 applyTrainNow。
  const showPlatformRow = shellUpdate?.status === 'downloaded';
  const platformRowLabel = minShellBlocked
    ? t('settings.about.shellStickerTitleBlocking')
    : t('settings.about.shellStickerTitle');

  // 忙碌（checking/downloading/applying）、已经有明确可用更新、或已经在
  // 展示带"重试"按钮的错误态时，这颗通用检查按钮就是多余的——要么已经在
  // 做同一件事，要么已经有一颗更贴切的按钮摆在上面了。只在"从未检查过"与
  // "已是最新"两种平静态下出现。
  const showCheckButton = phase === 'idle' && !available && !lastError;

  return (
    <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="about">
      {/* Hero：内容版本是唯一常规展示的版本号（单一源：useTrainUpdateState
          的 currentVersion，读自已激活内容，不是壳 package.json 版本）；
          更新主位是列车更新（check / "更新" 按钮 / 通道 / 历史，壳版本
          永不出现在这里）。 */}
      <div className={styles['about-hero']}>
        <img className={styles['about-icon']} src={appIconUrl} alt="HanaAgent" />
        <div className={styles['about-name']}>HanaAgent</div>
        <div className={styles['about-tagline']}>{t('settings.about.tagline')}</div>
        {currentVersion && <div className={styles['about-version']}>v{currentVersion}</div>}
        <TrainUpdateArea
          agentName={settingsConfig?.agent?.name || 'Hanako'}
          available={available}
          lastError={lastError}
          lastCheckedAt={lastCheckedAt}
          manifestReleasedAt={manifestReleasedAt}
          originUnreachable={originUnreachable}
          phase={phase}
          progress={progress}
          onApply={handleApply}
          onRetry={handleCheck}
        />
        <div className={styles['about-update-actions']}>
          {showCheckButton && (
            <button type="button" className={styles['about-check-update-btn']} onClick={handleCheck}>
              {t('settings.about.updateCheckBtn')}
            </button>
          )}
          <button type="button" className={styles['about-check-update-btn']} onClick={handleHistoryOpen}>
            {t('settings.about.updateHistoryTitle')}
          </button>
        </div>
      </div>

      {/* Info：4 个标准 row（license / copyright / github / beta toggle）+
          仅在壳更新待命时出现的条件行 */}
      <SettingsSection>
        <SettingsRow
          label={t('settings.about.license')}
          control={<span>Apache License 2.0</span>}
        />
        <SettingsRow
          label={t('settings.about.copyright')}
          control={<span>© 2026 liliMozi</span>}
        />
        <SettingsRow
          label="GitHub"
          control={
            <a
              className={styles['about-link']}
              href="#"
              onClick={(e) => {
                e.preventDefault();
                hana?.openExternal?.('https://github.com/liliMozi');
              }}
            >
              github.com/liliMozi
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
            </a>
          }
        />
        <SettingsRow
          label={t('settings.about.autoCheckUpdates')}
          control={<Toggle on={autoCheck} onChange={handleAutoCheckToggle} />}
        />
        <SettingsRow
          label={t('settings.about.betaUpdates')}
          control={<Toggle on={isBeta} onChange={handleBetaToggle} />}
        />
        {showPlatformRow && (
          <SettingsRow
            label={platformRowLabel}
            hint={shellUpdate?.version ? `v${shellUpdate.version}` : undefined}
            hintVariant={minShellBlocked ? 'warn' : 'default'}
            control={
              <button type="button" className={styles['about-check-update-btn']} onClick={handleInstallShell}>
                {t('settings.about.updateInstall')}
              </button>
            }
          />
        )}
      </SettingsSection>

      {/* License 全文：ExpandableRow 直接作为 tab 末尾元素 */}
      <ExpandableRow label={t('settings.about.licenseToggle')}>
        <pre className={styles['about-license-text']}>{LICENSE_TEXT}</pre>
      </ExpandableRow>

      <UpdateHistoryDialog
        open={historyOpen}
        loading={historyLoading}
        history={history}
        onClose={() => setHistoryOpen(false)}
      />
    </div>
  );
}

const LICENSE_TEXT = `Apache License, Version 2.0

Copyright 2026 liliMozi

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.`;

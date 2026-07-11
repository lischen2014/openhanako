import React, { useEffect, useState, useCallback } from 'react';
import { useSettingsStore } from '../store';
import { autoSaveConfig, t } from '../helpers';
import { Toggle } from '@/ui';
import { loadSettingsConfig } from '../actions';
import { loadUpdateDigestHistory } from '../update-history-actions';
import { readConfigBoolean } from '../resource-state';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsRow } from '../components/SettingsRow';
import { ExpandableRow } from '../components/ExpandableRow';
import { AutoUpdateStatus } from '../../components/AutoUpdateStatus';
import { digestLocale, digestText, kindLabel } from '../../components/shared/release-digest-text';
import { useAutoUpdateState } from '../../hooks/use-auto-update-state';
import { useTrainUpdateState } from '../../hooks/use-train-update-state';
import { Overlay } from '../../ui';
import type { UpdateDigestHistoryResult } from '../../types';
import appIconUrl from '../../../icon.png';
import styles from '../Settings.module.css';

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

export function AboutTab() {
  const hana = window.hana;
  const settingsConfig = useSettingsStore(s => s.settingsConfig);
  const [version, setVersion] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [history, setHistory] = useState<UpdateDigestHistoryResult>(EMPTY_HISTORY);
  const shellUpdate = useAutoUpdateState();
  const { state: trainUpdate, minShellBlocked, checkNow: checkTrainNow, applyNow: applyTrainNow } = useTrainUpdateState();
  const isBeta = readConfigBoolean(settingsConfig, cfg => cfg.update_channel === 'beta', false);
  // 默认 true：老用户（preferences 里没写这个字段）保持原有"自动检查"行为
  const autoCheck = readConfigBoolean(settingsConfig, cfg => cfg.auto_check_updates, true);

  useEffect(() => {
    hana?.getAppVersion?.().then((v: string) => setVersion(v || ''));
  }, [hana]);

  const handleCheck = useCallback(() => {
    void checkTrainNow();
  }, [checkTrainNow]);

  const handleApply = useCallback(async () => {
    await applyTrainNow();
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
  // 新列车时升级成更明确的警告措辞。
  const showPlatformRow = shellUpdate?.status === 'downloaded';
  const platformRowLabel = minShellBlocked
    ? t('settings.about.shellStickerTitleBlocking')
    : t('settings.about.shellStickerTitle');

  return (
    <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="about">
      {/* Hero：产品版本是唯一常规展示的版本号；更新主位是列车更新
          （check / "更新" 按钮 / 通道 / 历史，壳版本永不出现在这里）。 */}
      <div className={styles['about-hero']}>
        <img className={styles['about-icon']} src={appIconUrl} alt="HanaAgent" />
        <div className={styles['about-name']}>HanaAgent</div>
        <div className={styles['about-tagline']}>{t('settings.about.tagline')}</div>
        {version && <div className={styles['about-version']}>v{version}</div>}
        <AutoUpdateStatus
          state={trainUpdate}
          agentName={settingsConfig?.agent?.name || 'Hanako'}
          onInstall={handleApply}
          variant="train"
        />
        <div className={styles['about-update-actions']}>
          {(!trainUpdate || trainUpdate.status === 'idle' || trainUpdate.status === 'latest' || trainUpdate.status === 'error') && (
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

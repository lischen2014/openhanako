import React, { useCallback, useEffect, useState } from 'react';
import { useSettingsStore } from '../store';
import { hanaFetch } from '../api';
import { autoSaveConfig, t } from '../helpers';
import { loadSettingsConfig } from '../actions';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsRow } from '../components/SettingsRow';
import { Toggle } from '../widgets/Toggle';
import { SelectWidget } from '../widgets/SelectWidget';
import type { AutoLaunchStatus } from '../../types';
import {
  normalizeNotificationPreferences as normalizeSharedNotificationPreferences,
  normalizeTurnCompletionNotificationMode,
} from '../../../../../shared/notification-preferences.js';
import {
  DEFAULT_QUICK_CHAT_SHORTCUT,
  normalizeQuickChatPreferences,
} from '../../../../../shared/quick-chat-preferences.js';
import styles from '../Settings.module.css';

type TurnCompletionNotificationMode = 'never' | 'when_unfocused' | 'when_session_unfocused';

interface NotificationPreferences {
  turnCompletion: TurnCompletionNotificationMode;
}

interface QuickChatPreferences {
  shortcut: string;
}

const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  turnCompletion: 'never',
};

function formatShortcut(shortcut: string): string[] {
  return String(shortcut || DEFAULT_QUICK_CHAT_SHORTCUT)
    .split('+')
    .map(part => part.trim())
    .filter(Boolean);
}

function keyLabel(key: string): string {
  if (key === 'CommandOrControl') return navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl';
  if (key === 'Control') return 'Ctrl';
  if (key === 'Alt') return navigator.platform.toLowerCase().includes('mac') ? '⌥' : 'Alt';
  if (key === 'Shift') return 'Shift';
  if (key === 'Space') return 'Space';
  return key.length === 1 ? key.toUpperCase() : key;
}

function keyFromEvent(event: KeyboardEvent): string | null {
  if (event.key === 'Escape') return null;
  if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return null;

  const parts: string[] = [];
  if (event.metaKey || event.ctrlKey) parts.push('CommandOrControl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');

  const rawKey = event.key === ' ' ? 'Space' : event.key;
  const keyMap: Record<string, string> = {
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Enter: 'Enter',
    Tab: 'Tab',
    Backspace: 'Backspace',
    Delete: 'Delete',
  };
  const key = keyMap[rawKey] || (rawKey.length === 1 ? rawKey.toUpperCase() : rawKey);
  const isFunctionKey = /^F([1-9]|1[0-9]|2[0-4])$/.test(key);
  if (parts.length === 0 && !isFunctionKey) return null;
  parts.push(key);
  return parts.join('+');
}

function ShortcutKeycaps({ shortcut }: { shortcut: string }) {
  return (
    <span className={styles['shortcut-keycaps']}>
      {formatShortcut(shortcut).map((part) => (
        <span key={part} className={styles['shortcut-keycap']}>{keyLabel(part)}</span>
      ))}
    </span>
  );
}

function ShortcutRecorder({
  value,
  recording,
  saving,
  onStart,
  onRestoreDefault,
}: {
  value: string;
  recording: boolean;
  saving: boolean;
  onStart: () => void;
  onRestoreDefault: () => void;
}) {
  return (
    <div className={styles['quick-chat-shortcut-control']}>
      <button
        type="button"
        className={`${styles['quick-chat-shortcut-button']} ${recording ? styles['recording'] : ''}`}
        aria-label={t('settings.general.quickChat.shortcut')}
        onClick={onStart}
        disabled={saving}
      >
        {recording ? t('settings.general.quickChat.recording') : <ShortcutKeycaps shortcut={value} />}
      </button>
      <button
        type="button"
        className={styles['quick-chat-reset-button']}
        onClick={onRestoreDefault}
        disabled={saving || value === DEFAULT_QUICK_CHAT_SHORTCUT}
      >
        {t('settings.general.quickChat.restoreDefault')}
      </button>
    </div>
  );
}

function normalizeTurnCompletionMode(value: unknown): TurnCompletionNotificationMode {
  return normalizeTurnCompletionNotificationMode(value) as TurnCompletionNotificationMode;
}

function normalizeNotificationPreferences(value: unknown): NotificationPreferences {
  return normalizeSharedNotificationPreferences(value) as NotificationPreferences;
}

export function GeneralTab() {
  const hana = window.hana;
  const settingsConfig = useSettingsStore(s => s.settingsConfig);
  const showToast = useSettingsStore(s => s.showToast);
  const [autoLaunch, setAutoLaunch] = useState<AutoLaunchStatus | null>(null);
  const [autoLaunchSaving, setAutoLaunchSaving] = useState(false);
  const [keepAwakeSaving, setKeepAwakeSaving] = useState(false);
  const [quickChatPrefs, setQuickChatPrefs] = useState<QuickChatPreferences>(() => normalizeQuickChatPreferences());
  const [quickChatSaving, setQuickChatSaving] = useState(false);
  const [quickChatRecording, setQuickChatRecording] = useState(false);
  const [notificationSaving, setNotificationSaving] = useState(false);
  const [notificationPrefs, setNotificationPrefs] = useState<NotificationPreferences>(DEFAULT_NOTIFICATION_PREFERENCES);
  const keepAwake = settingsConfig?.keep_awake === true;

  useEffect(() => {
    let alive = true;
    hana?.getAutoLaunchStatus?.()
      .then((status) => {
        if (alive && status) setAutoLaunch(status);
      })
      .catch(() => {
        if (alive) setAutoLaunch(null);
      });
    return () => {
      alive = false;
    };
  }, [hana]);

  useEffect(() => {
    let alive = true;
    hanaFetch('/api/preferences/quick-chat')
      .then(res => res.json())
      .then((data) => {
        if (!alive) return;
        setQuickChatPrefs(normalizeQuickChatPreferences(data?.quickChat));
      })
      .catch((err) => {
        if (!alive) return;
        showToast(t('settings.saveFailed') + ': ' + (err?.message || String(err)), 'error');
      });
    return () => {
      alive = false;
    };
  }, [showToast]);

  useEffect(() => {
    let alive = true;
    hanaFetch('/api/preferences/notifications')
      .then(res => res.json())
      .then((data) => {
        if (!alive) return;
        setNotificationPrefs(normalizeNotificationPreferences(data?.notifications));
      })
      .catch((err) => {
        if (!alive) return;
        showToast(t('settings.saveFailed') + ': ' + (err?.message || String(err)), 'error');
      });
    return () => {
      alive = false;
    };
  }, [showToast]);

  const saveQuickChatShortcut = useCallback(async (shortcut: string) => {
    const previous = quickChatPrefs;
    const next = normalizeQuickChatPreferences({ shortcut });
    setQuickChatPrefs(next);
    setQuickChatSaving(true);
    try {
      const res = await hanaFetch('/api/preferences/quick-chat', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quickChat: next }),
      });
      const data = await res.json();
      if (data?.error) throw new Error(data.error);
      const saved = normalizeQuickChatPreferences(data?.quickChat);
      setQuickChatPrefs(saved);
      const registration = await hana?.quickChatReloadShortcut?.();
      if (registration && registration.ok === false) {
        throw new Error(registration.error || t('settings.general.quickChat.registrationFailed'));
      }
      hana?.settingsChanged?.('quick-chat-shortcut-changed', { quickChat: saved });
    } catch (err: any) {
      setQuickChatPrefs(previous);
      try {
        await hanaFetch('/api/preferences/quick-chat', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ quickChat: previous }),
        });
        await hana?.quickChatReloadShortcut?.();
      } catch {}
      showToast(t('settings.saveFailed') + ': ' + (err?.message || String(err)), 'error');
    } finally {
      setQuickChatSaving(false);
    }
  }, [hana, quickChatPrefs, showToast]);

  useEffect(() => {
    if (!quickChatRecording) return undefined;
    const handler = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        setQuickChatRecording(false);
        return;
      }
      const shortcut = keyFromEvent(event);
      if (!shortcut) return;
      setQuickChatRecording(false);
      void saveQuickChatShortcut(shortcut);
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [quickChatRecording, saveQuickChatShortcut]);

  const handleAutoLaunchToggle = useCallback(async (on: boolean) => {
    if (!hana?.setAutoLaunchEnabled) return;
    const previous = autoLaunch;
    setAutoLaunchSaving(true);
    try {
      const next = await hana.setAutoLaunchEnabled(on);
      setAutoLaunch(next || previous);
    } catch {
      setAutoLaunch(previous);
    } finally {
      setAutoLaunchSaving(false);
    }
  }, [autoLaunch, hana]);

  const handleKeepAwakeToggle = useCallback(async (on: boolean) => {
    if (!hana?.setKeepAwakeEnabled) return;
    const previous = settingsConfig?.keep_awake === true;
    setKeepAwakeSaving(true);
    try {
      const saved = await autoSaveConfig({ keep_awake: on }, { silent: true });
      if (saved === false) return;
      await hana.setKeepAwakeEnabled(on);
    } catch (err: any) {
      if (previous !== on) {
        await autoSaveConfig({ keep_awake: previous }, { silent: true });
        await loadSettingsConfig();
      }
      showToast(t('settings.saveFailed') + ': ' + (err?.message || String(err)), 'error');
    } finally {
      setKeepAwakeSaving(false);
    }
  }, [hana, settingsConfig?.keep_awake, showToast]);

  const handleTurnCompletionChange = useCallback(async (value: string) => {
    const turnCompletion = normalizeTurnCompletionMode(value);
    const previous = notificationPrefs;
    const next = { turnCompletion };
    setNotificationPrefs(next);
    setNotificationSaving(true);
    try {
      const res = await hanaFetch('/api/preferences/notifications', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notifications: next }),
      });
      const data = await res.json();
      if (data?.error) throw new Error(data.error);
      setNotificationPrefs(normalizeNotificationPreferences(data?.notifications));
    } catch (err: any) {
      setNotificationPrefs(previous);
      showToast(t('settings.saveFailed') + ': ' + (err?.message || String(err)), 'error');
    } finally {
      setNotificationSaving(false);
    }
  }, [notificationPrefs, showToast]);

  return (
    <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="general">
      <SettingsSection title={t('settings.general.startup.title')}>
        {autoLaunch?.supported && (
          <SettingsRow
            label={t('settings.general.launchAtLogin')}
            control={
              <Toggle
                on={autoLaunch.openAtLogin}
                onChange={handleAutoLaunchToggle}
                ariaLabel={t('settings.general.launchAtLogin')}
                disabled={autoLaunchSaving}
              />
            }
          />
        )}
        <SettingsRow
          label={t('settings.general.keepAwake')}
          control={
            <Toggle
              on={keepAwake}
              onChange={handleKeepAwakeToggle}
              ariaLabel={t('settings.general.keepAwake')}
              disabled={keepAwakeSaving || !hana?.setKeepAwakeEnabled}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title={t('settings.general.quickChat.title')}>
        <SettingsRow
          label={t('settings.general.quickChat.shortcut')}
          hint={t('settings.general.quickChat.shortcutHint')}
          control={
            <ShortcutRecorder
              value={quickChatPrefs.shortcut}
              recording={quickChatRecording}
              saving={quickChatSaving}
              onStart={() => setQuickChatRecording(true)}
              onRestoreDefault={() => void saveQuickChatShortcut(DEFAULT_QUICK_CHAT_SHORTCUT)}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title={t('settings.general.notifications.title')}>
        <SettingsRow
          label={t('settings.general.notifications.turnCompletion')}
          control={
            <SelectWidget
              options={[
                { value: 'never', label: t('settings.general.notifications.turnCompletionNever') },
                { value: 'when_unfocused', label: t('settings.general.notifications.turnCompletionWhenUnfocused') },
                { value: 'when_session_unfocused', label: t('settings.general.notifications.turnCompletionWhenSessionUnfocused') },
              ]}
              value={notificationPrefs.turnCompletion}
              onChange={handleTurnCompletionChange}
              disabled={notificationSaving}
            />
          }
        />
      </SettingsSection>
    </div>
  );
}

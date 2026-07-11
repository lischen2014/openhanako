import { useCallback, useEffect, useState } from 'react';
import type { AutoUpdateState, TrainUpdateStatus } from '../types';

/**
 * 列车更新（OTA）状态 hook：把
 * `train-update-status`/`train-update-check` 两个只读/触发式 IPC 投影成
 * `AutoUpdateState` 同款形状，好让 `AutoUpdateStatus` 组件原样复用
 * （"复用今天的 Electron-Updater UI 作为更新 UI"——组件不需要关心数据
 * 来自壳还是列车，只需要一个 status/version/progress/digest 形状一致的
 * state）。
 *
 * 状态映射（OTA 没有细粒度下载进度推送，`checkAndDownloadOnce` 是"一轮
 * 检查+下载"整体完成才返回，所以没有 'downloading' 中间态）：
 *   idle      — 尚未查询 / 没有暂存中的列车，也没有主动检查过
 *   checking  — 手动检查正在进行
 *   downloaded— 复用这个既有状态值表示"已暂存待应用"（OTA 语境下就是
 *               apply-ready，跟壳更新的"已下载待安装"是同一个视觉状态）
 *   latest    — 主动检查后确认没有可用列车
 *   error     — 检查失败
 */
const IDLE_STATE: AutoUpdateState = {
  status: 'idle',
  version: null,
  releaseNotes: null,
  releaseUrl: null,
  downloadUrl: null,
  progress: null,
  error: null,
  digest: null,
  digestUrl: null,
  digestError: null,
};

async function queryStagedStatus(): Promise<TrainUpdateStatus | null> {
  try {
    return (await window.hana?.trainUpdateStatus?.()) ?? null;
  } catch {
    return null;
  }
}

function stateFromStaged(staged: TrainUpdateStatus | null, fallbackStatus: AutoUpdateState['status']): AutoUpdateState {
  if (staged?.staged) {
    return { ...IDLE_STATE, status: 'downloaded', version: staged.version };
  }
  return { ...IDLE_STATE, status: fallbackStatus };
}

export interface UseTrainUpdateStateResult {
  state: AutoUpdateState;
  /**
   * 两层文案的 minShell 逃生舱：最近一轮 OTA 检查是否发现"有
   * 新列车，但这个壳版本太旧收不到它"。贴纸与设置页条件行共用同一份数据，
   * 不必各自再发一次 IPC。
   */
  minShellBlocked: boolean;
  /** 触发一轮手动 OTA 检查（packaged only；dev 模式下由主进程侧直接返回 no-op 结果）。 */
  checkNow(): Promise<void>;
  /** "立即应用"（refresh-grade apply）：promote + 优雅重启 server + 重载所有窗口。 */
  applyNow(): Promise<{ ok: boolean; error?: string } | undefined>;
}

export function useTrainUpdateState(): UseTrainUpdateStateResult {
  const [state, setState] = useState<AutoUpdateState>(IDLE_STATE);
  const [minShellBlocked, setMinShellBlocked] = useState(false);

  useEffect(() => {
    let alive = true;
    queryStagedStatus().then((staged) => {
      if (!alive) return;
      setState(stateFromStaged(staged, 'idle'));
      setMinShellBlocked(staged?.minShellBlocked === true);
    });
    return () => { alive = false; };
  }, []);

  const checkNow = useCallback(async () => {
    setState((s) => ({ ...s, status: 'checking', error: null }));
    try {
      const result = await window.hana?.trainUpdateCheck?.();
      if (result?.outcome === 'error') {
        setState({ ...IDLE_STATE, status: 'error', error: result.error || null });
        return;
      }
      const staged = await queryStagedStatus();
      setState(stateFromStaged(staged, 'latest'));
      setMinShellBlocked(staged?.minShellBlocked === true);
    } catch (err) {
      setState({ ...IDLE_STATE, status: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  const applyNow = useCallback(async () => {
    return window.hana?.trainUpdateApply?.();
  }, []);

  return { state, minShellBlocked, checkNow, applyNow };
}

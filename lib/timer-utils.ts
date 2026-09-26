export interface StoredTimerState {
  consultationId: string;
  accumulatedSeconds: number;
  startTime: number;
  isRunning: boolean;
  finalized?: boolean;
  lastUpdated: number;
}

export function formatTimerDigits(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return '00:00';
  }
  const sec = Math.floor(totalSeconds);
  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const seconds = sec % 60;

  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');

  if (hours > 0) {
    const hh = String(hours).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}

export function formatHumanDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return '0 s';
  }
  const sec = Math.floor(totalSeconds);
  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const seconds = sec % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}min` : `${hours}h`;
  }
  if (minutes > 0) {
    return seconds > 0 ? `${minutes}min ${seconds}s` : `${minutes} min`;
  }
  return `${seconds} s`;
}

const STORAGE_PREFIX = 'consultation_timer_';

export function getTimerStorageKey(consultationId: string): string {
  return `${STORAGE_PREFIX}${consultationId}`;
}

export function getStoredTimer(consultationId: string): StoredTimerState | null {
  if (typeof window === 'undefined' || !consultationId) return null;
  try {
    const raw = window.localStorage.getItem(getTimerStorageKey(consultationId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredTimerState;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      parsed.consultationId === consultationId &&
      typeof parsed.accumulatedSeconds === 'number'
    ) {
      return parsed;
    }
  } catch {
    // Ignore storage parse error
  }
  return null;
}

export function saveStoredTimer(state: StoredTimerState): void {
  if (typeof window === 'undefined' || !state.consultationId) return null as unknown as void;
  try {
    window.localStorage.setItem(
      getTimerStorageKey(state.consultationId),
      JSON.stringify({ ...state, lastUpdated: Date.now() }),
    );
  } catch {
    // Ignore storage quota error
  }
}

export function clearStoredTimer(consultationId: string): void {
  if (typeof window === 'undefined' || !consultationId) return;
  try {
    window.localStorage.removeItem(getTimerStorageKey(consultationId));
  } catch {
    // Ignore storage error
  }
}

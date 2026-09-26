import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatTimerDigits,
  formatHumanDuration,
  getTimerStorageKey,
  getStoredTimer,
  saveStoredTimer,
  clearStoredTimer,
} from '../lib/timer-utils.ts';

test('formatTimerDigits formats MM:SS and HH:MM:SS correctly', () => {
  assert.equal(formatTimerDigits(0), '00:00');
  assert.equal(formatTimerDigits(5), '00:05');
  assert.equal(formatTimerDigits(59), '00:59');
  assert.equal(formatTimerDigits(60), '01:00');
  assert.equal(formatTimerDigits(125), '02:05');
  assert.equal(formatTimerDigits(3599), '59:59');
  assert.equal(formatTimerDigits(3600), '01:00:00');
  assert.equal(formatTimerDigits(3665), '01:01:05');
  assert.equal(formatTimerDigits(7325), '02:02:05');
  // Edge cases
  assert.equal(formatTimerDigits(-10), '00:00');
  assert.equal(formatTimerDigits(NaN), '00:00');
  assert.equal(formatTimerDigits(Infinity), '00:00');
});

test('formatHumanDuration formats durations in Portuguese naturally', () => {
  assert.equal(formatHumanDuration(0), '0 s');
  assert.equal(formatHumanDuration(45), '45 s');
  assert.equal(formatHumanDuration(60), '1 min');
  assert.equal(formatHumanDuration(90), '1min 30s');
  assert.equal(formatHumanDuration(1800), '30 min');
  assert.equal(formatHumanDuration(3600), '1h');
  assert.equal(formatHumanDuration(5400), '1h 30min');
  // Edge cases
  assert.equal(formatHumanDuration(-5), '0 s');
  assert.equal(formatHumanDuration(NaN), '0 s');
});

test('getTimerStorageKey namespaces keys with consultation_timer_', () => {
  assert.equal(getTimerStorageKey('abc-123'), 'consultation_timer_abc-123');
});

test('storage helpers work correctly with mock localStorage', () => {
  const store = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (key) => store.get(key) || null,
      setItem: (key, val) => store.set(key, String(val)),
      removeItem: (key) => store.delete(key),
    },
  };

  assert.equal(getStoredTimer('non-existent'), null);

  saveStoredTimer({
    consultationId: 'c-100',
    accumulatedSeconds: 120,
    startTime: 1000,
    isRunning: true,
    lastUpdated: 2000,
  });

  const retrieved = getStoredTimer('c-100');
  assert.ok(retrieved);
  assert.equal(retrieved.consultationId, 'c-100');
  assert.equal(retrieved.accumulatedSeconds, 120);
  assert.equal(retrieved.isRunning, true);

  clearStoredTimer('c-100');
  assert.equal(getStoredTimer('c-100'), null);

  delete globalThis.window;
});


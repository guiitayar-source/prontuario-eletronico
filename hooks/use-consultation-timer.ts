'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  formatTimerDigits,
  formatHumanDuration,
  getStoredTimer,
  saveStoredTimer,
  type StoredTimerState,
} from '@/lib/timer-utils';

export interface ConsultationTimerOptions {
  consultationId?: string | null;
  isFinalized?: boolean;
  createdAt?: string | null;
  finalizedAt?: string | null;
}

export interface ConsultationTimerReturn {
  seconds: number;
  formattedDigits: string;
  formattedTime: string;
  humanDuration: string;
  isRunning: boolean;
  isPaused: boolean;
  isFinalized: boolean;
  isReady: boolean;
  togglePause: () => void;
  start: () => void;
  pause: () => void;
  reset: () => void;
}

export function useConsultationTimer({
  consultationId,
  isFinalized = false,
  createdAt,
  finalizedAt,
}: ConsultationTimerOptions): ConsultationTimerReturn {
  const [seconds, setSeconds] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const [isPaused, setIsPaused] = useState(false);

  // References to keep accurate wall-clock timing
  const startTimeRef = useRef<number>(Date.now());
  const accumulatedRef = useRef<number>(0);
  const isRunningRef = useRef<boolean>(false);
  const isFinalizedRef = useRef<boolean>(isFinalized);
  const consultationIdRef = useRef<string | null | undefined>(consultationId);

  isRunningRef.current = isRunning;
  isFinalizedRef.current = isFinalized;
  consultationIdRef.current = consultationId;

  // Initialize or restore state when consultationId or isFinalized changes
  useEffect(() => {
    if (!consultationId) {
      setSeconds(0);
      setIsRunning(false);
      setIsPaused(false);
      accumulatedRef.current = 0;
      return;
    }

    if (isFinalized) {
      const stored = getStoredTimer(consultationId);
      let finalSec = 0;
      if (stored && typeof stored.accumulatedSeconds === 'number') {
        finalSec = stored.accumulatedSeconds;
      } else if (createdAt && finalizedAt) {
        const diff = Math.max(
          0,
          Math.floor(
            (new Date(finalizedAt).getTime() - new Date(createdAt).getTime()) /
              1000,
          ),
        );
        finalSec = diff < 24 * 3600 ? diff : 0;
      }

      setSeconds(finalSec);
      setIsRunning(false);
      setIsPaused(false);
      accumulatedRef.current = finalSec;

      if (!stored || stored.isRunning) {
        saveStoredTimer({
          consultationId,
          accumulatedSeconds: finalSec,
          startTime: Date.now(),
          isRunning: false,
          finalized: true,
          lastUpdated: Date.now(),
        });
      }
      return;
    }

    // Ongoing consultation
    const stored = getStoredTimer(consultationId);
    if (stored) {
      if (stored.isRunning) {
        const currentElapsed =
          stored.accumulatedSeconds +
          Math.max(0, Math.floor((Date.now() - stored.startTime) / 1000));
        accumulatedRef.current = stored.accumulatedSeconds;
        startTimeRef.current = stored.startTime;
        setSeconds(currentElapsed);
        setIsRunning(true);
        setIsPaused(false);
      } else {
        accumulatedRef.current = stored.accumulatedSeconds;
        setSeconds(stored.accumulatedSeconds);
        setIsRunning(false);
        setIsPaused(stored.accumulatedSeconds > 0);
      }
    } else {
      // Brand new or unrecorded consultation
      const createdTime = createdAt ? new Date(createdAt).getTime() : Date.now();
      const diffFromCreated = Math.floor((Date.now() - createdTime) / 1000);
      // If created recently (within last 8h), start from created time
      const initialSeconds =
        diffFromCreated >= 0 && diffFromCreated < 8 * 3600
          ? diffFromCreated
          : 0;

      const now = Date.now();
      accumulatedRef.current = initialSeconds;
      startTimeRef.current = now;
      setSeconds(initialSeconds);
      setIsRunning(true);
      setIsPaused(false);

      saveStoredTimer({
        consultationId,
        accumulatedSeconds: initialSeconds,
        startTime: now,
        isRunning: true,
        finalized: false,
        lastUpdated: now,
      });
    }
  }, [consultationId, isFinalized, createdAt, finalizedAt]);

  // Interval loop for ticking
  useEffect(() => {
    if (!isRunning || isFinalized || !consultationId) return;

    const interval = setInterval(() => {
      const now = Date.now();
      const currentElapsed =
        accumulatedRef.current +
        Math.max(0, Math.floor((now - startTimeRef.current) / 1000));
      setSeconds(currentElapsed);
    }, 1000);

    return () => clearInterval(interval);
  }, [isRunning, isFinalized, consultationId]);

  // Save to localStorage on visibility change or blur
  useEffect(() => {
    if (!consultationId || isFinalized) return;

    const handleVisibility = () => {
      if (!consultationIdRef.current || isFinalizedRef.current) return;
      if (isRunningRef.current) {
        const now = Date.now();
        const currentElapsed =
          accumulatedRef.current +
          Math.max(0, Math.floor((now - startTimeRef.current) / 1000));
        setSeconds(currentElapsed);
        saveStoredTimer({
          consultationId: consultationIdRef.current,
          accumulatedSeconds: accumulatedRef.current,
          startTime: startTimeRef.current,
          isRunning: true,
          finalized: false,
          lastUpdated: now,
        });
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('beforeunload', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('beforeunload', handleVisibility);
    };
  }, [consultationId, isFinalized]);

  const togglePause = useCallback(() => {
    if (!consultationId || isFinalized) return;
    const now = Date.now();

    if (isRunning) {
      // Pause
      const currentElapsed =
        accumulatedRef.current +
        Math.max(0, Math.floor((now - startTimeRef.current) / 1000));
      accumulatedRef.current = currentElapsed;
      setSeconds(currentElapsed);
      setIsRunning(false);
      setIsPaused(true);

      saveStoredTimer({
        consultationId,
        accumulatedSeconds: currentElapsed,
        startTime: now,
        isRunning: false,
        finalized: false,
        lastUpdated: now,
      });
    } else {
      // Resume
      startTimeRef.current = now;
      setIsRunning(true);
      setIsPaused(false);

      saveStoredTimer({
        consultationId,
        accumulatedSeconds: accumulatedRef.current,
        startTime: now,
        isRunning: true,
        finalized: false,
        lastUpdated: now,
      });
    }
  }, [consultationId, isFinalized, isRunning]);

  const start = useCallback(() => {
    if (!consultationId || isFinalized || isRunning) return;
    const now = Date.now();
    startTimeRef.current = now;
    setIsRunning(true);
    setIsPaused(false);

    saveStoredTimer({
      consultationId,
      accumulatedSeconds: accumulatedRef.current,
      startTime: now,
      isRunning: true,
      finalized: false,
      lastUpdated: now,
    });
  }, [consultationId, isFinalized, isRunning]);

  const pause = useCallback(() => {
    if (!consultationId || isFinalized || !isRunning) return;
    const now = Date.now();
    const currentElapsed =
      accumulatedRef.current +
      Math.max(0, Math.floor((now - startTimeRef.current) / 1000));
    accumulatedRef.current = currentElapsed;
    setSeconds(currentElapsed);
    setIsRunning(false);
    setIsPaused(true);

    saveStoredTimer({
      consultationId,
      accumulatedSeconds: currentElapsed,
      startTime: now,
      isRunning: false,
      finalized: false,
      lastUpdated: now,
    });
  }, [consultationId, isFinalized, isRunning]);

  const reset = useCallback(() => {
    if (!consultationId || isFinalized) return;
    const now = Date.now();
    accumulatedRef.current = 0;
    startTimeRef.current = now;
    setSeconds(0);

    saveStoredTimer({
      consultationId,
      accumulatedSeconds: 0,
      startTime: now,
      isRunning,
      finalized: false,
      lastUpdated: now,
    });
  }, [consultationId, isFinalized, isRunning]);

  const formattedDigits = formatTimerDigits(seconds);
  const humanDuration = formatHumanDuration(seconds);

  return {
    seconds,
    formattedDigits,
    formattedTime: formattedDigits,
    humanDuration,
    isRunning,
    isPaused,
    isFinalized,
    isReady: Boolean(consultationId),
    togglePause,
    start,
    pause,
    reset,
  };
}

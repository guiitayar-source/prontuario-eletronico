'use client';

import React from 'react';
import { Timer, Clock3, Pause, Play, RotateCcw } from 'lucide-react';
import type { ConsultationTimerReturn } from '@/hooks/use-consultation-timer';

export interface ConsultationTimerProps {
  timer: ConsultationTimerReturn;
  visitDate: string;
  className?: string;
}

export function ConsultationTimer({
  timer,
  visitDate,
  className = '',
}: ConsultationTimerProps) {
  if (!timer.isReady) {
    return (
      <div
        className={`consultation-timer-card ready ${className}`}
        role="status"
        aria-label="Cronômetro do atendimento pronto"
      >
        <div className="timer-top-row">
          <span className="timer-status-badge ready">
            <span className="timer-dot ready" />
            Nova consulta
          </span>
          <small className="timer-date">{visitDate}</small>
        </div>
        <div className="timer-clock-row">
          <div className="timer-display ready" title="Aguardando início do atendimento">
            <Timer size={15} className="timer-icon" />
            <span className="timer-digits">00:00</span>
          </div>
        </div>
      </div>
    );
  }

  if (timer.isFinalized) {
    return (
      <div
        className={`consultation-timer-card finalized ${className}`}
        role="status"
        aria-label="Consulta finalizada"
      >
        <div className="timer-top-row">
          <span className="timer-status-badge finalized">
            <span className="timer-dot finalized" />
            Finalizada
          </span>
          <small className="timer-date">{visitDate}</small>
        </div>
        <div className="timer-clock-row">
          <div
            className="timer-display finalized"
            title="Duração total registrada do atendimento"
          >
            <Clock3 size={15} className="timer-icon" />
            <span className="timer-final-label">Duração:</span>
            <span className="timer-digits">{timer.formattedDigits}</span>
            {timer.humanDuration && timer.humanDuration !== '0 s' && (
              <span className="timer-human-duration">
                ({timer.humanDuration})
              </span>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`consultation-timer-card ${
        timer.isPaused ? 'paused' : 'running'
      } ${className}`}
      role="timer"
      aria-label="Cronômetro de atendimento em andamento"
      aria-live="off"
    >
      <div className="timer-top-row">
        <span
          className={`timer-status-badge ${
            timer.isPaused ? 'paused' : 'running'
          }`}
        >
          {timer.isPaused ? (
            <span className="timer-dot paused" />
          ) : (
            <span className="timer-pulse-dot" />
          )}
          {timer.isPaused ? 'Atendimento pausado' : 'Em atendimento'}
        </span>
        <small className="timer-date">{visitDate}</small>
      </div>
      <div className="timer-clock-row">
        <div
          className="timer-display"
          title="Tempo decorrido do atendimento"
        >
          <Timer
            size={16}
            className={`timer-icon ${timer.isRunning ? 'ticking' : ''}`}
          />
          <span className="timer-digits">{timer.formattedDigits}</span>
        </div>
        <div className="timer-controls">
          <button
            type="button"
            className={`timer-ctrl-btn ${timer.isRunning ? 'pause' : 'play'}`}
            onClick={timer.togglePause}
            title={timer.isRunning ? 'Pausar cronômetro' : 'Retomar cronômetro'}
            aria-label={
              timer.isRunning ? 'Pausar cronômetro' : 'Retomar cronômetro'
            }
          >
            {timer.isRunning ? <Pause size={12} /> : <Play size={12} />}
            <span>{timer.isRunning ? 'Pausar' : 'Retomar'}</span>
          </button>
          <button
            type="button"
            className="timer-ctrl-btn reset"
            onClick={timer.reset}
            title="Zerar cronômetro"
            aria-label="Zerar cronômetro"
          >
            <RotateCcw size={12} />
            <span>Zerar</span>
          </button>
        </div>
      </div>
    </div>
  );
}

export default ConsultationTimer;

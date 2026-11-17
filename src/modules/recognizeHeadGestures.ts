/**
 * Модуль распознавания жестов головы для бесконтактного интерфейса (recognizeHeadGestures).
 *
 * Назначение:
 * Обеспечивает управление пространственным и 2D-интерфейсом без рук и контроллеров:
 * - Кивок вверх-вниз ('nod') -> Выбор / Подтверждение активного элемента;
 * - Поворот влево-вправо ('shake') -> Назад / Сброс или закрытие оверлея;
 * - Наклон головы влево/вправо ('tilt_left' / 'tilt_right') -> Переключение вкладок меню.
 * Работает как со встроенным `xb.core.headGestureRecognition`, так и напрямую по углам Эйлера IMU.
 *
 * Входные параметры:
 * - eulerDeg: { pitch: number; yaw: number; roll: number } — углы головы/IMU в градусах;
 * - enabled: boolean — активность распознавания жестов.
 *
 * Выходные данные:
 * - События HeadGestureAction ('nod' | 'shake' | 'tilt_left' | 'tilt_right') и подписка onGesture().
 */

import type { HeadGestureAction } from '../types';

interface SamplePoint {
  time: number;
  pitch: number;
  yaw: number;
  roll: number;
}

export interface HeadGestureController {
  pushOrientation(eulerDeg: { pitch: number; yaw: number; roll: number }, enabled: boolean): void;
  triggerFromXRBlocks(name: string): void;
  onGesture(cb: (action: HeadGestureAction) => void): () => void;
  getLastGesture(): { action: HeadGestureAction; timestamp: number } | null;
}

export function createHeadGestureController(): HeadGestureController {
  const history: SamplePoint[] = [];
  const listeners = new Set<(action: HeadGestureAction) => void>();
  let lastTriggerAt = 0;
  let lastGesture: { action: HeadGestureAction; timestamp: number } | null = null;

  const COOLDOWN_MS = 1100;
  const WINDOW_MS = 850;

  function emit(action: HeadGestureAction): void {
    const now = performance.now();
    if (now - lastTriggerAt < COOLDOWN_MS) return;
    lastTriggerAt = now;
    lastGesture = { action, timestamp: Date.now() };
    for (const cb of listeners) {
      cb(action);
    }
  }

  function pushOrientation(
    eulerDeg: { pitch: number; yaw: number; roll: number },
    enabled: boolean
  ): void {
    if (!enabled) return;
    const now = performance.now();
    history.push({
      time: now,
      pitch: eulerDeg.pitch,
      yaw: eulerDeg.yaw,
      roll: eulerDeg.roll,
    });

    while (history.length > 0 && now - history[0].time > WINDOW_MS) {
      history.shift();
    }
    if (history.length < 10) return;

    let minPitch = Infinity;
    let maxPitch = -Infinity;
    let minYaw = Infinity;
    let maxYaw = -Infinity;
    for (const p of history) {
      if (p.pitch < minPitch) minPitch = p.pitch;
      if (p.pitch > maxPitch) maxPitch = p.pitch;
      if (p.yaw < minYaw) minYaw = p.yaw;
      if (p.yaw > maxYaw) maxYaw = p.yaw;
    }

    const pitchSpan = maxPitch - minPitch;
    const yawSpan = maxYaw - minYaw;

    // Устойчивый наклон головы (roll) влево или вправо > 22°
    if (eulerDeg.roll > 22) {
      emit('tilt_left');
      history.length = 0;
      return;
    }
    if (eulerDeg.roll < -22) {
      emit('tilt_right');
      history.length = 0;
      return;
    }

    // Быстрый кивок (амплитуда по тангажу > 18°, при малом рыскании)
    if (pitchSpan > 18 && yawSpan < 14) {
      emit('nod');
      history.length = 0;
      return;
    }

    // Покачивание головой (амплитуда по рысканию > 24°, при малом тангаже)
    if (yawSpan > 24 && pitchSpan < 14) {
      emit('shake');
      history.length = 0;
    }
  }

  function triggerFromXRBlocks(name: string): void {
    if (name === 'nod') emit('nod');
    else if (name === 'shake') emit('shake');
  }

  return {
    pushOrientation,
    triggerFromXRBlocks,
    onGesture: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getLastGesture: () => lastGesture,
  };
}

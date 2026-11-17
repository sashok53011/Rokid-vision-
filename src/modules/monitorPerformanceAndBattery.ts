/**
 * Модуль мониторинга производительности и диагностики батареи (monitorPerformanceAndBattery).
 *
 * Назначение:
 * Собирает в реальном времени метрики рендеринга WebGL/XR (FPS, время кадра, Draw Calls,
 * количество треугольников, геометрий и текстур), объем используемой JS-памяти,
 * задержки ML-инференса и IMU-сенсора, а также состояние аккумулятора через Battery Status API.
 *
 * Входные параметры:
 * - renderer?: THREE.WebGLRenderer — активный рендерер Three.js / XR Blocks;
 * - mlInferenceMs: number — последнее время выполнения ML-модели;
 * - imuLatencyMs: number — задержка обработки IMU.
 *
 * Выходные данные:
 * - Структура PerformanceDiagnostics с актуальными показателями.
 */

import type * as THREE from 'three';
import type { PerformanceDiagnostics } from '../types';

interface BatteryManagerLike extends EventTarget {
  level: number;
  charging: boolean;
  dischargingTime: number;
}

export interface DiagnosticsMonitor {
  tickFrame(renderer?: THREE.WebGLRenderer): void;
  setLatencies(mlInferenceMs: number, imuLatencyMs: number): void;
  getSnapshot(): PerformanceDiagnostics;
  dispose(): void;
}

export function createDiagnosticsMonitor(): DiagnosticsMonitor {
  let frameCounter = 0;
  let lastSampleAt = performance.now();
  let lastFrameAt = performance.now();
  let fps = 60;
  let frameTimeMs = 16.6;
  let drawCalls = 0;
  let triangles = 0;
  let geometries = 0;
  let textures = 0;
  let mlInferenceMs = 0;
  let imuLatencyMs = 0;

  let batteryLevelPct: number | null = null;
  let batteryCharging: boolean | null = null;
  let batteryDischargeMin: number | null = null;
  let batteryManager: BatteryManagerLike | null = null;

  const updateBatteryFields = () => {
    if (!batteryManager) return;
    batteryLevelPct = Math.round(batteryManager.level * 100);
    batteryCharging = batteryManager.charging;
    batteryDischargeMin = Number.isFinite(batteryManager.dischargingTime)
      ? Math.round(batteryManager.dischargingTime / 60)
      : null;
  };

  // Инициализация стандартного Battery Status API (поддерживается на Android Chrome / WebView)
  // Примечание: на iOS Safari и некоторых десктоп-браузерах API отключен из-за приватности,
  // в этом случае возвращается null и интерфейс отображает статус «API недоступен».
  const navWithBattery = navigator as Navigator & {
    getBattery?: () => Promise<BatteryManagerLike>;
  };
  if (typeof navWithBattery.getBattery === 'function') {
    navWithBattery
      .getBattery()
      .then((bm) => {
        batteryManager = bm;
        updateBatteryFields();
        bm.addEventListener('levelchange', updateBatteryFields);
        bm.addEventListener('chargingchange', updateBatteryFields);
        bm.addEventListener('dischargingtimechange', updateBatteryFields);
      })
      .catch(() => {
        // Игнорируем отказ в доступе к батарее
      });
  }

  return {
    tickFrame(renderer?: THREE.WebGLRenderer) {
      const now = performance.now();
      frameTimeMs = now - lastFrameAt;
      lastFrameAt = now;
      frameCounter++;

      if (now - lastSampleAt >= 500) {
        fps = Math.round((frameCounter * 1000) / (now - lastSampleAt));
        frameCounter = 0;
        lastSampleAt = now;

        if (renderer && 'info' in renderer && renderer.info) {
          drawCalls = renderer.info.render.calls;
          triangles = renderer.info.render.triangles;
          geometries = renderer.info.memory.geometries;
          textures = renderer.info.memory.textures;
        }
      }
    },

    setLatencies(mlMs: number, imuMs: number) {
      mlInferenceMs = Math.round(mlMs * 10) / 10;
      imuLatencyMs = Math.round(imuMs * 10) / 10;
    },

    getSnapshot(): PerformanceDiagnostics {
      const perfWithMemory = performance as Performance & {
        memory?: { usedJSHeapSize: number };
      };
      const memoryUsedMb = perfWithMemory.memory
        ? Math.round(perfWithMemory.memory.usedJSHeapSize / (1024 * 1024))
        : null;

      const thermalState: PerformanceDiagnostics['thermalState'] =
        fps < 28 || frameTimeMs > 40
          ? 'throttled'
          : fps < 48 || mlInferenceMs > 35
            ? 'warm'
            : 'nominal';

      return {
        fps,
        frameTimeMs: Math.round(frameTimeMs * 10) / 10,
        drawCalls,
        triangles,
        geometries,
        textures,
        memoryUsedMb,
        mlInferenceMs,
        imuLatencyMs,
        batteryLevelPct,
        batteryCharging,
        batteryDischargeMin,
        thermalState,
      };
    },

    dispose() {
      if (batteryManager) {
        batteryManager.removeEventListener('levelchange', updateBatteryFields);
        batteryManager.removeEventListener('chargingchange', updateBatteryFields);
        batteryManager.removeEventListener('dischargingtimechange', updateBatteryFields);
      }
    },
  };
}

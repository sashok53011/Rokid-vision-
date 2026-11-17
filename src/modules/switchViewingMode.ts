/**
 * Модуль переключения режимов просмотра и стереорендеринга (switchViewingMode).
 *
 * Назначение:
 * 1. Автоматически выбирает оптимальный режим отображения (monoscopic, sbs, 360)
 *    на основе обнаруженной гарнитуры/очков (например, Rokid Max 1st Gen -> SBS 3D Stereo);
 * 2. Обеспечивает поддержку стереорендеринга (THREE.StereoCamera с настраиваемым IPD в мм)
 *    для глубокого восприятия глубины как на очках Rokid Max 3D, так и в браузерном предпросмотре;
 * 3. Управляет 360°-панорамным сферическим куполом при выборе режима '360'.
 *
 * Входные параметры:
 * - requestedMode: ViewingMode ('auto' | 'monoscopic' | 'sbs' | '360');
 * - headsetProfile: HeadsetProfile;
 * - ipdMm: number (межзрачковое расстояние, по умолчанию 63 мм).
 *
 * Выходные данные:
 * - Активный ResolvedViewingMode ('monoscopic' | 'sbs' | '360');
 * - Метод renderStereoIfActive() для отрисовки левого и правого ракурса в SBS-режиме.
 */

import * as THREE from 'three';
import type {
  HeadsetProfile,
  ResolvedViewingMode,
  ViewingMode,
} from '../types';

export interface ViewingModeController {
  resolveMode(requested: ViewingMode, headset: HeadsetProfile): ResolvedViewingMode;
  setMode(requested: ViewingMode, headset: HeadsetProfile): ResolvedViewingMode;
  getActiveMode(): ResolvedViewingMode;
  getRequestedMode(): ViewingMode;
  setIpdMm(ipdMm: number): void;
  attach360Dome(dome: THREE.Object3D): void;
  renderSBSIfActive(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera
  ): boolean;
}

export function resolveViewingModeForHeadset(
  requested: ViewingMode,
  headset: HeadsetProfile
): ResolvedViewingMode {
  if (requested !== 'auto') return requested;
  if (headset === 'rokid_max_1') return 'sbs';
  if (headset === 'meta_quest' || headset === 'galaxy_xr' || headset === 'generic_vr') {
    return '360';
  }
  return 'monoscopic';
}

export function createViewingModeController(): ViewingModeController {
  let requestedMode: ViewingMode = 'auto';
  let activeMode: ResolvedViewingMode = 'monoscopic';
  let domeRef: THREE.Object3D | null = null;
  const stereoCamera = new THREE.StereoCamera();
  stereoCamera.eyeSep = 0.063;
  const prevSize = new THREE.Vector2();

  function syncDomeVisibility(): void {
    if (domeRef) {
      domeRef.visible = activeMode === '360';
    }
  }

  return {
    resolveMode: resolveViewingModeForHeadset,

    setMode(requested: ViewingMode, headset: HeadsetProfile): ResolvedViewingMode {
      requestedMode = requested;
      activeMode = resolveViewingModeForHeadset(requested, headset);
      syncDomeVisibility();
      return activeMode;
    },

    getActiveMode: () => activeMode,
    getRequestedMode: () => requestedMode,

    setIpdMm(ipdMm: number) {
      stereoCamera.eyeSep = THREE.MathUtils.clamp(ipdMm, 50, 76) / 1000;
    },

    attach360Dome(dome: THREE.Object3D) {
      domeRef = dome;
      syncDomeVisibility();
    },

    renderSBSIfActive(
      renderer: THREE.WebGLRenderer,
      scene: THREE.Scene,
      camera: THREE.PerspectiveCamera
    ): boolean {
      // В нативной WebXR-сессии рендерер уже разделяет левый и правый глаза аппаратно
      if (activeMode !== 'sbs' || renderer.xr.isPresenting) {
        return false;
      }

      renderer.getSize(prevSize);
      const width = prevSize.x;
      const height = prevSize.y;
      if (width <= 0 || height <= 0) return false;

      camera.updateMatrixWorld();
      stereoCamera.aspect = 0.5;
      stereoCamera.update(camera);

      const prevScissorTest = renderer.getScissorTest();
      renderer.setScissorTest(true);

      // Левый глаз
      renderer.setScissor(0, 0, width / 2, height);
      renderer.setViewport(0, 0, width / 2, height);
      renderer.render(scene, stereoCamera.cameraL);

      // Правый глаз
      renderer.setScissor(width / 2, 0, width / 2, height);
      renderer.setViewport(width / 2, 0, width / 2, height);
      renderer.render(scene, stereoCamera.cameraR);

      renderer.setScissorTest(prevScissorTest);
      renderer.setViewport(0, 0, width, height);
      return true;
    },
  };
}

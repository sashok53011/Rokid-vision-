/**
 * Модуль пространственного аудио-баланса и усиления для Bluetooth-устройств (balanceSpatialAudio).
 *
 * Назначение:
 * Управляет 3D-позиционированием и балансировкой звука на базе Web Audio API:
 * 1. Настройка модели затухания расстояния (`PannerNode.distanceModel`: `linear` | `inverse` | `exponential`),
 *    коэффициента спада (`rolloffFactor`), опорной дистанции (`refDistance`) и максимальной дистанции (`maxDistance`);
 * 2. Стереофонический и пространственный баланс (`StereoPannerNode` / `PannerNode`) в диапазоне -1.0 (Л) .. +1.0 (П);
 * 3. Индивидуальное управление усилением (`GainNode`) и моделью затухания для каждого подключенного
 *    Bluetooth-устройства (`WirelessDeviceEntry` с транспортом `'bluetooth'`);
 * 4. Синхронизация слушателя (`AudioContext.listener`) с позой активной WebXR/Three.js камеры;
 * 5. Генерация тестового пространственного сигнала для мгновенной проверки баланса и затухания.
 *
 * ЗАГЛУШКА / ОГРАНИЧЕНИЕ БРАУЗЕРНОГО API АУДИОВЫХОДА:
 * Стандартный Web Bluetooth API в браузере управляет GATT-профилями (BLE), тогда как маршрутизация
 * системного аудиопотока A2DP/HFP на конкретный физический динамик Bluetooth выполняется ОС (Android/Windows)
 * или через экспериментальный `AudioContext.setSinkId(sinkId)`. В данном модуле каждый подключенный
 * BT-профиль получает собственный виртуальный аудио-канал (GainNode + PannerNode) в микшере Web Audio,
 * а при наличии поддержки `setSinkId` в продакшне к каналу можно привязать конкретный `MediaDeviceInfo.deviceId`.
 *
 * Входные параметры:
 * - settings: SpatialAudioSettingsState — глобальные настройки и профили BT-устройств;
 * - camera: THREE.Camera — камера сцены для обновления положения слушателя.
 *
 * Выходные данные:
 * - Контроллер `SpatialAudioBalancer` с методами `applySettings()`, `updateListenerFromCamera()`,
 *   `playSpatialTestTone(deviceId?)`, `getEffectiveVolumeForTts()`.
 */

import * as THREE from 'three';
import type {
  BluetoothDeviceAudioProfile,
  SpatialAudioSettingsState,
} from '../types';

export interface SpatialAudioBalancer {
  applySettings(settings: SpatialAudioSettingsState): void;
  updateListenerFromCamera(camera: THREE.Camera): void;
  playSpatialTestTone(deviceId?: string): Promise<void>;
  getEffectiveVolumeForTts(deviceId?: string): number;
  getOrDefaultDeviceProfile(
    settings: SpatialAudioSettingsState,
    deviceId: string,
    deviceName: string
  ): BluetoothDeviceAudioProfile;
  dispose(): void;
}

interface DeviceAudioBus {
  gainNode: GainNode;
  pannerNode: PannerNode;
  stereoPanner: StereoPannerNode;
}

export function createSpatialAudioBalancer(): SpatialAudioBalancer {
  let ctx: AudioContext | null = null;
  let masterGainNode: GainNode | null = null;
  let masterStereoPanner: StereoPannerNode | null = null;
  let masterPanner: PannerNode | null = null;
  const deviceBuses = new Map<string, DeviceAudioBus>();

  let currentSettings: SpatialAudioSettingsState = {
    masterGain: 1.0,
    spatialBalance: 0.0,
    attenuationModel: 'inverse',
    rolloffFactor: 1.0,
    refDistance: 1.0,
    maxDistance: 25.0,
    btDeviceProfiles: {},
  };

  const _camPos = new THREE.Vector3();
  const _camForward = new THREE.Vector3();
  const _camUp = new THREE.Vector3();

  function ensureGraph(): AudioContext | null {
    if (ctx) {
      if (ctx.state === 'suspended') {
        void ctx.resume();
      }
      return ctx;
    }

    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioCtx) return null;

    ctx = new AudioCtx();
    masterGainNode = ctx.createGain();
    masterStereoPanner = ctx.createStereoPanner();
    masterPanner = ctx.createPanner();
    masterPanner.panningModel = 'HRTF';

    masterPanner.connect(masterStereoPanner);
    masterStereoPanner.connect(masterGainNode);
    masterGainNode.connect(ctx.destination);

    syncNodesToSettings();
    return ctx;
  }

  function ensureDeviceBus(deviceId: string): DeviceAudioBus | null {
    const audioCtx = ensureGraph();
    if (!audioCtx || !masterGainNode) return null;

    let bus = deviceBuses.get(deviceId);
    if (!bus) {
      const gainNode = audioCtx.createGain();
      const pannerNode = audioCtx.createPanner();
      pannerNode.panningModel = 'HRTF';
      const stereoPanner = audioCtx.createStereoPanner();

      pannerNode.connect(stereoPanner);
      stereoPanner.connect(gainNode);
      gainNode.connect(masterGainNode);

      bus = { gainNode, pannerNode, stereoPanner };
      deviceBuses.set(deviceId, bus);
    }
    return bus;
  }

  function syncNodesToSettings(): void {
    if (!ctx || !masterGainNode || !masterStereoPanner || !masterPanner) return;
    const now = ctx.currentTime;

    masterGainNode.gain.setTargetAtTime(
      THREE.MathUtils.clamp(currentSettings.masterGain, 0, 2),
      now,
      0.02
    );
    masterStereoPanner.pan.setTargetAtTime(
      THREE.MathUtils.clamp(currentSettings.spatialBalance, -1, 1),
      now,
      0.02
    );
    masterPanner.distanceModel = currentSettings.attenuationModel;
    masterPanner.rolloffFactor = Math.max(0.05, currentSettings.rolloffFactor);
    masterPanner.refDistance = Math.max(0.1, currentSettings.refDistance);
    masterPanner.maxDistance = Math.max(
      masterPanner.refDistance + 1,
      currentSettings.maxDistance
    );
    masterPanner.positionX.setTargetAtTime(currentSettings.spatialBalance * 2.0, now, 0.02);
    masterPanner.positionY.setTargetAtTime(0, now, 0.02);
    masterPanner.positionZ.setTargetAtTime(-1.5, now, 0.02);

    for (const [devId, profile] of Object.entries(currentSettings.btDeviceProfiles)) {
      const bus = deviceBuses.get(devId);
      if (!bus) continue;
      bus.gainNode.gain.setTargetAtTime(
        THREE.MathUtils.clamp(profile.gain, 0, 2),
        now,
        0.02
      );
      bus.stereoPanner.pan.setTargetAtTime(
        THREE.MathUtils.clamp(profile.pan, -1, 1),
        now,
        0.02
      );
      bus.pannerNode.distanceModel = profile.attenuationModel;
      bus.pannerNode.rolloffFactor = Math.max(0.05, profile.rolloffFactor);
      bus.pannerNode.refDistance = Math.max(0.1, profile.refDistance);
      bus.pannerNode.maxDistance = Math.max(
        bus.pannerNode.refDistance + 1,
        profile.maxDistance
      );
      bus.pannerNode.positionX.setTargetAtTime(profile.pan * 2.5, now, 0.02);
      bus.pannerNode.positionZ.setTargetAtTime(-1.8, now, 0.02);
    }
  }

  function getOrDefaultDeviceProfile(
    settings: SpatialAudioSettingsState,
    deviceId: string,
    deviceName: string
  ): BluetoothDeviceAudioProfile {
    const existing = settings.btDeviceProfiles[deviceId];
    if (existing) return existing;
    return {
      deviceId,
      deviceName,
      gain: 1.0,
      attenuationModel: settings.attenuationModel,
      pan: settings.spatialBalance,
      rolloffFactor: settings.rolloffFactor,
      refDistance: settings.refDistance,
      maxDistance: settings.maxDistance,
    };
  }

  return {
    applySettings(settings: SpatialAudioSettingsState) {
      currentSettings = settings;
      syncNodesToSettings();
    },

    updateListenerFromCamera(camera: THREE.Camera) {
      if (!ctx) return;
      const listener = ctx.listener;
      camera.getWorldPosition(_camPos);
      camera.getWorldDirection(_camForward);
      _camUp.set(0, 1, 0).applyQuaternion(camera.quaternion).normalize();

      if (listener.positionX) {
        const now = ctx.currentTime;
        listener.positionX.setValueAtTime(_camPos.x, now);
        listener.positionY.setValueAtTime(_camPos.y, now);
        listener.positionZ.setValueAtTime(_camPos.z, now);
        listener.forwardX.setValueAtTime(_camForward.x, now);
        listener.forwardY.setValueAtTime(_camForward.y, now);
        listener.forwardZ.setValueAtTime(_camForward.z, now);
        listener.upX.setValueAtTime(_camUp.x, now);
        listener.upY.setValueAtTime(_camUp.y, now);
        listener.upZ.setValueAtTime(_camUp.z, now);
      }
    },

    async playSpatialTestTone(deviceId?: string) {
      const audioCtx = ensureGraph();
      if (!audioCtx || !masterPanner) return;
      if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }

      const targetNode =
        deviceId ? ensureDeviceBus(deviceId)?.pannerNode ?? masterPanner : masterPanner;
      syncNodesToSettings();

      const now = audioCtx.currentTime;
      const osc = audioCtx.createOscillator();
      const env = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(523.25, now); // C5
      osc.frequency.exponentialRampToValueAtTime(783.99, now + 0.16); // G5

      env.gain.setValueAtTime(0.001, now);
      env.gain.linearRampToValueAtTime(0.24, now + 0.03);
      env.gain.exponentialRampToValueAtTime(0.001, now + 0.42);

      osc.connect(env);
      env.connect(targetNode);
      osc.start(now);
      osc.stop(now + 0.44);
    },

    getEffectiveVolumeForTts(deviceId?: string): number {
      const base = THREE.MathUtils.clamp(currentSettings.masterGain, 0, 1);
      if (deviceId && currentSettings.btDeviceProfiles[deviceId]) {
        return THREE.MathUtils.clamp(
          base * currentSettings.btDeviceProfiles[deviceId].gain,
          0,
          1
        );
      }
      return base;
    },

    getOrDefaultDeviceProfile,

    dispose() {
      deviceBuses.clear();
      if (ctx) {
        void ctx.close();
        ctx = null;
      }
    },
  };
}

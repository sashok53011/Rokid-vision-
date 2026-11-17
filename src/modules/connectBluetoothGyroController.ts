/**
 * Модуль подключения стандартного гироскопического Bluetooth-контроллера для Android и Windows
 * (connectBluetoothGyroController).
 *
 * Назначение:
 * 1. Поддерживает стандартные Bluetooth-контроллеры на Android и Windows через два протокола:
 *    - **Web Gamepad API (`navigator.getGamepads()`)**: автоматически обнаруживает сопряженные в ОС
 *      Android/Windows Bluetooth-геймпады и 3DoF/AirMouse-контроллеры (DualSense, Switch Pro, Joy-Con,
 *      Xbox BT, VR-пульты), читает `gamepad.pose.orientation` (если доступен), стики и кнопки курка (`buttons[0]`);
 *    - **Web Bluetooth BLE GATT (`navigator.bluetooth.requestDevice`)**: подключается к BLE-пультам
 *      со стандартными профилями (`human_interface_device` 0x1812, Daydream 3DoF Controller `0xFE55`,
 *      Nordic UART `6e400001-...`, HM-10 IMU `0xFFE0`, `battery_service` `0x180F`) и парсит бинарные
 *      кватернионы (float32), пакеты гироскопа (int16) или текстовые/JSON строки `{pitch,yaw,roll,trigger}`.
 * 2. Интегрирует угловую скорость гироскопа (deg/s) в 3D-кватернион ориентации с функцией
 *    быстрой перецентровки луча (`recenter()`) и настройкой чувствительности.
 *
 * ЗАГЛУШКА / ЭМУЛЯЦИЯ ДЛЯ ДЕСКТОПА БЕЗ ФИЗИЧЕСКОГО BT-ГИРОПУЛЬТА:
 * В окружениях, где у пользователя нет физического BLE-контроллера или браузер скрывает `gamepad.pose`,
 * метод `connectVirtualGyroStub()` включает интерактивный тестовый контроллер (`source: 'simulated-bt'`),
 * управляемый движением мыши (при зажатом Alt или в пределах сцены) и кликом/пробелом для проверки
 * 3D лазерного луча (`Laser Beam Pointer`). В продакшне с физическим устройством используются реальные
 * потоки Web Bluetooth GATT и Gamepad Pose / Android HID-bridge.
 *
 * Входные параметры:
 * - deltaSec: number — шаг времени кадра;
 * - sensitivity: number — коэффициент чувствительности углового отклонения (0.3 .. 2.5);
 * - onDeviceEvent?: callback для регистрации подключенного BT-контроллера в WirelessDeviceHub.
 *
 * Выходные данные:
 * - Состояние `BtGyroControllerState` (`connected`, `quaternion`, `eulerDeg`, `triggerPressed`,
 *   `laserHitLabel`, `laserDistanceM`) и `THREE.Quaternion` для поворота 3D лазерного луча.
 */

import * as THREE from 'three';
import type { BtGyroControllerState, WirelessDeviceEntry } from '../types';

export interface BluetoothGyroController {
  connectBleGyroController(): Promise<BtGyroControllerState>;
  connectVirtualGyroStub(): BtGyroControllerState;
  disconnect(): void;
  recenter(): void;
  setSensitivity(sensitivity: number): void;
  setLaserHitInfo(label: string | null, distanceM: number | null): void;
  update(deltaSec: number): BtGyroControllerState;
  getState(): BtGyroControllerState;
  getThreeQuaternion(target?: THREE.Quaternion): THREE.Quaternion;
  subscribe(cb: (state: BtGyroControllerState) => void): () => void;
  dispose(): void;
}

const STANDARD_BLE_GYRO_SERVICES = [
  'battery_service',
  'human_interface_device',
  '0000fe55-0000-1000-8000-00805f9b34fb', // Standard 3DoF Motion Controller GATT
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e', // Nordic UART IMU Stream
  '0000ffe0-0000-1000-8000-00805f9b34fb', // Standard HM-10 BLE IMU Bridge
];

function detectPlatformHint(): 'android' | 'windows' | 'universal' {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent.toLowerCase() : '';
  if (ua.includes('android')) return 'android';
  if (ua.includes('windows')) return 'windows';
  return 'universal';
}

export function createBluetoothGyroController(
  onDeviceEvent?: (entry: WirelessDeviceEntry) => void
): BluetoothGyroController {
  const platformHint = detectPlatformHint();
  const orientationQuat = new THREE.Quaternion();
  const baseOffsetQuat = new THREE.Quaternion();
  const rawQuat = new THREE.Quaternion();
  const tempEuler = new THREE.Euler(0, 0, 0, 'YXZ');

  let sensitivity = 1.0;
  let activeBleServer: { disconnect?: () => void } | null = null;
  let virtualSimActive = false;
  let simYaw = 0;
  let simPitch = 0;
  let simTrigger = false;
  let activeGamepadIndex: number | null = null;

  let state: BtGyroControllerState = {
    connected: false,
    deviceName: 'None',
    platformHint,
    source: 'none',
    quaternion: [0, 0, 0, 1],
    eulerDeg: { pitch: 0, yaw: 0, roll: 0 },
    gyroDps: { x: 0, y: 0, z: 0 },
    triggerPressed: false,
    touchpadPressed: false,
    batteryPct: null,
    laserHitLabel: null,
    laserDistanceM: null,
  };

  const listeners = new Set<(s: BtGyroControllerState) => void>();

  function emit(): void {
    for (const cb of listeners) cb(state);
  }

  function registerInWirelessHub(name: string, detail: string, status: WirelessDeviceEntry['status']): void {
    onDeviceEvent?.({
      id: `bt-gyro-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      name,
      transport: 'bluetooth',
      status,
      detail,
      lastSyncAt: Date.now(),
    });
  }

  function applyGyroPacket(view: DataView): void {
    // 1. Попытка разбора 16-байтного пакета quaternion float32 (qx, qy, qz, qw)
    if (view.byteLength >= 16) {
      const qx = view.getFloat32(0, true);
      const qy = view.getFloat32(4, true);
      const qz = view.getFloat32(8, true);
      const qw = view.getFloat32(12, true);
      const lenSq = qx * qx + qy * qy + qz * qz + qw * qw;
      if (Number.isFinite(lenSq) && lenSq > 0.5 && lenSq < 1.6) {
        rawQuat.set(qx, qy, qz, qw).normalize();
        if (view.byteLength >= 17) {
          const buttons = view.getUint8(16);
          state.triggerPressed = Boolean(buttons & 0x01);
          state.touchpadPressed = Boolean(buttons & 0x02);
        }
        return;
      }
    }

    // 2. Попытка разбора стандартного 20-байтного пакета 3DoF (Daydream/BLE IMU int16)
    if (view.byteLength >= 12) {
      const gx = view.getInt16(0, true) / 16.4;
      const gy = view.getInt16(2, true) / 16.4;
      const gz = view.getInt16(4, true) / 16.4;
      if (
        Number.isFinite(gx) &&
        Number.isFinite(gy) &&
        Number.isFinite(gz) &&
        Math.abs(gx) < 2500 &&
        Math.abs(gy) < 2500
      ) {
        state.gyroDps = { x: gx, y: gy, z: gz };
        if (view.byteLength >= 13) {
          const btn = view.getUint8(12);
          state.triggerPressed = Boolean(btn & 0x01);
        }
        return;
      }
    }

    // 3. Попытка разбора текстового JSON/CSV потока UART IMU (например, '{"p":10,"y":-15,"r":0,"t":1}')
    try {
      const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
      const text = new TextDecoder().decode(bytes).trim();
      if (text.startsWith('{')) {
        const parsed = JSON.parse(text) as {
          p?: number;
          y?: number;
          r?: number;
          pitch?: number;
          yaw?: number;
          roll?: number;
          t?: number;
          trigger?: boolean;
        };
        const pitch = THREE.MathUtils.degToRad(parsed.pitch ?? parsed.p ?? 0);
        const yaw = THREE.MathUtils.degToRad(parsed.yaw ?? parsed.y ?? 0);
        const roll = THREE.MathUtils.degToRad(parsed.roll ?? parsed.r ?? 0);
        tempEuler.set(pitch, yaw, roll, 'YXZ');
        rawQuat.setFromEuler(tempEuler);
        state.triggerPressed = Boolean(parsed.trigger ?? parsed.t);
      }
    } catch {
      // Игнорируем некорректные текстовые фреймы
    }
  }

  async function connectBleGyroController(): Promise<BtGyroControllerState> {
    const navBt = navigator as Navigator & {
      bluetooth?: {
        requestDevice(opts: {
          acceptAllDevices: boolean;
          optionalServices: string[];
        }): Promise<{
          id: string;
          name?: string;
          gatt?: {
            connect(): Promise<{
              connected: boolean;
              disconnect?(): void;
              getPrimaryServices?(): Promise<
                Array<{
                  uuid: string;
                  getCharacteristics?(): Promise<
                    Array<{
                      uuid: string;
                      properties?: { notify?: boolean; read?: boolean };
                      startNotifications?(): Promise<unknown>;
                      readValue?(): Promise<DataView>;
                      addEventListener?(
                        ev: string,
                        cb: (e: { target?: { value?: DataView } }) => void
                      ): void;
                    }>
                  >;
                }>
              >;
            }>;
          };
          addEventListener(ev: string, cb: () => void): void;
        }>;
      };
    };

    if (!navBt.bluetooth) {
      // Если Web Bluetooth недоступен в браузере, предлагаем виртуальный тест или Gamepad
      return state;
    }

    try {
      const device = await navBt.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: STANDARD_BLE_GYRO_SERVICES,
      });

      const name = device.name || 'BT Gyro Controller';
      let battPct: number | null = null;

      if (device.gatt) {
        const server = await device.gatt.connect();
        activeBleServer = server;
        try {
          const services = (await server.getPrimaryServices?.()) || [];
          for (const svc of services) {
            const chars = (await svc.getCharacteristics?.()) || [];
            for (const ch of chars) {
              if (svc.uuid.includes('180f') && ch.properties?.read && ch.readValue) {
                const v = await ch.readValue();
                if (v.byteLength > 0) battPct = v.getUint8(0);
              }
              if (ch.properties?.notify && ch.startNotifications && ch.addEventListener) {
                await ch.startNotifications();
                ch.addEventListener('characteristicvaluechanged', (ev) => {
                  const val = ev.target?.value;
                  if (val) applyGyroPacket(val);
                });
              }
            }
          }
        } catch {
          // Некоторые BLE HID устройства блокируют прямой GATT notify в браузере и работают через Gamepad API
        }
      }

      virtualSimActive = false;
      state = {
        ...state,
        connected: true,
        deviceName: name,
        source: 'ble-gatt',
        batteryPct: battPct,
      };

      device.addEventListener('gattserverdisconnected', () => {
        if (state.source === 'ble-gatt') {
          disconnect();
        }
      });

      registerInWirelessHub(name, `BT Gyro (${platformHint.toUpperCase()})`, 'streaming');
      recenter();
      emit();
      return state;
    } catch {
      return state;
    }
  }

  function connectVirtualGyroStub(): BtGyroControllerState {
    virtualSimActive = true;
    simYaw = 0;
    simPitch = 0;
    simTrigger = false;
    rawQuat.identity();
    baseOffsetQuat.identity();
    orientationQuat.identity();

    const label = `BT Gyro Laser (${platformHint.toUpperCase()})`;
    state = {
      connected: true,
      deviceName: label,
      platformHint,
      source: 'simulated-bt',
      quaternion: [0, 0, 0, 1],
      eulerDeg: { pitch: 0, yaw: 0, roll: 0 },
      gyroDps: { x: 0, y: 0, z: 0 },
      triggerPressed: false,
      touchpadPressed: false,
      batteryPct: 92,
      laserHitLabel: null,
      laserDistanceM: null,
    };
    registerInWirelessHub(label, '3DoF Gyro Laser Active (Simulated)', 'streaming');
    emit();
    return state;
  }

  function disconnect(): void {
    virtualSimActive = false;
    activeGamepadIndex = null;
    try {
      activeBleServer?.disconnect?.();
    } catch {
      // Игнорируем ошибку отключения
    }
    activeBleServer = null;

    state = {
      ...state,
      connected: false,
      source: 'none',
      triggerPressed: false,
      touchpadPressed: false,
      laserHitLabel: null,
      laserDistanceM: null,
    };
    emit();
  }

  function recenter(): void {
    simYaw = 0;
    simPitch = 0;
    baseOffsetQuat.copy(rawQuat).invert();
    orientationQuat.identity();
  }

  // Слушатели стандартного Gamepad API (Android/Windows Bluetooth-контроллеры)
  const onGamepadConnected = (ev: GamepadEvent) => {
    const gp = ev.gamepad;
    activeGamepadIndex = gp.index;
    virtualSimActive = false;
    state = {
      ...state,
      connected: true,
      deviceName: gp.id.split('(')[0].trim() || 'Bluetooth Controller',
      source: 'gamepad-api',
    };
    registerInWirelessHub(state.deviceName, `OS BT Gamepad (${platformHint})`, 'streaming');
    recenter();
    emit();
  };

  const onGamepadDisconnected = (ev: GamepadEvent) => {
    if (activeGamepadIndex === ev.gamepad.index) {
      activeGamepadIndex = null;
      if (state.source === 'gamepad-api') {
        disconnect();
      }
    }
  };

  // Слушатели для виртуального тестового режима (мышь двигает луч гироскопа, Space/Shift кликает)
  const onPointerMove = (ev: PointerEvent) => {
    if (!virtualSimActive) return;
    const nx = (ev.clientX / Math.max(1, window.innerWidth)) * 2 - 1;
    const ny = (ev.clientY / Math.max(1, window.innerHeight)) * 2 - 1;
    simYaw = -nx * 0.65 * sensitivity;
    simPitch = -ny * 0.45 * sensitivity;
    state.gyroDps = {
      x: Math.round(-ev.movementY * 3 * sensitivity),
      y: Math.round(-ev.movementX * 3 * sensitivity),
      z: 0,
    };
  };

  const onKeyDown = (ev: KeyboardEvent) => {
    if (!state.connected) return;
    if (ev.code === 'Space' && !ev.repeat && document.activeElement?.tagName !== 'INPUT') {
      simTrigger = true;
    } else if (ev.key.toLowerCase() === 'c' && ev.altKey) {
      recenter();
    }
  };

  const onKeyUp = (ev: KeyboardEvent) => {
    if (ev.code === 'Space') {
      simTrigger = false;
    }
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('gamepadconnected', onGamepadConnected);
    window.addEventListener('gamepaddisconnected', onGamepadDisconnected);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
  }

  function pollGamepadIfAvailable(deltaSec: number): void {
    const pads = navigator.getGamepads?.();
    if (!pads) return;

    const gp =
      (activeGamepadIndex !== null ? pads[activeGamepadIndex] : null) ||
      Array.from(pads).find((p) => p && p.connected) ||
      null;
    if (!gp) return;

    if (!state.connected && state.source === 'none') {
      activeGamepadIndex = gp.index;
      state.connected = true;
      state.deviceName = gp.id.split('(')[0].trim() || 'Bluetooth Gamepad';
      state.source = 'gamepad-api';
      registerInWirelessHub(state.deviceName, `OS BT Gamepad (${platformHint})`, 'streaming');
      emit();
    }

    if (state.source !== 'gamepad-api') return;

    const gpWithPose = gp as Gamepad & {
      pose?: { hasOrientation?: boolean; orientation?: Float32Array | null };
    };

    if (gpWithPose.pose?.hasOrientation && gpWithPose.pose.orientation) {
      const o = gpWithPose.pose.orientation;
      rawQuat.set(o[0], o[1], o[2], o[3]).normalize();
    } else {
      // Если браузер не пробрасывает HID gyro pose напрямую — поддерживаем наведение правым/левым стиком
      const axX = Math.abs(gp.axes[0] || 0) > 0.12 ? gp.axes[0] : 0;
      const axY = Math.abs(gp.axes[1] || 0) > 0.12 ? gp.axes[1] : 0;
      const axRX = Math.abs(gp.axes[2] || 0) > 0.12 ? gp.axes[2] : 0;
      const axRY = Math.abs(gp.axes[3] || 0) > 0.12 ? gp.axes[3] : 0;
      const yawRate = -(axRX || axX) * 1.8 * sensitivity;
      const pitchRate = -(axRY || axY) * 1.4 * sensitivity;
      simYaw = THREE.MathUtils.clamp(simYaw + yawRate * deltaSec, -1.2, 1.2);
      simPitch = THREE.MathUtils.clamp(simPitch + pitchRate * deltaSec, -0.9, 0.9);
      tempEuler.set(simPitch, simYaw, 0, 'YXZ');
      rawQuat.setFromEuler(tempEuler);
      state.gyroDps = {
        x: Math.round(THREE.MathUtils.radToDeg(pitchRate)),
        y: Math.round(THREE.MathUtils.radToDeg(yawRate)),
        z: 0,
      };
    }

    state.triggerPressed = Boolean(gp.buttons[0]?.pressed || gp.buttons[7]?.pressed);
    state.touchpadPressed = Boolean(gp.buttons[2]?.pressed || gp.buttons[3]?.pressed);
    if (gp.buttons[1]?.pressed || gp.buttons[9]?.pressed) {
      recenter();
    }
  }

  function update(deltaSec: number): BtGyroControllerState {
    const dt = Math.min(Math.max(deltaSec, 0.001), 0.1);
    pollGamepadIfAvailable(dt);

    if (!state.connected) return state;

    if (state.source === 'ble-gatt') {
      // Если BLE шлет угловые скорости (deg/s) без абсолютного кватерниона — интегрируем по dt
      const { x, y, z } = state.gyroDps;
      if (Math.abs(x) > 0.2 || Math.abs(y) > 0.2 || Math.abs(z) > 0.2) {
        const deltaEuler = new THREE.Euler(
          THREE.MathUtils.degToRad(x) * dt * sensitivity,
          THREE.MathUtils.degToRad(y) * dt * sensitivity,
          THREE.MathUtils.degToRad(z) * dt * sensitivity,
          'YXZ'
        );
        const dq = new THREE.Quaternion().setFromEuler(deltaEuler);
        rawQuat.multiply(dq).normalize();
      }
    } else if (state.source === 'simulated-bt') {
      tempEuler.set(simPitch, simYaw, 0, 'YXZ');
      rawQuat.setFromEuler(tempEuler);
      state.triggerPressed = simTrigger;
    }

    orientationQuat.copy(baseOffsetQuat).multiply(rawQuat).normalize();
    tempEuler.setFromQuaternion(orientationQuat, 'YXZ');

    state.quaternion = [
      Number(orientationQuat.x.toFixed(4)),
      Number(orientationQuat.y.toFixed(4)),
      Number(orientationQuat.z.toFixed(4)),
      Number(orientationQuat.w.toFixed(4)),
    ];
    state.eulerDeg = {
      pitch: Math.round(THREE.MathUtils.radToDeg(tempEuler.x) * 10) / 10,
      yaw: Math.round(THREE.MathUtils.radToDeg(tempEuler.y) * 10) / 10,
      roll: Math.round(THREE.MathUtils.radToDeg(tempEuler.z) * 10) / 10,
    };

    return state;
  }

  return {
    connectBleGyroController,
    connectVirtualGyroStub,
    disconnect,
    recenter,
    setSensitivity: (val: number) => {
      sensitivity = THREE.MathUtils.clamp(val, 0.3, 2.5);
    },
    setLaserHitInfo: (label: string | null, distanceM: number | null) => {
      state.laserHitLabel = label;
      state.laserDistanceM = distanceM;
    },
    update,
    getState: () => state,
    getThreeQuaternion: (target = new THREE.Quaternion()) => target.copy(orientationQuat),
    subscribe: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    dispose: () => {
      disconnect();
      if (typeof window !== 'undefined') {
        window.removeEventListener('gamepadconnected', onGamepadConnected);
        window.removeEventListener('gamepaddisconnected', onGamepadDisconnected);
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('keydown', onKeyDown);
        window.removeEventListener('keyup', onKeyUp);
      }
      listeners.clear();
    },
  };
}

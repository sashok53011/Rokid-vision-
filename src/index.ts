/**
 * Точка входа приложения Rokid Vision XR Hub (/src/index.ts).
 *
 * Назначение:
 * Собирает и связывает воедино все независимые функциональные модули:
 * - localizeInterface (EN/RU/DE)
 * - manageCustomEndpoints (CRUD OpenAI-совместимых / RTC / Cloud эндпоинтов)
 * - detectObjectsFromCamera & trackHandsFromCamera (Android-камера + MediaPipe ML)
 * - recognizeHeadGestures (жесты головы + XR Blocks HeadGestureRecognition)
 * - readRokidImuAndProtocol (протокол Rokid Max 1st Gen HID + стабилизация IMU)
 * - switchViewingMode (Auto / Monoscopic / SBS 3D Stereo / 360°)
 * - navigateRemotely (локальная и синхронизированная навигация)
 * - connectBluetoothAndWifiDevices (Bluetooth LE + Wi-Fi/LAN)
 * - streamCloudEnvironment (облачный рендеринг + процедурная PBR-сцена)
 * - monitorPerformanceAndBattery (FPS, память, батарея, задержки ML/IMU)
 * - communicatePeerTtsStt (прямое общение TTS/STT между участниками сессии + перевод)
 * И запускает XR Blocks (`xb.init(options)`).
 */

import * as xb from 'xrblocks';
import { DEFAULT_SETTINGS, STORAGE_KEYS } from './constants';
import type { AppSettingsState } from './types';
import { createTranslator } from './modules/localizeInterface';
import { createEndpointManager } from './modules/manageCustomEndpoints';
import { createCameraObjectDetector } from './modules/detectObjectsFromCamera';
import { createCameraHandTracker } from './modules/trackHandsFromCamera';
import { createHeadGestureController } from './modules/recognizeHeadGestures';
import { createRokidImuController } from './modules/readRokidImuAndProtocol';
import { createViewingModeController } from './modules/switchViewingMode';
import { createRemoteNavigationController } from './modules/navigateRemotely';
import { createWirelessDeviceHub } from './modules/connectBluetoothAndWifiDevices';
import { createCloudEnvironmentController } from './modules/streamCloudEnvironment';
import { createDiagnosticsMonitor } from './modules/monitorPerformanceAndBattery';
import { createPeerCommsController } from './modules/communicatePeerTtsStt';
import { createSpatialAudioBalancer } from './modules/balanceSpatialAudio';
import { createDetectionClassManager } from './modules/manageDetectionClasses';
import { createBluetoothGyroController } from './modules/connectBluetoothGyroController';
import { createSpatialPlacesManager } from './modules/build3dPlacesAndControlPanels';
import { SpatialVisionScene } from './xr/SpatialVisionScene';
import { mountControlHud, type HudController } from './ui/renderControlHud';

function loadSettings(): AppSettingsState {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.SETTINGS);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AppSettingsState>;
      return {
        ...DEFAULT_SETTINGS,
        ...parsed,
        audioSettings: {
          ...DEFAULT_SETTINGS.audioSettings,
          ...(parsed.audioSettings || {}),
          btDeviceProfiles: {
            ...(parsed.audioSettings?.btDeviceProfiles || {}),
          },
        },
        detectionObjects: {
          ...DEFAULT_SETTINGS.detectionObjects,
          ...(parsed.detectionObjects || {}),
          enabledClasses:
            parsed.detectionObjects?.enabledClasses ??
            [...DEFAULT_SETTINGS.detectionObjects.enabledClasses],
          customClasses:
            parsed.detectionObjects?.customClasses ??
            [...DEFAULT_SETTINGS.detectionObjects.customClasses],
        },
      };
    }
  } catch {
    // Используем настройки по умолчанию
  }
  return {
    ...DEFAULT_SETTINGS,
    audioSettings: {
      ...DEFAULT_SETTINGS.audioSettings,
      btDeviceProfiles: {},
    },
    detectionObjects: {
      ...DEFAULT_SETTINGS.detectionObjects,
      enabledClasses: [...DEFAULT_SETTINGS.detectionObjects.enabledClasses],
      customClasses: [],
    },
  };
}

function saveSettings(settings: AppSettingsState): void {
  try {
    localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(settings));
  } catch {
    // Игнорируем ошибку хранилища
  }
}

document.addEventListener('DOMContentLoaded', () => {
  let settings = loadSettings();

  // Инициализация независимых переиспользуемых модулей
  const translator = createTranslator(settings.uiLanguage);
  const endpoints = createEndpointManager();
  const cameraDetector = createCameraObjectDetector();
  const handTracker = createCameraHandTracker();
  const headGestures = createHeadGestureController();
  const rokidImu = createRokidImuController();
  const viewingMode = createViewingModeController();
  const remoteNav = createRemoteNavigationController();
  const cloudEnv = createCloudEnvironmentController();
  const diagnostics = createDiagnosticsMonitor();
  const audioBalancer = createSpatialAudioBalancer();
  const detectionManager = createDetectionClassManager();
  const placesManager = createSpatialPlacesManager();

  placesManager.setActivePlace(settings.activeScenePlace);
  cloudEnv.setBaseLabVisible(settings.activeScenePlace === 'calibration_lab');

  const btGyroController = createBluetoothGyroController((device) => {
    wirelessHub.pushExternalSync({ ...device, id: device.id });
  });
  btGyroController.setSensitivity(settings.btGyroSensitivity);

  audioBalancer.applySettings(settings.audioSettings);
  cameraDetector.setAllowedClasses(
    detectionManager.getMediaPipeAllowlist(settings.detectionObjects)
  );

  let hud: HudController | null = null;
  let sceneScript: SpatialVisionScene | null = null;

  const peerComms = createPeerCommsController({
    onConnectionState: (connected) => hud?.setWsConnected(connected),
    onPeersChanged: () => hud?.refreshComms(),
    onMessageReceived: (msg) => {
      hud?.refreshComms();
      if (settings.autoSpeakIncoming && msg.fromPeerId !== peerComms.getPeerId()) {
        void peerComms.speakText(
          msg.translatedText || msg.originalText,
          msg.targetLang,
          endpoints.getActiveByType('tts')
        );
      }
    },
    onNavCommand: (cmd) => remoteNav.applyRemoteCommand(cmd),
    onDeviceSync: (device) => wirelessHub.pushExternalSync(device),
  });

  const wirelessHub = createWirelessDeviceHub((device) => {
    peerComms.broadcastDeviceSync(device);
  });

  remoteNav.onBroadcast((cmd) => {
    peerComms.broadcastNavCommand(cmd);
  });

  const updateSettings = (patch: Partial<AppSettingsState>) => {
    settings = {
      ...settings,
      ...patch,
      audioSettings: patch.audioSettings
        ? {
            ...settings.audioSettings,
            ...patch.audioSettings,
            btDeviceProfiles: patch.audioSettings.btDeviceProfiles ?? settings.audioSettings.btDeviceProfiles,
          }
        : settings.audioSettings,
      detectionObjects: patch.detectionObjects
        ? {
            ...settings.detectionObjects,
            ...patch.detectionObjects,
          }
        : settings.detectionObjects,
    };
    saveSettings(settings);

    if (patch.uiLanguage) {
      translator.setLanguage(patch.uiLanguage);
    }
    if (patch.viewingMode !== undefined || patch.ipdMm !== undefined) {
      viewingMode.setIpdMm(settings.ipdMm);
      viewingMode.setMode(settings.viewingMode, rokidImu.detectHeadsetProfile());
    }
    if (patch.cloudRenderEnabled !== undefined) {
      cloudEnv.setCloudStream(
        settings.cloudRenderEnabled,
        endpoints.getActiveByType('cloud_render')
      );
    }
    if (patch.audioSettings !== undefined) {
      audioBalancer.applySettings(settings.audioSettings);
      sceneScript?.syncAudioCard(settings.audioSettings);
    }
    if (patch.detectionObjects !== undefined) {
      cameraDetector.setAllowedClasses(
        detectionManager.getMediaPipeAllowlist(settings.detectionObjects)
      );
    }
    if (patch.btGyroSensitivity !== undefined) {
      btGyroController.setSensitivity(settings.btGyroSensitivity);
    }
    if (patch.activeScenePlace !== undefined) {
      placesManager.setActivePlace(settings.activeScenePlace);
      cloudEnv.setBaseLabVisible(settings.activeScenePlace === 'calibration_lab');
      hud?.refreshPlaceControls();
    }
  };

  // Подключаемся к виртуальной комнате WebSocket для TTS/STT и синхронизации устройств
  peerComms.connect(
    settings.roomId,
    settings.userName,
    settings.sourceSpeechLang,
    rokidImu.detectHeadsetProfile()
  );

  sceneScript = new SpatialVisionScene({
    translator,
    endpoints,
    cameraDetector,
    handTracker,
    headGestures,
    rokidImu,
    viewingMode,
    remoteNav,
    cloudEnv,
    placesManager,
    diagnostics,
    audioBalancer,
    detectionManager,
    btGyroController,
    getSettings: () => settings,
    onUpdateAudioSettings: (audioPatch) =>
      updateSettings({
        audioSettings: { ...settings.audioSettings, ...audioPatch },
      }),
    onModeCycleRequest: (next) => updateSettings({ viewingMode: next }),
    onPlaceChangeRequest: (place) => updateSettings({ activeScenePlace: place }),
    onPlacePanelTriggered: () => hud?.refreshPlaceControls(),
    onTelemetryTick: (payload) => hud?.updateLiveTelemetry(payload),
    onHeadGestureTriggered: (action) => hud?.handleHeadGesture(action),
  });

  hud = mountControlHud({
    translator,
    endpoints,
    cameraDetector,
    wirelessHub,
    peerComms,
    audioBalancer,
    detectionManager,
    btGyroController,
    placesManager,
    getSettings: () => settings,
    updateSettings,
    onConnectRokidHid: async () => {
      const res = await rokidImu.connectRokidHid();
      if (res.ok) {
        wirelessHub.registerUsbHidDevice(res.deviceName, res.message);
        updateSettings({ viewingMode: 'sbs' });
      }
      return res;
    },
    onNavigate: (cmd) => remoteNav.dispatch(cmd, true),
    onXrScan: () => void sceneScript?.runXrWorldScan(),
  });

  // Конфигурация XR Blocks (с поддержкой рук, жестов головы, детекции и симулятора)
  const options = new xb.Options();
  options.setAppTitle('Rokid Vision XR Hub');
  options.setAppDescription(
    'Real-time camera ML object & hand tracking, Rokid Max IMU & SBS/360 stereo, BT/Wi-Fi sync, diagnostics, and any-to-any translated TTS/STT.'
  );
  options.enableHands();
  options.enableHeadGestures();
  options.enableReticles();
  options.enableObjectDetection();
  options.world.objects.backendConfig.activeBackend = 'mediapipe';
  options.permissions.camera = true;
  options.permissions.microphone = true;

  xb.add(sceneScript);
  void xb.init(options);
});

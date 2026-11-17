/**
 * Глобальные типы и контракты данных приложения Rokid Vision XR Hub.
 *
 * Назначение модуля:
 * Единое описание входных и выходных структур данных, которыми обмениваются
 * все функциональные модули (детекция объектов, трекинг рук, жесты головы,
 * IMU Rokid Max 1st Gen, режимы отображения, BT/Wi-Fi, облачный рендеринг,
 * телеметрия производительности и батареи, переводы и пользовательские эндпоинты).
 */

export type AppLanguage = 'en' | 'ru' | 'de';

export type TranslationLanguageCode =
  | 'en'
  | 'ru'
  | 'de'
  | 'es'
  | 'fr'
  | 'zh'
  | 'ja'
  | 'ko'
  | 'ar';

export type ViewingMode = 'auto' | 'monoscopic' | 'sbs' | '360';

export type ResolvedViewingMode = 'monoscopic' | 'sbs' | '360';

export type HeadsetProfile =
  | 'rokid_max_1'
  | 'galaxy_xr'
  | 'meta_quest'
  | 'generic_vr'
  | 'desktop_monitor';

export type EndpointCategory =
  | 'llm'
  | 'stt'
  | 'tts'
  | 'vision'
  | 'rtc'
  | 'cloud_render';

export type NavigationTabId =
  | 'vision'
  | 'devices'
  | 'comms'
  | 'diagnostics'
  | 'endpoints'
  | 'settings';

export type HeadGestureAction = 'nod' | 'shake' | 'tilt_left' | 'tilt_right';

export interface ImuTelemetry {
  source: 'rokid-hid' | 'webxr-pose' | 'device-orientation' | 'mouse-sim';
  quaternion: [number, number, number, number];
  eulerDeg: { pitch: number; yaw: number; roll: number };
  angularVelocity: { x: number; y: number; z: number };
  linearAcceleration: { x: number; y: number; z: number };
  latencyMs: number;
  stabilized: boolean;
  rokidConnected: boolean;
  ipdMm: number;
}

export interface DetectedEntity {
  id: string;
  label: string;
  score: number;
  /** Нормализованные координаты [xmin, ymin, xmax, ymax] в диапазоне 0..1 */
  bbox: [number, number, number, number];
  worldPosition?: [number, number, number];
  source: 'mediapipe' | 'vision-endpoint' | 'xrblocks';
}

export type WebcamResolutionPreset = '480p' | '720p' | '1080p';

export interface WebcamDeviceInfo {
  deviceId: string;
  label: string;
  isDefault?: boolean;
}

export interface WebcamStreamMeta {
  deviceId: string;
  label: string;
  width: number;
  height: number;
  frameRate: number | null;
  facingMode: 'environment' | 'user';
}

export interface CameraHandPoint {
  x: number;
  y: number;
  z: number;
}

export interface HandGestureScore {
  name: 'Pinch' | 'Open Palm' | 'Point' | 'Fist' | 'Victory';
  confidence: number;
  active: boolean;
}

export interface CameraHandState {
  detected: boolean;
  handedness: 'Left' | 'Right' | 'Unknown';
  handednessConfidence: number;
  pinching: boolean;
  pinchDistance: number;
  gestureLabel: string;
  gestureConfidence: number;
  gestureScores: HandGestureScore[];
  landmarks: CameraHandPoint[];
  worldLandmarks: CameraHandPoint[];
  inferenceMs: number;
  isSimulated?: boolean;
}

export interface CustomEndpointConfig {
  id: string;
  name: string;
  type: EndpointCategory;
  baseUrl: string;
  apiKey: string;
  model: string;
  availableModels: string[];
  customHeadersJson: string;
  enabled: boolean;
  lastTestStatus: 'idle' | 'ok' | 'error';
  lastTestMessage: string;
  lastLatencyMs: number | null;
}

export interface SessionPeer {
  peerId: string;
  name: string;
  language: TranslationLanguageCode;
  device: string;
  connectedAt: number;
}

export interface TranslatedSpeechMessage {
  id: string;
  fromPeerId: string;
  fromName: string;
  toPeerId: 'all' | string;
  sourceLang: TranslationLanguageCode;
  targetLang: TranslationLanguageCode;
  originalText: string;
  translatedText: string;
  timestamp: number;
}

export interface WirelessDeviceEntry {
  id: string;
  name: string;
  transport: 'bluetooth' | 'wifi' | 'webrtc' | 'usb-hid';
  status: 'connected' | 'streaming' | 'disconnected' | 'error';
  detail: string;
  lastSyncAt: number;
}

export type GyroControllerSource =
  | 'none'
  | 'ble-gatt'
  | 'gamepad-api'
  | 'ws-bridge'
  | 'simulated-bt';

export interface BtGyroControllerState {
  connected: boolean;
  deviceName: string;
  platformHint: 'android' | 'windows' | 'universal';
  source: GyroControllerSource;
  quaternion: [number, number, number, number];
  eulerDeg: { pitch: number; yaw: number; roll: number };
  gyroDps: { x: number; y: number; z: number };
  triggerPressed: boolean;
  touchpadPressed: boolean;
  batteryPct: number | null;
  laserHitLabel: string | null;
  laserDistanceM: number | null;
}

export interface PerformanceDiagnostics {
  fps: number;
  frameTimeMs: number;
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
  memoryUsedMb: number | null;
  mlInferenceMs: number;
  imuLatencyMs: number;
  batteryLevelPct: number | null;
  batteryCharging: boolean | null;
  batteryDischargeMin: number | null;
  thermalState: 'nominal' | 'warm' | 'throttled';
}

export interface CloudRenderState {
  enabled: boolean;
  status: 'local-procedural' | 'connecting' | 'streaming' | 'error';
  endpointUrl: string;
  resolution: string;
  bitrateKbps: number;
  frameCount: number;
}

export type AttenuationModelType = 'linear' | 'inverse' | 'exponential';

export interface BluetoothDeviceAudioProfile {
  deviceId: string;
  deviceName: string;
  gain: number;
  attenuationModel: AttenuationModelType;
  pan: number;
  rolloffFactor: number;
  refDistance: number;
  maxDistance: number;
}

export interface SpatialAudioSettingsState {
  masterGain: number;
  spatialBalance: number;
  attenuationModel: AttenuationModelType;
  rolloffFactor: number;
  refDistance: number;
  maxDistance: number;
  btDeviceProfiles: Record<string, BluetoothDeviceAudioProfile>;
}

export type DetectionClassGroupId =
  | 'furniture'
  | 'personal'
  | 'electronics'
  | 'environment';

export interface DetectionObjectsSettings {
  trackAllClasses: boolean;
  enabledClasses: string[];
  customClasses: string[];
}

export interface AppSettingsState {
  uiLanguage: AppLanguage;
  sourceSpeechLang: TranslationLanguageCode;
  targetTranslateLang: TranslationLanguageCode;
  viewingMode: ViewingMode;
  ipdMm: number;
  imuStabilizationStrength: number;
  headGesturesEnabled: boolean;
  cameraObjectDetectionEnabled: boolean;
  cameraHandTrackingEnabled: boolean;
  cloudRenderEnabled: boolean;
  autoSpeakIncoming: boolean;
  roomId: string;
  userName: string;
  audioSettings: SpatialAudioSettingsState;
  detectionObjects: DetectionObjectsSettings;
  webcamDeviceId: string;
  webcamResolution: WebcamResolutionPreset;
  webcamMirror: boolean;
  webcam3dPreviewEnabled: boolean;
  btLaserBeamEnabled: boolean;
  btGyroSensitivity: number;
  handDiagnosticOverlayEnabled: boolean;
  handShowLandmarkIndices: boolean;
  activeScenePlace: SpatialPlaceId;
}

export type SpatialPlaceId =
  | 'calibration_lab'
  | 'datacenter'
  | 'spaceship'
  | 'airplane'
  | 'cyber_lounge';

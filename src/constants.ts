/**
 * Константы конфигурации приложения Rokid Vision XR Hub.
 *
 * Содержит:
 * - Ключи localStorage для сохранения настроек и пользовательских эндпоинтов;
 * - Идентификаторы USB/HID устройств Rokid Max 1st Gen (VendorID / ProductID);
 * - Поддерживаемые языки интерфейса и мгновенного перевода;
 * - Шаблоны начальных OpenAI-совместимых, RTC и Cloud Render эндпоинтов.
 */

import type {
  AppSettingsState,
  CustomEndpointConfig,
  EndpointCategory,
  TranslationLanguageCode,
} from './types';

export const STORAGE_KEYS = {
  ENDPOINTS: 'rokid_vision_endpoints_v1',
  SETTINGS: 'rokid_vision_settings_v1',
  PEER_ID: 'rokid_vision_peer_id_v1',
} as const;

/**
 * Известные USB/HID идентификаторы очков Rokid Max (1st Gen) и адаптеров Rokid Air/Station.
 * В продакшне могут быть расширены точным списком PID из Rokid UXR SDK.
 */
export const ROKID_USB_FILTERS = [
  { vendorId: 0x04d2 }, // Rokid Corp. Vendor ID
  { vendorId: 0x2833 }, // XR/Display IMU bridge fallback
];

export const TRANSLATION_LANGUAGES: Array<{
  code: TranslationLanguageCode;
  nativeLabel: string;
}> = [
  { code: 'en', nativeLabel: 'English' },
  { code: 'ru', nativeLabel: 'Русский' },
  { code: 'de', nativeLabel: 'Deutsch' },
  { code: 'es', nativeLabel: 'Español' },
  { code: 'fr', nativeLabel: 'Français' },
  { code: 'zh', nativeLabel: '中文' },
  { code: 'ja', nativeLabel: '日本語' },
  { code: 'ko', nativeLabel: '한국어' },
  { code: 'ar', nativeLabel: 'العربية' },
];

export const ENDPOINT_CATEGORIES: EndpointCategory[] = [
  'llm',
  'stt',
  'tts',
  'vision',
  'rtc',
  'cloud_render',
];

export const DEFAULT_SETTINGS: AppSettingsState = {
  uiLanguage: 'en',
  sourceSpeechLang: 'en',
  targetTranslateLang: 'ru',
  viewingMode: 'auto',
  ipdMm: 63,
  imuStabilizationStrength: 0.85,
  headGesturesEnabled: true,
  cameraObjectDetectionEnabled: true,
  cameraHandTrackingEnabled: true,
  cloudRenderEnabled: false,
  autoSpeakIncoming: true,
  roomId: 'rokid-global-session',
  userName: 'XR-Explorer',
  audioSettings: {
    masterGain: 1.0,
    spatialBalance: 0.0,
    attenuationModel: 'inverse',
    rolloffFactor: 1.0,
    refDistance: 1.0,
    maxDistance: 25.0,
    btDeviceProfiles: {},
  },
  detectionObjects: {
    trackAllClasses: true,
    enabledClasses: [
      'chair',
      'couch',
      'dining table',
      'bed',
      'backpack',
      'handbag',
      'bottle',
      'cup',
      'book',
      'laptop',
      'cell phone',
      'keyboard',
      'mouse',
      'tv',
      'person',
      'potted plant',
    ],
    customClasses: [],
  },
  webcamDeviceId: '',
  webcamResolution: '720p',
  webcamMirror: false,
  webcam3dPreviewEnabled: true,
  btLaserBeamEnabled: true,
  btGyroSensitivity: 1.0,
  handDiagnosticOverlayEnabled: true,
  handShowLandmarkIndices: true,
  activeScenePlace: 'calibration_lab',
};

export const DEFAULT_ENDPOINTS: CustomEndpointConfig[] = [
  {
    id: 'default-openai-llm',
    name: 'OpenAI-Compatible LLM (Chat & Translate)',
    type: 'llm',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    availableModels: ['gpt-4o-mini', 'gpt-4o'],
    customHeadersJson: '{}',
    enabled: true,
    lastTestStatus: 'idle',
    lastTestMessage: '',
    lastLatencyMs: null,
  },
  {
    id: 'default-openai-stt',
    name: 'OpenAI-Compatible STT (Whisper)',
    type: 'stt',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'whisper-1',
    availableModels: ['whisper-1'],
    customHeadersJson: '{}',
    enabled: false,
    lastTestStatus: 'idle',
    lastTestMessage: '',
    lastLatencyMs: null,
  },
  {
    id: 'default-openai-tts',
    name: 'OpenAI-Compatible TTS (Audio Speech)',
    type: 'tts',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'tts-1',
    availableModels: ['tts-1', 'tts-1-hd'],
    customHeadersJson: '{}',
    enabled: false,
    lastTestStatus: 'idle',
    lastTestMessage: '',
    lastLatencyMs: null,
  },
  {
    id: 'default-openai-vision',
    name: 'OpenAI-Compatible Vision (Multimodal)',
    type: 'vision',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    availableModels: ['gpt-4o-mini', 'gpt-4o'],
    customHeadersJson: '{}',
    enabled: false,
    lastTestStatus: 'idle',
    lastTestMessage: '',
    lastLatencyMs: null,
  },
  {
    id: 'default-rtc-signaling',
    name: 'WebRTC / OpenAI Realtime Endpoint',
    type: 'rtc',
    baseUrl: 'wss://api.openai.com/v1/realtime',
    apiKey: '',
    model: 'gpt-4o-realtime-preview',
    availableModels: ['gpt-4o-realtime-preview'],
    customHeadersJson: '{"stun":"stun:stun.l.google.com:19302"}',
    enabled: true,
    lastTestStatus: 'idle',
    lastTestMessage: '',
    lastLatencyMs: null,
  },
  {
    id: 'default-cloud-render',
    name: 'Cloud 3D Render Node (WebRTC/WS Stream)',
    type: 'cloud_render',
    baseUrl: 'http://localhost:8088/render',
    apiKey: '',
    model: 'unreal-pixelstream-v1',
    availableModels: ['unreal-pixelstream-v1', 'three-headless-gpu'],
    customHeadersJson: '{}',
    enabled: false,
    lastTestStatus: 'idle',
    lastTestMessage: '',
    lastLatencyMs: null,
  },
];

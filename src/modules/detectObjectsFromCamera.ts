/**
 * Модуль потокового захвата камеры и ML-детекции объектов (detectObjectsFromCamera).
 *
 * Назначение:
 * 1. Управляет видеопотоком камеры Android-устройства / смартфона / ПК (front/environment);
 * 2. Загружает и запускает ML-модель MediaPipe ObjectDetector (EfficientDet-Lite0)
 *    через @mediapipe/tasks-vision в реальном времени;
 * 3. Позволяет дополнять локальную детекцию вызовом пользовательского Vision-эндпоинта
 *    (OpenAI-совместимый мультимодальный анализ кадра).
 *
 * Входные параметры:
 * - videoElement: HTMLVideoElement — элемент видео для воспроизведения потока камеры;
 * - facingMode: 'environment' | 'user' — выбор тыльной (Android AR) или фронтальной камеры;
 * - visionEndpoint?: CustomEndpointConfig — опциональный внешний Vision LLM-эндпоинт.
 *
 * Выходные данные:
 * - Массив DetectedEntity[] (id, label, score, bbox [xmin, ymin, xmax, ymax]);
 * - Время инференса ML-модели в миллисекундах (inferenceMs).
 */

import { FilesetResolver, ObjectDetector } from '@mediapipe/tasks-vision';
import type {
  CustomEndpointConfig,
  DetectedEntity,
  WebcamDeviceInfo,
  WebcamResolutionPreset,
  WebcamStreamMeta,
} from '../types';

export interface StartCameraOptions {
  facingMode?: 'environment' | 'user';
  deviceId?: string;
  resolution?: WebcamResolutionPreset;
}

export interface CameraObjectDetectionController {
  startCamera(options?: 'environment' | 'user' | StartCameraOptions): Promise<MediaStream | null>;
  stopCamera(): void;
  switchCamera(): Promise<MediaStream | null>;
  listCameras(): Promise<WebcamDeviceInfo[]>;
  onDevicesChanged(listener: (devices: WebcamDeviceInfo[]) => void): () => void;
  getActiveCameraMeta(): WebcamStreamMeta | null;
  setAllowedClasses(allowlist: string[] | null): void;
  detectFrame(visionEndpoint?: CustomEndpointConfig): Promise<{
    entities: DetectedEntity[];
    inferenceMs: number;
  }>;
  getVideoElement(): HTMLVideoElement;
  isCameraActive(): boolean;
  getFacingMode(): 'environment' | 'user';
  dispose(): void;
}

const MEDIAPIPE_WASM_CDN =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34/wasm';
const OBJECT_DETECTOR_MODEL =
  'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite';

export function createCameraObjectDetector(
  existingVideo?: HTMLVideoElement
): CameraObjectDetectionController {
  const video = existingVideo || document.createElement('video');
  video.playsInline = true;
  video.muted = true;
  video.autoplay = true;

  let stream: MediaStream | null = null;
  let facingMode: 'environment' | 'user' = 'environment';
  let currentDeviceId = '';
  let currentResolution: WebcamResolutionPreset = '720p';
  let detector: ObjectDetector | null = null;
  let modelLoadingPromise: Promise<void> | null = null;
  let modelLoadFailed = false;
  let lastVideoTime = -1;
  let cachedEntities: DetectedEntity[] = [];
  let lastVisionCallAt = 0;
  let allowedClasses: string[] | null = null;
  const deviceListeners = new Set<(devices: WebcamDeviceInfo[]) => void>();

  const RESOLUTION_MAP: Record<WebcamResolutionPreset, { width: number; height: number }> = {
    '480p': { width: 640, height: 480 },
    '720p': { width: 1280, height: 720 },
    '1080p': { width: 1920, height: 1080 },
  };

  async function listCameras(): Promise<WebcamDeviceInfo[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoInputs = devices.filter((d) => d.kind === 'videoinput');
      return videoInputs.map((d, idx) => ({
        deviceId: d.deviceId,
        label: d.label?.trim() || `Webcam #${idx + 1}`,
        isDefault: idx === 0,
      }));
    } catch {
      return [];
    }
  }

  const handleNativeDeviceChange = () => {
    void listCameras().then((cams) => {
      for (const listener of deviceListeners) {
        listener(cams);
      }
    });
  };

  if (typeof navigator !== 'undefined' && navigator.mediaDevices?.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', handleNativeDeviceChange);
  }

  function onDevicesChanged(listener: (devices: WebcamDeviceInfo[]) => void): () => void {
    deviceListeners.add(listener);
    return () => deviceListeners.delete(listener);
  }

  function getActiveCameraMeta(): WebcamStreamMeta | null {
    if (!stream) return null;
    const track = stream.getVideoTracks()[0];
    if (!track) return null;
    const settings = track.getSettings();
    return {
      deviceId: settings.deviceId || currentDeviceId,
      label: track.label || 'Webcam',
      width: settings.width || video.videoWidth || 0,
      height: settings.height || video.videoHeight || 0,
      frameRate: typeof settings.frameRate === 'number' ? Math.round(settings.frameRate) : null,
      facingMode,
    };
  }

  function matchesAllowedClasses(label: string): boolean {
    if (allowedClasses === null) return true;
    if (allowedClasses.length === 0) return false;
    const norm = label.trim().toLowerCase();
    return allowedClasses.some((cls) => {
      const target = cls.trim().toLowerCase();
      return norm === target || norm.includes(target) || target.includes(norm);
    });
  }

  function setAllowedClasses(allowlist: string[] | null): void {
    allowedClasses = allowlist ? allowlist.map((c) => c.trim().toLowerCase()).filter(Boolean) : null;
    if (allowedClasses !== null) {
      cachedEntities = cachedEntities.filter((e) => matchesAllowedClasses(e.label));
    }
    if (detector) {
      void detector
        .setOptions({
          categoryAllowlist:
            allowedClasses && allowedClasses.length > 0 ? allowedClasses : undefined,
        })
        .catch(() => {
          // Фоллбэк-фильтрация выполняется на выходе detectFrame()
        });
    }
  }

  async function ensureModelLoaded(): Promise<void> {
    if (detector || modelLoadFailed) return;
    if (modelLoadingPromise) return modelLoadingPromise;

    modelLoadingPromise = (async () => {
      try {
        const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_CDN);
        detector = await ObjectDetector.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: OBJECT_DETECTOR_MODEL,
            delegate: 'GPU',
          },
          scoreThreshold: 0.38,
          maxResults: 8,
          runningMode: 'VIDEO',
          ...(allowedClasses && allowedClasses.length > 0
            ? { categoryAllowlist: allowedClasses }
            : {}),
        });
      } catch (err) {
        // Если GPU-делегат или CDN недоступны (например, оффлайн-среда), пробуем CPU или откладываем на Vision-эндпоинт
        console.warn('[ObjectDetector] Не удалось загрузить MediaPipe GPU модель:', err);
        modelLoadFailed = true;
      }
    })();

    return modelLoadingPromise;
  }

  async function startCamera(
    options: 'environment' | 'user' | StartCameraOptions = facingMode
  ): Promise<MediaStream | null> {
    stopCamera();
    const resolved: StartCameraOptions =
      typeof options === 'string' ? { facingMode: options } : options;

    facingMode = resolved.facingMode ?? facingMode;
    if (resolved.deviceId !== undefined) {
      currentDeviceId = resolved.deviceId;
    }
    if (resolved.resolution) {
      currentResolution = resolved.resolution;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      console.warn('[Camera] navigator.mediaDevices.getUserMedia недоступен.');
      return null;
    }

    const dims = RESOLUTION_MAP[currentResolution];
    const attempts: MediaStreamConstraints[] = [];

    if (currentDeviceId) {
      attempts.push({
        video: {
          deviceId: { exact: currentDeviceId },
          width: { ideal: dims.width },
          height: { ideal: dims.height },
        },
        audio: false,
      });
      attempts.push({
        video: { deviceId: { exact: currentDeviceId } },
        audio: false,
      });
    }

    attempts.push({
      video: {
        facingMode: { ideal: facingMode },
        width: { ideal: dims.width },
        height: { ideal: dims.height },
      },
      audio: false,
    });
    // Универсальный фоллбэк для десктопных USB-вебкамер без facingMode
    attempts.push({ video: true, audio: false });

    for (const constraints of attempts) {
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
        break;
      } catch {
        stream = null;
      }
    }

    if (!stream) {
      console.warn('[Camera] Не удалось открыть ни одну веб-камеру.');
      return null;
    }

    try {
      video.srcObject = stream;
      await video.play();
      const activeTrack = stream.getVideoTracks()[0];
      const trackDeviceId = activeTrack?.getSettings().deviceId;
      if (trackDeviceId) {
        currentDeviceId = trackDeviceId;
      }
      handleNativeDeviceChange();
      void ensureModelLoaded();
      return stream;
    } catch (error) {
      console.warn('[Camera] Ошибка воспроизведения потока веб-камеры:', error);
      return null;
    }
  }

  function stopCamera(): void {
    if (stream) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
      stream = null;
    }
    video.srcObject = null;
  }

  async function switchCamera(): Promise<MediaStream | null> {
    const cameras = await listCameras();
    if (cameras.length > 1) {
      const idx = cameras.findIndex((c) => c.deviceId === currentDeviceId);
      const next = cameras[(idx + 1) % cameras.length];
      return startCamera({ deviceId: next.deviceId, resolution: currentResolution });
    }
    const nextFacing = facingMode === 'environment' ? 'user' : 'environment';
    return startCamera({ facingMode: nextFacing, deviceId: '', resolution: currentResolution });
  }

  async function queryVisionEndpointIfEnabled(
    visionEndpoint: CustomEndpointConfig
  ): Promise<DetectedEntity[]> {
    if (!video.videoWidth || !video.videoHeight) return [];
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = Math.round((512 * video.videoHeight) / video.videoWidth);
    const ctx = canvas.getContext('2d');
    if (!ctx) return [];
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.72);

    const base = visionEndpoint.baseUrl.trim().replace(/\/+$/, '');
    const url = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (visionEndpoint.apiKey.trim()) {
      headers.Authorization = `Bearer ${visionEndpoint.apiKey.trim()}`;
    }

    try {
      const res = await fetch('/api/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          method: 'POST',
          headers,
          data: {
            model: visionEndpoint.model || 'gpt-4o-mini',
            max_tokens: 200,
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text:
                      allowedClasses && allowedClasses.length > 0
                        ? `List up to 4 visible objects matching only these classes (${allowedClasses.slice(0, 20).join(', ')}) as comma-separated labels.`
                        : 'List up to 4 main visible objects as comma-separated labels only.',
                  },
                  { type: 'image_url', image_url: { url: dataUrl } },
                ],
              },
            ],
          },
        }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        data?: { choices?: Array<{ message?: { content?: string } }> };
      };
      const text = json.data?.choices?.[0]?.message?.content;
      if (!json.ok || !text) return [];
      return text
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 4)
        .map((label, i) => ({
          id: `vlm-${i}-${label}`,
          label,
          score: 0.9,
          bbox: [0.15 + i * 0.18, 0.25, 0.35 + i * 0.18, 0.65],
          source: 'vision-endpoint',
        }));
    } catch {
      return [];
    }
  }

  async function detectFrame(visionEndpoint?: CustomEndpointConfig): Promise<{
    entities: DetectedEntity[];
    inferenceMs: number;
  }> {
    if (allowedClasses !== null && allowedClasses.length === 0) {
      return { entities: [], inferenceMs: 0 };
    }

    if (!stream || video.readyState < 2 || !video.videoWidth) {
      return {
        entities: cachedEntities.filter((e) => matchesAllowedClasses(e.label)),
        inferenceMs: 0,
      };
    }

    const startedAt = performance.now();

    if (!detector && !modelLoadFailed) {
      await ensureModelLoaded();
    }

    if (detector && video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      const result = detector.detectForVideo(video, performance.now());
      const vw = video.videoWidth || 1;
      const vh = video.videoHeight || 1;

      cachedEntities = (result.detections || [])
        .map((det, idx): DetectedEntity | null => {
          const cat = det.categories?.[0];
          const box = det.boundingBox;
          if (!cat || !box) return null;
          if (!matchesAllowedClasses(cat.categoryName)) return null;
          const xmin = Math.max(0, Math.min(1, box.originX / vw));
          const ymin = Math.max(0, Math.min(1, box.originY / vh));
          const xmax = Math.max(0, Math.min(1, (box.originX + box.width) / vw));
          const ymax = Math.max(0, Math.min(1, (box.originY + box.height) / vh));
          return {
            id: `mp-${idx}-${cat.categoryName}`,
            label: cat.categoryName,
            score: Math.round((cat.score || 0) * 100) / 100,
            bbox: [xmin, ymin, xmax, ymax],
            source: 'mediapipe',
          };
        })
        .filter((x): x is DetectedEntity => x !== null);
    } else if (
      visionEndpoint &&
      visionEndpoint.enabled &&
      visionEndpoint.baseUrl.trim() &&
      performance.now() - lastVisionCallAt > 4000
    ) {
      lastVisionCallAt = performance.now();
      const vlmEntities = await queryVisionEndpointIfEnabled(visionEndpoint);
      if (vlmEntities.length > 0) {
        cachedEntities = vlmEntities.filter((e) => matchesAllowedClasses(e.label));
      }
    }

    const inferenceMs = Math.round((performance.now() - startedAt) * 10) / 10;
    return {
      entities: cachedEntities.filter((e) => matchesAllowedClasses(e.label)),
      inferenceMs,
    };
  }

  return {
    startCamera,
    stopCamera,
    switchCamera,
    listCameras,
    onDevicesChanged,
    getActiveCameraMeta,
    setAllowedClasses,
    detectFrame,
    getVideoElement: () => video,
    isCameraActive: () => Boolean(stream),
    getFacingMode: () => facingMode,
    dispose: () => {
      if (typeof navigator !== 'undefined' && navigator.mediaDevices?.removeEventListener) {
        navigator.mediaDevices.removeEventListener('devicechange', handleNativeDeviceChange);
      }
      deviceListeners.clear();
      stopCamera();
      detector?.close();
      detector = null;
    },
  };
}

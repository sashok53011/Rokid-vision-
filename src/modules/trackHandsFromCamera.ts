/**
 * Модуль трекинга рук по видеопотоку камеры (trackHandsFromCamera).
 *
 * Назначение:
 * Использует @mediapipe/tasks-vision (HandLandmarker, 21 ключевая точка кисти)
 * для определения положения руки, расчета расстояния щипка (Pinch между кончиками
 * большого #4 и указательного #8 пальцев), оценки уверенности (confidence scores)
 * по каждому отслеживаемому жесту (Pinch, Open Palm, Point, Fist, Victory) и выдачи
 * мировых 3D-координат (worldLandmarks) для диагностического оверлея.
 *
 * Входные параметры:
 * - video: HTMLVideoElement — активный видеопоток камеры.
 *
 * Выходные данные:
 * - CameraHandState: { detected, handedness, handednessConfidence, pinching,
 *   pinchDistance, gestureLabel, gestureConfidence, gestureScores, landmarks,
 *   worldLandmarks, inferenceMs, isSimulated? }.
 */

import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import type { CameraHandPoint, CameraHandState, HandGestureScore } from '../types';

export interface CameraHandTracker {
  trackFrame(video: HTMLVideoElement): Promise<CameraHandState>;
  getLastState(): CameraHandState;
  dispose(): void;
}

const MEDIAPIPE_WASM_CDN =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34/wasm';
const HAND_LANDMARKER_MODEL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

function clamp01(val: number): number {
  return Math.max(0, Math.min(1, val));
}

function fingerExtensionRatio(
  landmarks: CameraHandPoint[],
  tipIdx: number,
  pipIdx: number,
  mcpIdx: number
): number {
  const wrist = landmarks[0];
  const tip = landmarks[tipIdx];
  const pip = landmarks[pipIdx];
  const mcp = landmarks[mcpIdx];
  const tipDist = Math.hypot(tip.x - wrist.x, tip.y - wrist.y);
  const pipDist = Math.hypot(pip.x - wrist.x, pip.y - wrist.y);
  const mcpDist = Math.hypot(mcp.x - wrist.x, mcp.y - wrist.y);
  const scale = Math.max(0.02, mcpDist);
  return clamp01((tipDist - pipDist) / (scale * 0.85) + 0.5);
}

/**
 * Вычисляет уверенность (0..1) для каждого из 5 отслеживаемых жестов кисти.
 *
 * @param landmarks Массив 21 ключевой точки MediaPipe HandLandmarker.
 * @param pinchDistance Нормализованное расстояние между большим (#4) и указательным (#8) пальцами.
 */
export function evaluateGestureScores(
  landmarks: CameraHandPoint[],
  pinchDistance: number
): {
  gestureLabel: string;
  gestureConfidence: number;
  gestureScores: HandGestureScore[];
} {
  if (landmarks.length < 21) {
    return {
      gestureLabel: 'None',
      gestureConfidence: 0,
      gestureScores: [
        { name: 'Pinch', confidence: 0, active: false },
        { name: 'Open Palm', confidence: 0, active: false },
        { name: 'Point', confidence: 0, active: false },
        { name: 'Fist', confidence: 0, active: false },
        { name: 'Victory', confidence: 0, active: false },
      ],
    };
  }

  // Степень выпрямления пальцев (0 = согнут, 1 = полностью вытянут)
  const indexExt = fingerExtensionRatio(landmarks, 8, 6, 5);
  const middleExt = fingerExtensionRatio(landmarks, 12, 10, 9);
  const ringExt = fingerExtensionRatio(landmarks, 16, 14, 13);
  const pinkyExt = fingerExtensionRatio(landmarks, 20, 18, 17);
  const thumbPalmDist = Math.hypot(
    landmarks[4].x - landmarks[5].x,
    landmarks[4].y - landmarks[5].y
  );
  const palmSpan = Math.max(
    0.04,
    Math.hypot(landmarks[9].x - landmarks[0].x, landmarks[9].y - landmarks[0].y)
  );
  const thumbExt = clamp01(thumbPalmDist / (palmSpan * 0.9));

  const pinchConf = clamp01(1 - (pinchDistance - 0.022) / 0.085);
  const palmConf = clamp01((indexExt + middleExt + ringExt + pinkyExt + thumbExt * 0.7) / 4.7);
  const pointConf = clamp01(
    indexExt * 0.5 + ((1 - middleExt) + (1 - ringExt) + (1 - pinkyExt)) / 6
  );
  const fistConf = clamp01(
    ((1 - indexExt) + (1 - middleExt) + (1 - ringExt) + (1 - pinkyExt)) / 4 *
      (1 - pinchConf * 0.35)
  );
  const victoryConf = clamp01(
    (indexExt + middleExt) * 0.35 + ((1 - ringExt) + (1 - pinkyExt)) * 0.15
  );

  const rawScores: Array<{ name: HandGestureScore['name']; confidence: number }> = [
    { name: 'Pinch', confidence: Number(pinchConf.toFixed(3)) },
    { name: 'Open Palm', confidence: Number(palmConf.toFixed(3)) },
    { name: 'Point', confidence: Number(pointConf.toFixed(3)) },
    { name: 'Fist', confidence: Number(fistConf.toFixed(3)) },
    { name: 'Victory', confidence: Number(victoryConf.toFixed(3)) },
  ];

  // Жест с максимальным score становится активным
  let best = rawScores[0];
  for (const item of rawScores) {
    if (item.confidence > best.confidence) best = item;
  }

  const gestureScores: HandGestureScore[] = rawScores.map((s) => ({
    ...s,
    active: s.name === best.name && s.confidence >= 0.42,
  }));

  return {
    gestureLabel: best.confidence >= 0.42 ? best.name : 'Hand Active',
    gestureConfidence: best.confidence,
    gestureScores,
  };
}

/**
 * ЗАГЛУШКА ДЛЯ ОТЛАДКИ БЕЗ КАМЕРЫ:
 * Генерирует анимированный 21-точечный скелет кисти для проверки визуального
 * диагностического оверлея, костей и индикаторов уверенности на ПК без веб-камеры.
 * В продакшне перекрывается реальными данными от MediaPipe HandLandmarker.
 */
export function createSimulatedHandState(elapsedSec: number): CameraHandState {
  const phase = elapsedSec * 1.4;
  const pinchWave = (Math.sin(phase) + 1) * 0.5; // 0 = щипок, 1 = открытая ладонь
  const cx = 0.5 + Math.cos(phase * 0.5) * 0.06;
  const cy = 0.72 + Math.sin(phase * 0.7) * 0.03;

  const wrist: CameraHandPoint = { x: cx, y: cy, z: 0 };
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

  const landmarks: CameraHandPoint[] = [
    wrist,
    // Большой палец (1..4)
    { x: cx - 0.07, y: cy - 0.05, z: -0.01 },
    { x: cx - 0.11, y: cy - 0.12, z: -0.02 },
    { x: cx - 0.09, y: cy - 0.19, z: -0.03 },
    {
      x: lerp(cx - 0.028, cx - 0.14, pinchWave),
      y: lerp(cy - 0.30, cy - 0.25, pinchWave),
      z: -0.045,
    },
    // Указательный палец (5..8)
    { x: cx - 0.045, y: cy - 0.17, z: -0.01 },
    { x: cx - 0.045, y: cy - 0.24, z: -0.02 },
    { x: cx - 0.038, y: cy - 0.29, z: -0.03 },
    {
      x: lerp(cx - 0.022, cx - 0.042, pinchWave),
      y: lerp(cy - 0.305, cy - 0.37, pinchWave),
      z: -0.04,
    },
    // Средний палец (9..12)
    { x: cx - 0.005, y: cy - 0.18, z: 0 },
    { x: cx - 0.005, y: cy - 0.27, z: -0.01 },
    { x: cx - 0.005, y: cy - 0.34, z: -0.015 },
    { x: cx - 0.005, y: cy - 0.40, z: -0.02 },
    // Безымянный палец (13..16)
    { x: cx + 0.035, y: cy - 0.17, z: 0.01 },
    { x: cx + 0.04, y: cy - 0.25, z: 0.005 },
    { x: cx + 0.044, y: cy - 0.31, z: 0 },
    { x: cx + 0.048, y: cy - 0.365, z: -0.005 },
    // Мизинец (17..20)
    { x: cx + 0.072, y: cy - 0.15, z: 0.02 },
    { x: cx + 0.082, y: cy - 0.21, z: 0.02 },
    { x: cx + 0.09, y: cy - 0.26, z: 0.018 },
    { x: cx + 0.096, y: cy - 0.305, z: 0.015 },
  ];

  const pinchDistance = Math.hypot(
    landmarks[4].x - landmarks[8].x,
    landmarks[4].y - landmarks[8].y
  );
  const pinching = pinchDistance < 0.055;
  const evalRes = evaluateGestureScores(landmarks, pinchDistance);

  return {
    detected: true,
    handedness: 'Right',
    handednessConfidence: 0.98,
    pinching,
    pinchDistance: Math.round(pinchDistance * 1000) / 1000,
    gestureLabel: evalRes.gestureLabel,
    gestureConfidence: evalRes.gestureConfidence,
    gestureScores: evalRes.gestureScores,
    landmarks,
    worldLandmarks: landmarks.map((p) => ({
      x: (p.x - 0.5) * 0.22,
      y: (0.72 - p.y) * 0.22,
      z: p.z,
    })),
    inferenceMs: 4.2,
    isSimulated: true,
  };
}

export function createCameraHandTracker(): CameraHandTracker {
  let landmarker: HandLandmarker | null = null;
  let loadPromise: Promise<void> | null = null;
  let loadFailed = false;
  let lastVideoTime = -1;
  let cachedState: CameraHandState = {
    detected: false,
    handedness: 'Unknown',
    handednessConfidence: 0,
    pinching: false,
    pinchDistance: 1,
    gestureLabel: 'None',
    gestureConfidence: 0,
    gestureScores: evaluateGestureScores([], 1).gestureScores,
    landmarks: [],
    worldLandmarks: [],
    inferenceMs: 0,
  };

  async function ensureLoaded(): Promise<void> {
    if (landmarker || loadFailed) return;
    if (loadPromise) return loadPromise;

    loadPromise = (async () => {
      try {
        const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_CDN);
        landmarker = await HandLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: HAND_LANDMARKER_MODEL,
            delegate: 'GPU',
          },
          numHands: 1,
          runningMode: 'VIDEO',
          minHandDetectionConfidence: 0.5,
          minHandPresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });
      } catch (err) {
        console.warn('[HandLandmarker] Ошибка загрузки модели MediaPipe:', err);
        loadFailed = true;
      }
    })();

    return loadPromise;
  }

  async function trackFrame(video: HTMLVideoElement): Promise<CameraHandState> {
    if (!video || video.readyState < 2 || !video.videoWidth) {
      return cachedState;
    }
    if (!landmarker && !loadFailed) {
      void ensureLoaded();
      return cachedState;
    }
    if (!landmarker || video.currentTime === lastVideoTime) {
      return cachedState;
    }

    lastVideoTime = video.currentTime;
    const t0 = performance.now();
    const res = landmarker.detectForVideo(video, t0);
    const inferenceMs = Math.round((performance.now() - t0) * 10) / 10;

    if (!res.landmarks || res.landmarks.length === 0) {
      cachedState = {
        detected: false,
        handedness: 'Unknown',
        handednessConfidence: 0,
        pinching: false,
        pinchDistance: 1,
        gestureLabel: 'None',
        gestureConfidence: 0,
        gestureScores: evaluateGestureScores([], 1).gestureScores,
        landmarks: [],
        worldLandmarks: [],
        inferenceMs,
      };
      return cachedState;
    }

    const pts: CameraHandPoint[] = res.landmarks[0].map((p) => ({
      x: p.x,
      y: p.y,
      z: p.z,
    }));
    const worldPts: CameraHandPoint[] =
      res.worldLandmarks?.[0]?.map((p) => ({
        x: p.x,
        y: p.y,
        z: p.z,
      })) ?? [];

    const thumb = pts[4];
    const index = pts[8];
    const pinchDistance = Math.hypot(thumb.x - index.x, thumb.y - index.y);
    const pinching = pinchDistance < 0.055;
    const rawHand = res.handedness?.[0]?.[0]?.categoryName;
    const handednessConfidence = Number(
      (res.handedness?.[0]?.[0]?.score ?? 0.92).toFixed(3)
    );
    const handedness =
      rawHand === 'Left' || rawHand === 'Right' ? rawHand : 'Unknown';

    const evalRes = evaluateGestureScores(pts, pinchDistance);

    cachedState = {
      detected: true,
      handedness,
      handednessConfidence,
      pinching,
      pinchDistance: Math.round(pinchDistance * 1000) / 1000,
      gestureLabel: evalRes.gestureLabel,
      gestureConfidence: evalRes.gestureConfidence,
      gestureScores: evalRes.gestureScores,
      landmarks: pts,
      worldLandmarks: worldPts,
      inferenceMs,
      isSimulated: false,
    };

    return cachedState;
  }

  return {
    trackFrame,
    getLastState: () => cachedState,
    dispose: () => {
      landmarker?.close();
      landmarker = null;
    },
  };
}

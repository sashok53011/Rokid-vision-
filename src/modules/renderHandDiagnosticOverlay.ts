/**
 * Модуль визуального диагностического оверлея трекинга рук (renderHandDiagnosticOverlay).
 *
 * Назначение:
 * 1. Экспортирует каноническую топологию костей MediaPipe 21-point Hand (`HAND_SKELETON_CONNECTIONS`)
 *    и переиспользуемую функцию `drawHandSkeletonOnCanvas` для отрисовки скелетных связей,
 *    номеров точек (#0–20), вектора щипка и рамки с показателем уверенности на любом `<canvas>`.
 * 2. Создает плавающий диагностический HUD-оверлей (`#hand-diag-overlay`) с:
 *    - отдельным диагностическим окном 21-точечного скелета кисти;
 *    - шкалами уверенности (Confidence Scores 0–100%) в реальном времени по всем 5 жестам;
 *    - телеметрией стороны кисти, зазора щипка, количества точек и задержки инференса;
 *    - переключателем тестовой заглушки скелета (если физическая камера неактивна).
 *
 * Входные параметры:
 * - HandDiagnosticOverlayOptions: { translator, getSettings, updateSettings, onCollapseChange? }
 * - update(hand: CameraHandState, mirror: boolean): обновление оверлея на каждом цикле телеметрии.
 *
 * Выходные данные:
 * - HandDiagnosticOverlayController: { update, isSimulating, setVisible, dispose }.
 */

import type { InterfaceTranslator } from './localizeInterface';
import { createSimulatedHandState } from './trackHandsFromCamera';
import type { AppSettingsState, CameraHandState } from '../types';

export interface HandBoneConnection {
  from: number;
  to: number;
  group: 'palm' | 'thumb' | 'index' | 'middle' | 'ring' | 'pinky';
  color: string;
}

/** Топология 21 ключевой точки кисти по стандарту MediaPipe HandLandmarker */
export const HAND_SKELETON_CONNECTIONS: HandBoneConnection[] = [
  // Запястье и пястный каркас ладони
  { from: 0, to: 1, group: 'palm', color: '#94a3b8' },
  { from: 0, to: 5, group: 'palm', color: '#94a3b8' },
  { from: 0, to: 9, group: 'palm', color: '#94a3b8' },
  { from: 0, to: 13, group: 'palm', color: '#94a3b8' },
  { from: 0, to: 17, group: 'palm', color: '#94a3b8' },
  { from: 5, to: 9, group: 'palm', color: '#64748b' },
  { from: 9, to: 13, group: 'palm', color: '#64748b' },
  { from: 13, to: 17, group: 'palm', color: '#64748b' },
  // Большой палец (1-2-3-4)
  { from: 1, to: 2, group: 'thumb', color: '#22d3ee' },
  { from: 2, to: 3, group: 'thumb', color: '#22d3ee' },
  { from: 3, to: 4, group: 'thumb', color: '#22d3ee' },
  // Указательный палец (5-6-7-8)
  { from: 5, to: 6, group: 'index', color: '#38bdf8' },
  { from: 6, to: 7, group: 'index', color: '#38bdf8' },
  { from: 7, to: 8, group: 'index', color: '#38bdf8' },
  // Средний палец (9-10-11-12)
  { from: 9, to: 10, group: 'middle', color: '#818cf8' },
  { from: 10, to: 11, group: 'middle', color: '#818cf8' },
  { from: 11, to: 12, group: 'middle', color: '#818cf8' },
  // Безымянный палец (13-14-15-16)
  { from: 13, to: 14, group: 'ring', color: '#c084fc' },
  { from: 14, to: 15, group: 'ring', color: '#c084fc' },
  { from: 15, to: 16, group: 'ring', color: '#c084fc' },
  // Мизинец (17-18-19-20)
  { from: 17, to: 18, group: 'pinky', color: '#f472b6' },
  { from: 18, to: 19, group: 'pinky', color: '#f472b6' },
  { from: 19, to: 20, group: 'pinky', color: '#f472b6' },
];

const FINGERTIP_INDICES = new Set([4, 8, 12, 16, 20]);

export interface DrawSkeletonOptions {
  mirror?: boolean;
  showIndices?: boolean;
  showBoundingBox?: boolean;
  showGrid?: boolean;
}

/**
 * Отрисовывает полный 21-точечный скелет руки, вектор щипка и бейдж уверенности на `<canvas>`.
 */
export function drawHandSkeletonOnCanvas(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  hand: CameraHandState,
  options: DrawSkeletonOptions = {}
): void {
  const {
    mirror = false,
    showIndices = true,
    showBoundingBox = true,
    showGrid = false,
  } = options;

  if (showGrid) {
    ctx.save();
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.1)';
    ctx.lineWidth = 1;
    const step = 28;
    for (let x = step; x < width; x += step) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    for (let y = step; y < height; y += step) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  if (!hand.detected || hand.landmarks.length < 21) return;

  const toPx = (pt: { x: number; y: number }) => ({
    x: (mirror ? 1 - pt.x : pt.x) * width,
    y: pt.y * height,
  });

  const pts = hand.landmarks.map(toPx);

  // 1. Габаритная рамка руки + бейдж жеста и уверенности
  if (showBoundingBox) {
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    const pad = 12;
    const bx = Math.max(4, minX - pad);
    const by = Math.max(20, minY - pad);
    const bw = Math.min(width - bx - 4, maxX - minX + pad * 2);
    const bh = Math.min(height - by - 4, maxY - minY + pad * 2);

    ctx.save();
    ctx.strokeStyle = hand.pinching
      ? 'rgba(34, 197, 94, 0.78)'
      : 'rgba(56, 189, 248, 0.65)';
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.4;
    ctx.strokeRect(bx, by, bw, bh);
    ctx.setLineDash([]);

    const confPct = Math.round(hand.gestureConfidence * 100);
    const handPct = Math.round(hand.handednessConfidence * 100);
    const badgeText = `${hand.handedness} (${handPct}%) • ${hand.gestureLabel} ${confPct}%`;
    ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
    const textW = ctx.measureText(badgeText).width + 10;
    ctx.fillStyle = 'rgba(2, 6, 23, 0.88)';
    ctx.fillRect(bx, Math.max(2, by - 18), textW, 17);
    ctx.fillStyle = hand.pinching ? '#4ade80' : '#7dd3fc';
    ctx.fillText(badgeText, bx + 5, Math.max(14, by - 6));
    ctx.restore();
  }

  // 2. Кости скелета (соединения 0..20)
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const conn of HAND_SKELETON_CONNECTIONS) {
    const a = pts[conn.from];
    const b = pts[conn.to];
    if (!a || !b) continue;
    ctx.strokeStyle = conn.color;
    ctx.lineWidth = conn.group === 'palm' ? 2 : 2.6;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  // 3. Вектор щипка между большим (#4) и указательным (#8) пальцами
  const thumbTip = pts[4];
  const indexTip = pts[8];
  if (thumbTip && indexTip) {
    ctx.strokeStyle = hand.pinching ? '#22c55e' : '#facc15';
    ctx.lineWidth = hand.pinching ? 2.8 : 1.6;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(thumbTip.x, thumbTip.y);
    ctx.lineTo(indexTip.x, indexTip.y);
    ctx.stroke();
    ctx.setLineDash([]);

    const midX = (thumbTip.x + indexTip.x) * 0.5;
    const midY = (thumbTip.y + indexTip.y) * 0.5;
    ctx.font = '600 10px ui-monospace, Menlo, monospace';
    ctx.fillStyle = hand.pinching ? '#4ade80' : '#fde047';
    ctx.fillText(hand.pinchDistance.toFixed(3), midX + 5, midY - 4);
  }

  // 4. Суставы, кончики пальцев и номера точек #0..20
  for (let i = 0; i < pts.length; i++) {
    const pt = pts[i];
    const isTip = FINGERTIP_INDICES.has(i);
    const isWrist = i === 0;
    const radius = isWrist ? 5 : isTip ? 4.8 : 3.2;

    if (isTip) {
      ctx.fillStyle = hand.pinching && (i === 4 || i === 8)
        ? 'rgba(34, 197, 94, 0.35)'
        : 'rgba(56, 189, 248, 0.25)';
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, radius + 4, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle =
      hand.pinching && (i === 4 || i === 8)
        ? '#22c55e'
        : isTip
          ? '#e0f2fe'
          : isWrist
            ? '#f97316'
            : '#facc15';
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, radius, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = '#020617';
    ctx.lineWidth = 1;
    ctx.stroke();

    if (showIndices) {
      ctx.font = '600 9px ui-monospace, Menlo, monospace';
      ctx.fillStyle = '#e2e8f0';
      ctx.fillText(String(i), pt.x + 5, pt.y - 3);
    }
  }
  ctx.restore();
}

export interface HandDiagnosticOverlayOptions {
  translator: InterfaceTranslator;
  getSettings: () => AppSettingsState;
  updateSettings: (patch: Partial<AppSettingsState>) => void;
}

export interface HandDiagnosticOverlayController {
  update(hand: CameraHandState, mirror: boolean): void;
  isSimulating(): boolean;
  refreshLocalization(): void;
  dispose(): void;
}

/**
 * Создает плавающий диагностический оверлей трекинга рук (`#hand-diag-overlay`).
 */
export function createHandDiagnosticOverlay(
  opts: HandDiagnosticOverlayOptions
): HandDiagnosticOverlayController {
  const { translator, getSettings, updateSettings } = opts;

  let simulateStubActive = false;
  let collapsed = false;
  let lastMirrored = false;
  let simRafId: number | null = null;
  let lastHand: CameraHandState = {
    detected: false,
    handedness: 'Unknown',
    handednessConfidence: 0,
    pinching: false,
    pinchDistance: 1,
    gestureLabel: 'None',
    gestureConfidence: 0,
    gestureScores: [
      { name: 'Pinch', confidence: 0, active: false },
      { name: 'Open Palm', confidence: 0, active: false },
      { name: 'Point', confidence: 0, active: false },
      { name: 'Fist', confidence: 0, active: false },
      { name: 'Victory', confidence: 0, active: false },
    ],
    landmarks: [],
    worldLandmarks: [],
    inferenceMs: 0,
  };

  const root = document.createElement('div');
  root.id = 'hand-diag-overlay';
  root.className = 'hand-diag-overlay';
  document.body.appendChild(root);

  // Шапка оверлея
  const header = document.createElement('div');
  header.className = 'hand-diag-header';

  const titleEl = document.createElement('span');
  titleEl.className = 'hand-diag-title';

  const badgeEl = document.createElement('span');
  badgeEl.className = 'hud-badge';
  badgeEl.textContent = 'IDLE';

  const collapseBtn = document.createElement('button');
  collapseBtn.type = 'button';
  collapseBtn.className = 'hand-diag-mini-btn';
  collapseBtn.textContent = '–';
  collapseBtn.onclick = () => {
    collapsed = !collapsed;
    collapseBtn.textContent = collapsed ? '+' : '–';
    body.style.display = collapsed ? 'none' : 'flex';
  };

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'hand-diag-mini-btn';
  closeBtn.textContent = '×';
  closeBtn.onclick = () => {
    updateSettings({ handDiagnosticOverlayEnabled: false });
    renderState(lastHand, lastMirrored);
  };

  const headerRight = document.createElement('div');
  headerRight.className = 'hand-diag-header-actions';
  headerRight.append(badgeEl, collapseBtn, closeBtn);
  header.append(titleEl, headerRight);
  root.appendChild(header);

  const body = document.createElement('div');
  body.className = 'hand-diag-body';
  root.appendChild(body);

  // Канвас 21-точечного скелета
  const canvasLabel = document.createElement('div');
  canvasLabel.className = 'hand-diag-section-lbl';

  const canvas = document.createElement('canvas');
  canvas.className = 'hand-diag-canvas';
  canvas.width = 276;
  canvas.height = 172;
  body.append(canvasLabel, canvas);

  // Сетка метрик (Handedness, Pinch Gap, Landmarks, Inference)
  const metricsGrid = document.createElement('div');
  metricsGrid.className = 'hand-diag-metrics';
  metricsGrid.innerHTML = `
    <div class="hand-diag-metric"><span data-k="hand"></span><strong id="hd-val-hand">—</strong></div>
    <div class="hand-diag-metric"><span data-k="pinch"></span><strong id="hd-val-pinch">—</strong></div>
    <div class="hand-diag-metric"><span data-k="pts"></span><strong id="hd-val-pts">0/21</strong></div>
    <div class="hand-diag-metric"><span data-k="lat"></span><strong id="hd-val-lat">0 ms</strong></div>
  `;
  body.appendChild(metricsGrid);

  // Шкалы уверенности по всем жестам (0–100%)
  const scoresTitle = document.createElement('div');
  scoresTitle.className = 'hand-diag-section-lbl';
  body.appendChild(scoresTitle);

  const scoresBox = document.createElement('div');
  scoresBox.className = 'hand-diag-scores';
  body.appendChild(scoresBox);

  // Панель быстрых диагностических кнопок
  const actionsRow = document.createElement('div');
  actionsRow.className = 'hand-diag-actions';

  const indicesBtn = document.createElement('button');
  indicesBtn.type = 'button';
  indicesBtn.className = 'hud-btn hand-diag-action-btn';
  indicesBtn.onclick = () => {
    const s = getSettings();
    updateSettings({ handShowLandmarkIndices: !s.handShowLandmarkIndices });
    renderState(lastHand, lastMirrored);
  };

  const simBtn = document.createElement('button');
  simBtn.type = 'button';
  simBtn.className = 'hud-btn hand-diag-action-btn';
  simBtn.onclick = () => {
    simulateStubActive = !simulateStubActive;
    refreshLocalization();
    if (simulateStubActive) {
      startSimLoop();
    } else {
      stopSimLoop();
      renderState(lastHand, lastMirrored);
    }
  };

  actionsRow.append(indicesBtn, simBtn);
  body.appendChild(actionsRow);

  function startSimLoop(): void {
    if (simRafId !== null) return;
    const tick = () => {
      if (!simulateStubActive) {
        simRafId = null;
        return;
      }
      // Если реальная камера уже видит руку — отображаем реальную, иначе тестовую заглушку
      if (!lastHand.detected || lastHand.isSimulated) {
        const simHand = createSimulatedHandState(performance.now() / 1000);
        renderState(simHand, false);
      }
      simRafId = window.setTimeout(tick, 50);
    };
    tick();
  }

  function stopSimLoop(): void {
    if (simRafId !== null) {
      clearTimeout(simRafId);
      simRafId = null;
    }
  }

  function refreshLocalization(): void {
    const t = translator.t;
    titleEl.textContent = t('handDiag.title');
    canvasLabel.textContent = t('handDiag.skeletonCanvas');
    scoresTitle.textContent = t('handDiag.gestureConfidence');

    const mapLabels: Record<string, string> = {
      hand: t('handDiag.handedness'),
      pinch: t('handDiag.pinchGap'),
      pts: t('handDiag.landmarks'),
      lat: t('handDiag.latency'),
    };
    metricsGrid.querySelectorAll<HTMLElement>('[data-k]').forEach((el) => {
      const k = el.getAttribute('data-k');
      if (k && mapLabels[k]) el.textContent = mapLabels[k];
    });

    const settings = getSettings();
    indicesBtn.textContent = t('handDiag.showIndices');
    indicesBtn.className = `hud-btn hand-diag-action-btn ${settings.handShowLandmarkIndices ? 'hud-btn-primary' : ''}`;

    simBtn.textContent = simulateStubActive
      ? t('handDiag.simulateOff')
      : t('handDiag.simulateOn');
    simBtn.className = `hud-btn hand-diag-action-btn ${simulateStubActive ? 'hud-btn-primary' : ''}`;
  }

  function renderState(hand: CameraHandState, mirror: boolean): void {
    const settings = getSettings();
    root.style.display = settings.handDiagnosticOverlayEnabled ? 'flex' : 'none';
    if (!settings.handDiagnosticOverlayEnabled) return;

    const t = translator.t;
    if (hand.detected) {
      badgeEl.textContent = hand.isSimulated
        ? t('handDiag.simulatedBadge')
        : t('handDiag.liveBadge');
      badgeEl.className = `hud-badge ${hand.isSimulated ? '' : 'is-ok'}`;
    } else {
      badgeEl.textContent = 'IDLE';
      badgeEl.className = 'hud-badge';
    }

    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#030816';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      drawHandSkeletonOnCanvas(ctx, canvas.width, canvas.height, hand, {
        mirror,
        showIndices: settings.handShowLandmarkIndices,
        showBoundingBox: true,
        showGrid: true,
      });
      if (!hand.detected) {
        ctx.fillStyle = '#64748b';
        ctx.font = '11px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(t('handDiag.noHand'), canvas.width / 2, canvas.height / 2, canvas.width - 20);
        ctx.textAlign = 'left';
      }
    }

    const handEl = metricsGrid.querySelector('#hd-val-hand');
    const pinchEl = metricsGrid.querySelector('#hd-val-pinch');
    const ptsEl = metricsGrid.querySelector('#hd-val-pts');
    const latEl = metricsGrid.querySelector('#hd-val-lat');

    if (handEl) {
      handEl.textContent = hand.detected
        ? `${hand.handedness} (${Math.round(hand.handednessConfidence * 100)}%)`
        : '—';
    }
    if (pinchEl) {
      pinchEl.textContent = hand.detected
        ? `${hand.pinchDistance.toFixed(3)} ${hand.pinching ? '• PINCH' : ''}`
        : '—';
    }
    if (ptsEl) {
      ptsEl.textContent = `${hand.landmarks.length}/21`;
    }
    if (latEl) {
      latEl.textContent = `${hand.inferenceMs.toFixed(1)} ms`;
    }

    scoresBox.innerHTML = '';
    for (const score of hand.gestureScores) {
      const pct = Math.round(score.confidence * 100);
      const row = document.createElement('div');
      row.className = `hand-diag-score-row ${score.active ? 'is-active' : ''}`;
      row.innerHTML = `
        <div class="hand-diag-score-meta">
          <span>${score.name}</span>
          <strong>${pct}%</strong>
        </div>
        <div class="hand-diag-bar-track">
          <div class="hand-diag-bar-fill" style="width:${pct}%"></div>
        </div>
      `;
      scoresBox.appendChild(row);
    }

    indicesBtn.className = `hud-btn hand-diag-action-btn ${settings.handShowLandmarkIndices ? 'hud-btn-primary' : ''}`;
  }

  refreshLocalization();
  renderState(lastHand, false);

  return {
    update(hand: CameraHandState, mirror: boolean): void {
      lastHand = hand;
      lastMirrored = mirror;
      if (hand.detected) {
        renderState(hand, mirror);
      } else if (simulateStubActive) {
        renderState(createSimulatedHandState(performance.now() / 1000), false);
      } else {
        renderState(hand, mirror);
      }
    },
    isSimulating: () => simulateStubActive,
    refreshLocalization,
    dispose(): void {
      stopSimLoop();
      root.remove();
    },
  };
}

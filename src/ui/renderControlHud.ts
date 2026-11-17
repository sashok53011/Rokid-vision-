/**
 * Модуль 2D-панели управления и настроек (renderControlHud).
 *
 * Назначение:
 * Строит сворачиваемую нижнюю/боковую панель управления поверх WebXR/Three.js-канваса
 * с полной локализацией на EN / RU / DE и доступом ко всем подсистемам:
 * 1. Зрение и ML (поток камеры Android с рамками детекции и скелетом руки, жесты головы);
 * 2. Устройства (Rokid Max 1st Gen HID, режимы Auto / Monoscopic / SBS / 360°, IPD, BT/Wi-Fi, Cloud Render, навигация);
 * 3. Прямая связь TTS/STT (выбор комнаты, участника any-to-any, микрофон STT, мгновенный перевод, авто-TTS);
 * 4. Диагностика (FPS, Draw Calls, треугольники, память, задержки ML/IMU, батарея и термобюджет);
 * 5. Эндпоинты (добавление, редактирование, удаление по одному/всех, тест соединения, загрузка списка моделей);
 * 6. Настройки (языки интерфейса EN/RU/DE, языки перевода по умолчанию, фильтр IMU).
 */

import { ENDPOINT_CATEGORIES, TRANSLATION_LANGUAGES } from '../constants';
import type {
  AppLanguage,
  AppSettingsState,
  AttenuationModelType,
  CameraHandState,
  CustomEndpointConfig,
  DetectedEntity,
  EndpointCategory,
  HeadGestureAction,
  HeadsetProfile,
  ImuTelemetry,
  NavigationTabId,
  PerformanceDiagnostics,
  ResolvedViewingMode,
  SessionPeer,
  SpatialPlaceId,
  TranslatedSpeechMessage,
  TranslationLanguageCode,
  ViewingMode,
  WebcamDeviceInfo,
  WebcamResolutionPreset,
  WirelessDeviceEntry,
} from '../types';
import type { InterfaceTranslator } from '../modules/localizeInterface';
import type { EndpointManager } from '../modules/manageCustomEndpoints';
import type { CameraObjectDetectionController } from '../modules/detectObjectsFromCamera';
import type { WirelessDeviceHub } from '../modules/connectBluetoothAndWifiDevices';
import type { PeerCommsController } from '../modules/communicatePeerTtsStt';
import type { RemoteNavCommand } from '../modules/navigateRemotely';
import type { SpatialAudioBalancer } from '../modules/balanceSpatialAudio';
import type { DetectionClassManager } from '../modules/manageDetectionClasses';
import type { BluetoothGyroController } from '../modules/connectBluetoothGyroController';
import type { SpatialPlacesController } from '../modules/build3dPlacesAndControlPanels';
import {
  createHandDiagnosticOverlay,
  drawHandSkeletonOnCanvas,
} from '../modules/renderHandDiagnosticOverlay';

export interface HudDependencies {
  translator: InterfaceTranslator;
  endpoints: EndpointManager;
  cameraDetector: CameraObjectDetectionController;
  wirelessHub: WirelessDeviceHub;
  peerComms: PeerCommsController;
  audioBalancer: SpatialAudioBalancer;
  detectionManager: DetectionClassManager;
  btGyroController: BluetoothGyroController;
  placesManager: SpatialPlacesController;
  getSettings: () => AppSettingsState;
  updateSettings: (patch: Partial<AppSettingsState>) => void;
  onConnectRokidHid: () => Promise<{ ok: boolean; deviceName: string; message: string }>;
  onNavigate: (cmd: RemoteNavCommand) => void;
  onXrScan: () => void;
}

export interface HudController {
  updateLiveTelemetry(payload: {
    imu: ImuTelemetry;
    headset: HeadsetProfile;
    activeMode: ResolvedViewingMode;
    diagnostics: PerformanceDiagnostics;
    detections: DetectedEntity[];
    hand: CameraHandState;
  }): void;
  handleHeadGesture(action: HeadGestureAction): void;
  setWsConnected(connected: boolean): void;
  refreshComms(): void;
  refreshPlaceControls(): void;
  dispose(): void;
}

const TAB_ORDER: NavigationTabId[] = [
  'vision',
  'devices',
  'comms',
  'diagnostics',
  'endpoints',
  'settings',
];

export function mountControlHud(deps: HudDependencies): HudController {
  const {
    translator,
    endpoints,
    cameraDetector,
    wirelessHub,
    peerComms,
    audioBalancer,
    detectionManager,
    btGyroController,
    placesManager,
  } = deps;

  let collapsed = false;
  let activeTab: NavigationTabId = 'vision';
  let editingEndpoint: CustomEndpointConfig | null = null;
  let targetPeerId: 'all' | string = 'all';
  let isMicActive = false;
  let latestHeadGestureText = '—';
  let rokidStatusMessage = '';
  let wsConnected = false;
  let detectionSearchQuery = '';
  let availableWebcams: WebcamDeviceInfo[] = [];

  const refreshWebcamList = async () => {
    availableWebcams = await cameraDetector.listCameras();
    if (!collapsed && activeTab === 'vision') {
      renderFull();
    }
  };
  void refreshWebcamList();
  const unsubWebcams = cameraDetector.onDevicesChanged((cams) => {
    availableWebcams = cams;
    if (!collapsed && activeTab === 'vision') {
      renderFull();
    }
  });

  const root = document.createElement('div');
  root.id = 'xr-control-hud';
  document.body.appendChild(root);

  // Постоянный элемент <video> и <canvas> для плавного предпросмотра камеры и ML-оверлея
  const previewVideo = cameraDetector.getVideoElement();
  previewVideo.className = 'hud-camera-video';
  const overlayCanvas = document.createElement('canvas');
  overlayCanvas.className = 'hud-camera-canvas';
  overlayCanvas.width = 480;
  overlayCanvas.height = 270;

  const container = document.createElement('div');
  container.className = 'hud-dock';
  root.appendChild(container);

  // Плавающий диагностический оверлей трекинга руки (21 точка + уверенность жестов)
  const handOverlay = createHandDiagnosticOverlay({
    translator,
    getSettings: deps.getSettings,
    updateSettings: deps.updateSettings,
  });

  function renderFull(): void {
    const t = translator.t;
    const settings = deps.getSettings();
    const lang = translator.getLanguage();

    container.className = collapsed ? 'hud-dock hud-dock--collapsed' : 'hud-dock';

    container.innerHTML = '';

    // Верхняя строка: логотип, переключатель языка EN/RU/DE, кнопка свернуть/развернуть
    const topBar = document.createElement('div');
    topBar.className = 'hud-topbar';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'hud-title-wrap';
    titleWrap.innerHTML = `
      <span class="hud-brand">${t('app.title')}</span>
      <span class="hud-sub" id="hud-top-badge"></span>
    `;

    const topActions = document.createElement('div');
    topActions.className = 'hud-top-actions';

    (['en', 'ru', 'de'] as AppLanguage[]).forEach((code) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `hud-lang-btn ${lang === code ? 'is-active' : ''}`;
      btn.textContent = code.toUpperCase();
      btn.onclick = () => deps.updateSettings({ uiLanguage: code });
      topActions.appendChild(btn);
    });

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'hud-collapse-btn';
    toggleBtn.textContent = collapsed ? `▲ ${t('hud.expand')}` : `▼ ${t('hud.collapse')}`;
    toggleBtn.onclick = () => {
      collapsed = !collapsed;
      renderFull();
    };
    topActions.appendChild(toggleBtn);

    topBar.appendChild(titleWrap);
    topBar.appendChild(topActions);
    container.appendChild(topBar);

    if (collapsed) return;

    // Вкладки навигации
    const tabsBar = document.createElement('div');
    tabsBar.className = 'hud-tabs';
    TAB_ORDER.forEach((tabId) => {
      const tabBtn = document.createElement('button');
      tabBtn.type = 'button';
      tabBtn.className = `hud-tab-btn ${activeTab === tabId ? 'is-active' : ''}`;
      tabBtn.textContent = t(`nav.${tabId}`);
      tabBtn.onclick = () => {
        activeTab = tabId;
        renderFull();
      };
      tabsBar.appendChild(tabBtn);
    });
    container.appendChild(tabsBar);

    // Тело активной вкладки
    const body = document.createElement('div');
    body.className = 'hud-body';
    container.appendChild(body);

    if (activeTab === 'vision') renderVisionTab(body, settings);
    else if (activeTab === 'devices') renderDevicesTab(body, settings);
    else if (activeTab === 'comms') renderCommsTab(body, settings);
    else if (activeTab === 'diagnostics') renderDiagnosticsTab(body, settings);
    else if (activeTab === 'endpoints') renderEndpointsTab(body);
    else if (activeTab === 'settings') renderSettingsTab(body, settings);
  }

  function renderVisionTab(parent: HTMLElement, settings: AppSettingsState): void {
    const t = translator.t;
    const grid = document.createElement('div');
    grid.className = 'hud-grid-2';

    const camCard = document.createElement('div');
    camCard.className = 'hud-card';
    const camTitle = document.createElement('div');
    camTitle.className = 'hud-card-title';
    camTitle.textContent = t('vision.cameraFeed');
    camCard.appendChild(camTitle);

    // Выбор веб-камеры, разрешения и кнопка обновления списка
    const webcamControls = document.createElement('div');
    webcamControls.className = 'hud-row hud-row-wrap';

    const camSelect = document.createElement('select');
    camSelect.className = 'hud-select';
    const defOpt = document.createElement('option');
    defOpt.value = '';
    defOpt.textContent = t('vision.webcamDefault');
    camSelect.appendChild(defOpt);
    availableWebcams.forEach((cam) => {
      const opt = document.createElement('option');
      opt.value = cam.deviceId;
      opt.textContent = cam.label;
      camSelect.appendChild(opt);
    });
    camSelect.value = settings.webcamDeviceId;
    camSelect.onchange = async () => {
      const nextId = camSelect.value;
      deps.updateSettings({ webcamDeviceId: nextId });
      if (cameraDetector.isCameraActive()) {
        await cameraDetector.startCamera({
          deviceId: nextId,
          resolution: deps.getSettings().webcamResolution,
        });
        renderFull();
      }
    };

    const resSelect = document.createElement('select');
    resSelect.className = 'hud-select hud-select-sm';
    (['480p', '720p', '1080p'] as WebcamResolutionPreset[]).forEach((res) => {
      const opt = document.createElement('option');
      opt.value = res;
      opt.textContent = res.toUpperCase();
      resSelect.appendChild(opt);
    });
    resSelect.value = settings.webcamResolution;
    resSelect.onchange = async () => {
      const nextRes = resSelect.value as WebcamResolutionPreset;
      deps.updateSettings({ webcamResolution: nextRes });
      if (cameraDetector.isCameraActive()) {
        await cameraDetector.startCamera({
          deviceId: deps.getSettings().webcamDeviceId,
          resolution: nextRes,
        });
        renderFull();
      }
    };

    const refreshCamBtn = document.createElement('button');
    refreshCamBtn.type = 'button';
    refreshCamBtn.className = 'hud-btn';
    refreshCamBtn.textContent = `↻ ${t('vision.refreshCameras')}`;
    refreshCamBtn.onclick = () => void refreshWebcamList();

    webcamControls.append(camSelect, resSelect, refreshCamBtn);
    camCard.appendChild(webcamControls);

    previewVideo.className = settings.webcamMirror
      ? 'hud-camera-video is-mirrored'
      : 'hud-camera-video';

    const videoBox = document.createElement('div');
    videoBox.className = 'hud-video-box';
    videoBox.appendChild(previewVideo);
    videoBox.appendChild(overlayCanvas);
    camCard.appendChild(videoBox);

    const camMetaLine = document.createElement('div');
    camMetaLine.className = 'hud-muted';
    const meta = cameraDetector.getActiveCameraMeta();
    camMetaLine.textContent = meta
      ? `${meta.label} • ${meta.width}×${meta.height}${meta.frameRate ? ` • ${meta.frameRate} FPS` : ''}`
      : t('vision.webcamStandby');
    camCard.appendChild(camMetaLine);

    const camBtns = document.createElement('div');
    camBtns.className = 'hud-row hud-row-wrap';

    const btnStartStop = document.createElement('button');
    btnStartStop.type = 'button';
    btnStartStop.className = 'hud-btn hud-btn-primary';
    btnStartStop.textContent = cameraDetector.isCameraActive()
      ? t('vision.stopCamera')
      : t('vision.startCamera');
    btnStartStop.onclick = async () => {
      if (cameraDetector.isCameraActive()) {
        cameraDetector.stopCamera();
      } else {
        const s = deps.getSettings();
        await cameraDetector.startCamera({
          facingMode: 'environment',
          deviceId: s.webcamDeviceId,
          resolution: s.webcamResolution,
        });
        availableWebcams = await cameraDetector.listCameras();
      }
      renderFull();
    };

    const btnSwitch = document.createElement('button');
    btnSwitch.type = 'button';
    btnSwitch.className = 'hud-btn';
    btnSwitch.textContent = t('vision.switchCamera');
    btnSwitch.onclick = async () => {
      await cameraDetector.switchCamera();
      const activeMeta = cameraDetector.getActiveCameraMeta();
      if (activeMeta?.deviceId) {
        deps.updateSettings({ webcamDeviceId: activeMeta.deviceId });
      }
      renderFull();
    };

    const btnScan = document.createElement('button');
    btnScan.type = 'button';
    btnScan.className = 'hud-btn';
    btnScan.textContent = t('vision.scanNow');
    btnScan.onclick = () => deps.onXrScan();

    camBtns.append(btnStartStop, btnSwitch, btnScan);
    camCard.appendChild(camBtns);

    const webcamOpts = document.createElement('div');
    webcamOpts.className = 'hud-row hud-row-wrap';
    webcamOpts.append(
      createCheckbox(t('vision.mirrorWebcam'), settings.webcamMirror, (v) => {
        deps.updateSettings({ webcamMirror: v });
        previewVideo.className = v ? 'hud-camera-video is-mirrored' : 'hud-camera-video';
      }),
      createCheckbox(t('vision.webcam3d'), settings.webcam3dPreviewEnabled, (v) =>
        deps.updateSettings({ webcam3dPreviewEnabled: v })
      )
    );
    camCard.appendChild(webcamOpts);

    // Справа: переключатели ML-модулей, статус руки, список объектов и жесты головы
    const infoCard = document.createElement('div');
    infoCard.className = 'hud-card';

    const toggles = document.createElement('div');
    toggles.className = 'hud-toggles';
    toggles.append(
      createCheckbox(t('vision.objectDetection'), settings.cameraObjectDetectionEnabled, (v) =>
        deps.updateSettings({ cameraObjectDetectionEnabled: v })
      ),
      createCheckbox(t('vision.handTracking'), settings.cameraHandTrackingEnabled, (v) =>
        deps.updateSettings({ cameraHandTrackingEnabled: v })
      ),
      createCheckbox(t('handDiag.toggleOverlay'), settings.handDiagnosticOverlayEnabled, (v) =>
        deps.updateSettings({ handDiagnosticOverlayEnabled: v })
      ),
      createCheckbox(t('handDiag.showIndices'), settings.handShowLandmarkIndices, (v) =>
        deps.updateSettings({ handShowLandmarkIndices: v })
      ),
      createCheckbox(t('vision.headGestures'), settings.headGesturesEnabled, (v) =>
        deps.updateSettings({ headGesturesEnabled: v })
      )
    );
    infoCard.appendChild(toggles);

    const handBox = document.createElement('div');
    handBox.id = 'hud-hand-status';
    handBox.className = 'hud-pill-box';
    handBox.textContent = `${t('vision.handState')}: ${t('vision.handMissing')}`;
    infoCard.appendChild(handBox);

    const gestureBox = document.createElement('div');
    gestureBox.id = 'hud-head-gesture';
    gestureBox.className = 'hud-muted';
    gestureBox.textContent = `${t('vision.headGestureHint')} | ${t('vision.lastGesture')}: ${latestHeadGestureText}`;
    infoCard.appendChild(gestureBox);

    const objList = document.createElement('div');
    objList.id = 'hud-objects-list';
    objList.className = 'hud-list';
    objList.textContent = t('vision.noObjects');
    infoCard.appendChild(objList);

    grid.append(camCard, infoCard);
    parent.appendChild(grid);

    // Карточка управления классами детекции ('Detection Objects')
    parent.appendChild(renderDetectionObjectsCard(settings));
  }

  function renderDetectionObjectsCard(settings: AppSettingsState): HTMLDivElement {
    const t = translator.t;
    const detSettings = settings.detectionObjects;
    const allKnown = detectionManager.getAllKnownClasses(detSettings);

    const card = document.createElement('div');
    card.className = 'hud-card hud-detmgr-card';

    const headerRow = document.createElement('div');
    headerRow.className = 'hud-row hud-row-between';

    const titleWrap = document.createElement('div');
    titleWrap.innerHTML = `
      <div class="hud-card-title">${escapeHtml(t('detMgr.title'))}</div>
      <div class="hud-audio-subtitle">${escapeHtml(t('detMgr.subtitle'))}</div>
    `;

    const badge = document.createElement('span');
    badge.className = `hud-badge ${detSettings.trackAllClasses || detSettings.enabledClasses.length > 0 ? 'is-ok' : ''}`;
    badge.textContent = detSettings.trackAllClasses
      ? t('detMgr.allActiveBadge')
      : `${t('detMgr.activeCount')}: ${detSettings.enabledClasses.length} / ${allKnown.length}`;

    headerRow.append(titleWrap, badge);
    card.appendChild(headerRow);

    // Кнопки режима и массового выбора
    const modeRow = document.createElement('div');
    modeRow.className = 'hud-row hud-row-wrap';

    const trackAllBtn = document.createElement('button');
    trackAllBtn.type = 'button';
    trackAllBtn.className = `hud-btn ${detSettings.trackAllClasses ? 'hud-btn-primary' : ''}`;
    trackAllBtn.textContent = t('detMgr.trackAll');
    trackAllBtn.onclick = () => {
      deps.updateSettings({
        detectionObjects: detectionManager.setTrackAll(
          deps.getSettings().detectionObjects,
          true
        ),
      });
      renderFull();
    };

    const customModeBtn = document.createElement('button');
    customModeBtn.type = 'button';
    customModeBtn.className = `hud-btn ${!detSettings.trackAllClasses ? 'hud-btn-primary' : ''}`;
    customModeBtn.textContent = t('detMgr.customMode');
    customModeBtn.onclick = () => {
      deps.updateSettings({
        detectionObjects: detectionManager.setTrackAll(
          deps.getSettings().detectionObjects,
          false
        ),
      });
      renderFull();
    };

    const selectAllBtn = document.createElement('button');
    selectAllBtn.type = 'button';
    selectAllBtn.className = 'hud-btn';
    selectAllBtn.textContent = t('detMgr.selectAll');
    selectAllBtn.onclick = () => {
      deps.updateSettings({
        detectionObjects: detectionManager.selectAll(
          deps.getSettings().detectionObjects
        ),
      });
      renderFull();
    };

    const clearAllBtn = document.createElement('button');
    clearAllBtn.type = 'button';
    clearAllBtn.className = 'hud-btn';
    clearAllBtn.textContent = t('detMgr.clearAll');
    clearAllBtn.onclick = () => {
      deps.updateSettings({
        detectionObjects: detectionManager.clearAll(
          deps.getSettings().detectionObjects
        ),
      });
      renderFull();
    };

    modeRow.append(trackAllBtn, customModeBtn, selectAllBtn, clearAllBtn);
    card.appendChild(modeRow);

    // Поиск и добавление собственного класса
    const toolsRow = document.createElement('div');
    toolsRow.className = 'hud-row hud-row-wrap';

    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'hud-input';
    searchInput.placeholder = t('detMgr.searchPlaceholder');
    searchInput.value = detectionSearchQuery;

    const customInput = document.createElement('input');
    customInput.type = 'text';
    customInput.className = 'hud-input';
    customInput.placeholder = t('detMgr.customPlaceholder');

    const addCustomBtn = document.createElement('button');
    addCustomBtn.type = 'button';
    addCustomBtn.className = 'hud-btn hud-btn-primary';
    addCustomBtn.textContent = `+ ${t('detMgr.addCustom')}`;
    addCustomBtn.onclick = () => {
      const val = customInput.value.trim();
      if (!val) return;
      customInput.value = '';
      deps.updateSettings({
        detectionObjects: detectionManager.addCustomClass(
          deps.getSettings().detectionObjects,
          val
        ),
      });
      renderFull();
    };

    toolsRow.append(searchInput, customInput, addCustomBtn);
    card.appendChild(toolsRow);

    const groupsContainer = document.createElement('div');
    groupsContainer.className = 'hud-detmgr-groups';

    const renderGroups = () => {
      groupsContainer.innerHTML = '';
      const latestDet = deps.getSettings().detectionObjects;
      const query = detectionSearchQuery.trim().toLowerCase();

      for (const group of detectionManager.getCatalogGroups()) {
        const filteredClasses = query
          ? group.classes.filter((c) => c.toLowerCase().includes(query))
          : group.classes;
        if (filteredClasses.length === 0) continue;

        const groupBox = document.createElement('div');
        groupBox.className = 'hud-detmgr-group';

        const groupHeader = document.createElement('div');
        groupHeader.className = 'hud-row hud-row-between';

        const groupFull = detectionManager.isGroupFullyEnabled(latestDet, group.id);
        const groupToggle = document.createElement('button');
        groupToggle.type = 'button';
        groupToggle.className = `hud-detmgr-group-btn ${groupFull ? 'is-on' : ''}`;
        groupToggle.textContent = `${groupFull ? '✓ ' : ''}${t(`detMgr.group.${group.id}`)}`;
        groupToggle.onclick = () => {
          deps.updateSettings({
            detectionObjects: detectionManager.toggleGroup(
              deps.getSettings().detectionObjects,
              group.id
            ),
          });
          renderFull();
        };

        groupHeader.appendChild(groupToggle);
        groupBox.appendChild(groupHeader);

        const chipsWrap = document.createElement('div');
        chipsWrap.className = 'hud-detmgr-chips';

        for (const cls of filteredClasses) {
          const enabled = detectionManager.isClassEnabled(latestDet, cls);
          const chip = document.createElement('button');
          chip.type = 'button';
          chip.className = `hud-detmgr-chip ${enabled ? 'is-active' : ''}`;
          chip.textContent = cls;
          chip.onclick = () => {
            deps.updateSettings({
              detectionObjects: detectionManager.toggleClass(
                deps.getSettings().detectionObjects,
                cls
              ),
            });
            renderFull();
          };
          chipsWrap.appendChild(chip);
        }

        groupBox.appendChild(chipsWrap);
        groupsContainer.appendChild(groupBox);
      }

      // Пользовательские классы
      const filteredCustom = query
        ? latestDet.customClasses.filter((c) => c.toLowerCase().includes(query))
        : latestDet.customClasses;

      if (filteredCustom.length > 0) {
        const customBox = document.createElement('div');
        customBox.className = 'hud-detmgr-group';

        const lbl = document.createElement('div');
        lbl.className = 'hud-field-label';
        lbl.textContent = t('detMgr.group.custom');
        customBox.appendChild(lbl);

        const chipsWrap = document.createElement('div');
        chipsWrap.className = 'hud-detmgr-chips';

        for (const cls of filteredCustom) {
          const enabled = detectionManager.isClassEnabled(latestDet, cls);
          const chipWrap = document.createElement('div');
          chipWrap.className = 'hud-detmgr-custom-item';

          const chip = document.createElement('button');
          chip.type = 'button';
          chip.className = `hud-detmgr-chip ${enabled ? 'is-active' : ''}`;
          chip.textContent = cls;
          chip.onclick = () => {
            deps.updateSettings({
              detectionObjects: detectionManager.toggleClass(
                deps.getSettings().detectionObjects,
                cls
              ),
            });
            renderFull();
          };

          const delBtn = document.createElement('button');
          delBtn.type = 'button';
          delBtn.className = 'hud-detmgr-del';
          delBtn.textContent = '×';
          delBtn.onclick = () => {
            deps.updateSettings({
              detectionObjects: detectionManager.removeCustomClass(
                deps.getSettings().detectionObjects,
                cls
              ),
            });
            renderFull();
          };

          chipWrap.append(chip, delBtn);
          chipsWrap.appendChild(chipWrap);
        }

        customBox.appendChild(chipsWrap);
        groupsContainer.appendChild(customBox);
      }
    };

    searchInput.oninput = () => {
      detectionSearchQuery = searchInput.value;
      renderGroups();
    };

    renderGroups();
    card.appendChild(groupsContainer);
    return card;
  }

  function renderDevicesTab(parent: HTMLElement, settings: AppSettingsState): void {
    const t = translator.t;
    const grid = document.createElement('div');
    grid.className = 'hud-grid-2';

    // Левая колонка: Rokid Max, Viewing Mode, Stereo IPD, IMU
    const xrCard = document.createElement('div');
    xrCard.className = 'hud-card';
    xrCard.innerHTML = `<div class="hud-card-title">${t('devices.headsetDetected')} & ${t('devices.viewingMode')}</div>`;

    const modeRow = document.createElement('div');
    modeRow.className = 'hud-row';
    (['auto', 'monoscopic', 'sbs', '360'] as ViewingMode[]).forEach((mode) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `hud-btn ${settings.viewingMode === mode ? 'hud-btn-primary' : ''}`;
      b.textContent = t(`devices.mode.${mode}`);
      b.onclick = () => {
        deps.updateSettings({ viewingMode: mode });
        renderFull();
      };
      modeRow.appendChild(b);
    });
    xrCard.appendChild(modeRow);

    const ipdRow = createRangeField(
      `${t('devices.ipd')}: ${settings.ipdMm} mm`,
      54,
      74,
      1,
      settings.ipdMm,
      (val) => {
        deps.updateSettings({ ipdMm: val });
      }
    );
    xrCard.appendChild(ipdRow);

    const rokidBtn = document.createElement('button');
    rokidBtn.type = 'button';
    rokidBtn.className = 'hud-btn hud-btn-primary';
    rokidBtn.textContent = t('devices.rokidConnect');
    rokidBtn.onclick = async () => {
      const res = await deps.onConnectRokidHid();
      rokidStatusMessage = `${res.deviceName}: ${res.message}`;
      renderFull();
    };
    xrCard.appendChild(rokidBtn);

    const imuInfo = document.createElement('div');
    imuInfo.id = 'hud-imu-telemetry';
    imuInfo.className = 'hud-mono-box';
    imuInfo.textContent = rokidStatusMessage || `${t('devices.imuStatus')}: Active`;
    xrCard.appendChild(imuInfo);

    // Удаленная навигация
    const navTitle = document.createElement('div');
    navTitle.className = 'hud-card-title';
    navTitle.textContent = t('devices.remoteNav');
    xrCard.appendChild(navTitle);

    const navRow = document.createElement('div');
    navRow.className = 'hud-row';
    const navButtons: Array<[RemoteNavCommand, string]> = [
      ['forward', t('devices.navForward')],
      ['back', t('devices.navBack')],
      ['left', t('devices.navLeft')],
      ['right', t('devices.navRight')],
      ['reset', t('devices.navReset')],
    ];
    navButtons.forEach(([cmd, label]) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'hud-btn';
      btn.textContent = label;
      btn.onclick = () => deps.onNavigate(cmd);
      navRow.appendChild(btn);
    });
    xrCard.appendChild(navRow);

    // Правая колонка: Bluetooth, Wi-Fi/LAN, Cloud Rendering
    const wirelessCard = document.createElement('div');
    wirelessCard.className = 'hud-card';
    wirelessCard.innerHTML = `<div class="hud-card-title">${t('devices.connectedList')}</div>`;

    const btBtn = document.createElement('button');
    btBtn.type = 'button';
    btBtn.className = 'hud-btn hud-btn-primary';
    btBtn.textContent = t('devices.btScan');
    btBtn.onclick = async () => {
      await wirelessHub.pairBluetoothDevice();
      renderFull();
    };
    wirelessCard.appendChild(btBtn);

    const wifiRow = document.createElement('div');
    wifiRow.className = 'hud-row';
    const wifiInput = document.createElement('input');
    wifiInput.type = 'text';
    wifiInput.className = 'hud-input';
    wifiInput.placeholder = t('devices.wifiUrlPlaceholder');
    wifiInput.value = 'ws://192.168.1.50:8080';

    const wifiBtn = document.createElement('button');
    wifiBtn.type = 'button';
    wifiBtn.className = 'hud-btn';
    wifiBtn.textContent = t('devices.wifiConnect');
    wifiBtn.onclick = async () => {
      if (wifiInput.value.trim()) {
        await wirelessHub.connectWifiDevice(wifiInput.value.trim());
        renderFull();
      }
    };
    wifiRow.append(wifiInput, wifiBtn);
    wirelessCard.appendChild(wifiRow);

    wirelessCard.appendChild(
      createCheckbox(t('devices.cloudEnable'), settings.cloudRenderEnabled, (v) =>
        deps.updateSettings({ cloudRenderEnabled: v })
      )
    );

    const devList = document.createElement('div');
    devList.className = 'hud-list';
    const devs = wirelessHub.getDevices();
    if (devs.length === 0) {
      devList.innerHTML = `<div class="hud-muted">No BT/Wi-Fi devices paired yet.</div>`;
    } else {
      devs.forEach((d: WirelessDeviceEntry) => {
        const row = document.createElement('div');
        row.className = 'hud-list-item';
        row.innerHTML = `<strong>[${d.transport.toUpperCase()}] ${escapeHtml(d.name)}</strong><span>${escapeHtml(d.status)} — ${escapeHtml(d.detail)}</span>`;
        devList.appendChild(row);
      });
    }
    wirelessCard.appendChild(devList);

    grid.append(xrCard, wirelessCard);
    parent.appendChild(grid);

    // Карточка стандартного Bluetooth гироскопического контроллера и лазерного луча
    const btCtrlCard = document.createElement('div');
    btCtrlCard.className = 'hud-card hud-detmgr-card';
    const ctrlState = btGyroController.getState();

    btCtrlCard.innerHTML = `
      <div class="hud-row hud-row-between">
        <div>
          <div class="hud-card-title">${escapeHtml(t('btCtrl.title'))}</div>
          <div class="hud-audio-subtitle">${escapeHtml(t('btCtrl.subtitle'))}</div>
        </div>
        <span class="hud-badge ${ctrlState.connected ? 'is-ok' : ''}">${ctrlState.connected ? escapeHtml(ctrlState.source.toUpperCase()) : 'OFFLINE'}</span>
      </div>
    `;

    const btCtrlBtns = document.createElement('div');
    btCtrlBtns.className = 'hud-row hud-row-wrap';

    const pairGyroBtn = document.createElement('button');
    pairGyroBtn.type = 'button';
    pairGyroBtn.className = 'hud-btn hud-btn-primary';
    pairGyroBtn.textContent = t('btCtrl.connectBle');
    pairGyroBtn.onclick = async () => {
      await btGyroController.connectBleGyroController();
      renderFull();
    };

    const virtualGyroBtn = document.createElement('button');
    virtualGyroBtn.type = 'button';
    virtualGyroBtn.className = 'hud-btn';
    virtualGyroBtn.textContent = t('btCtrl.connectVirtual');
    virtualGyroBtn.onclick = () => {
      btGyroController.connectVirtualGyroStub();
      renderFull();
    };

    const recenterBtn = document.createElement('button');
    recenterBtn.type = 'button';
    recenterBtn.className = 'hud-btn';
    recenterBtn.textContent = t('btCtrl.recenter');
    recenterBtn.onclick = () => btGyroController.recenter();

    const disconnectBtn = document.createElement('button');
    disconnectBtn.type = 'button';
    disconnectBtn.className = 'hud-btn hud-btn-danger';
    disconnectBtn.textContent = t('btCtrl.disconnect');
    disconnectBtn.disabled = !ctrlState.connected;
    disconnectBtn.onclick = () => {
      btGyroController.disconnect();
      renderFull();
    };

    btCtrlBtns.append(pairGyroBtn, virtualGyroBtn, recenterBtn, disconnectBtn);
    btCtrlCard.appendChild(btCtrlBtns);

    const ctrlOptsRow = document.createElement('div');
    ctrlOptsRow.className = 'hud-audio-controls-grid';
    ctrlOptsRow.append(
      createCheckbox(t('btCtrl.showLaser'), settings.btLaserBeamEnabled, (v) =>
        deps.updateSettings({ btLaserBeamEnabled: v })
      ),
      createRangeField(
        `${t('btCtrl.sensitivity')}: ${settings.btGyroSensitivity.toFixed(1)}x`,
        0.3,
        2.5,
        0.1,
        settings.btGyroSensitivity,
        (val) => {
          const lbl = ctrlOptsRow.querySelector('.hud-muted');
          if (lbl) lbl.textContent = `${t('btCtrl.sensitivity')}: ${val.toFixed(1)}x`;
          deps.updateSettings({ btGyroSensitivity: val });
        }
      )
    );
    btCtrlCard.appendChild(ctrlOptsRow);

    const ctrlTelemetryBox = document.createElement('div');
    ctrlTelemetryBox.id = 'hud-bt-ctrl-telemetry';
    ctrlTelemetryBox.className = 'hud-mono-box';
    ctrlTelemetryBox.textContent = ctrlState.connected
      ? `${ctrlState.deviceName} [${ctrlState.source}] • Y ${ctrlState.eulerDeg.yaw}° P ${ctrlState.eulerDeg.pitch}° R ${ctrlState.eulerDeg.roll}°`
      : t('btCtrl.disconnected');
    btCtrlCard.appendChild(ctrlTelemetryBox);

    parent.appendChild(btCtrlCard);

    // Карточка переключаемых 3D-комнат, залов и пультов управления
    const placesCard = document.createElement('div');
    placesCard.className = 'hud-card hud-detmgr-card';
    const snap = placesManager.getPanelSnapshot();

    placesCard.innerHTML = `
      <div class="hud-row hud-row-between">
        <div>
          <div class="hud-card-title">${escapeHtml(t('places.title'))}</div>
          <div class="hud-audio-subtitle">${escapeHtml(t('places.subtitle'))}</div>
        </div>
        <span class="hud-badge is-ok">${escapeHtml(t(`places.${settings.activeScenePlace}`))}</span>
      </div>
    `;

    const placeBtnsRow = document.createElement('div');
    placeBtnsRow.className = 'hud-row hud-row-wrap';
    const placeIds: SpatialPlaceId[] = [
      'calibration_lab',
      'datacenter',
      'spaceship',
      'airplane',
      'cyber_lounge',
    ];
    placeIds.forEach((pid) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `hud-btn ${settings.activeScenePlace === pid ? 'hud-btn-primary' : ''}`;
      btn.textContent = t(`places.${pid}`);
      btn.onclick = () => {
        deps.updateSettings({ activeScenePlace: pid });
        renderFull();
      };
      placeBtnsRow.appendChild(btn);
    });
    placesCard.appendChild(placeBtnsRow);

    const placeTelemetry = document.createElement('div');
    placeTelemetry.id = 'hud-place-telemetry';
    placeTelemetry.className = 'hud-mono-box';
    placeTelemetry.textContent = snap.statusLine;
    placesCard.appendChild(placeTelemetry);

    if (snap.actions.length > 0) {
      const panelCtrlTitle = document.createElement('div');
      panelCtrlTitle.className = 'hud-field-label';
      panelCtrlTitle.textContent = t('places.panelControls');
      placesCard.appendChild(panelCtrlTitle);

      const panelBtnsRow = document.createElement('div');
      panelBtnsRow.className = 'hud-row hud-row-wrap';
      snap.actions.forEach((act) => {
        const abtn = document.createElement('button');
        abtn.type = 'button';
        abtn.className = `hud-btn ${act.active ? 'hud-btn-primary' : ''}`;
        abtn.textContent = `${act.active ? '● ' : '○ '}${act.label}`;
        abtn.onclick = () => {
          placesManager.triggerPanelAction(act.id);
          renderFull();
        };
        panelBtnsRow.appendChild(abtn);
      });
      placesCard.appendChild(panelBtnsRow);
    }

    parent.appendChild(placesCard);
  }

  function renderCommsTab(parent: HTMLElement, settings: AppSettingsState): void {
    const t = translator.t;
    const card = document.createElement('div');
    card.className = 'hud-card';

    const header = document.createElement('div');
    header.className = 'hud-card-title';
    header.textContent = `${t('comms.title')} (${wsConnected ? 'WS Online' : 'WS Reconnecting...'})`;
    card.appendChild(header);

    // Настройки комнаты, имени и пары языков перевода
    const configRow = document.createElement('div');
    configRow.className = 'hud-row hud-row-wrap';

    const nameInput = document.createElement('input');
    nameInput.className = 'hud-input';
    nameInput.value = settings.userName;
    nameInput.placeholder = t('comms.peerName');

    const roomInput = document.createElement('input');
    roomInput.className = 'hud-input';
    roomInput.value = settings.roomId;
    roomInput.placeholder = t('comms.room');

    const joinBtn = document.createElement('button');
    joinBtn.type = 'button';
    joinBtn.className = 'hud-btn';
    joinBtn.textContent = t('comms.joinRoom');
    joinBtn.onclick = () => {
      deps.updateSettings({
        userName: nameInput.value.trim() || 'XR-Explorer',
        roomId: roomInput.value.trim() || 'rokid-global-session',
      });
      peerComms.connect(
        roomInput.value.trim() || 'rokid-global-session',
        nameInput.value.trim() || 'XR-Explorer',
        settings.sourceSpeechLang,
        'Rokid Vision XR'
      );
    };

    configRow.append(nameInput, roomInput, joinBtn);
    card.appendChild(configRow);

    // Выбор языка речи, целевого языка перевода и получателя (All или конкретный Peer)
    const langRow = document.createElement('div');
    langRow.className = 'hud-row hud-row-wrap';

    const srcSelect = createLangSelect(settings.sourceSpeechLang, (val) => {
      deps.updateSettings({ sourceSpeechLang: val });
      peerComms.updateProfile(settings.userName, val);
    });
    const dstSelect = createLangSelect(settings.targetTranslateLang, (val) => {
      deps.updateSettings({ targetTranslateLang: val });
    });

    const peerSelect = document.createElement('select');
    peerSelect.className = 'hud-select';
    const allOpt = document.createElement('option');
    allOpt.value = 'all';
    allOpt.textContent = t('comms.allPeers');
    peerSelect.appendChild(allOpt);
    peerComms.getPeers().forEach((p: SessionPeer) => {
      if (p.peerId === peerComms.getPeerId()) return;
      const opt = document.createElement('option');
      opt.value = p.peerId;
      opt.textContent = `${p.name} (${p.language.toUpperCase()})`;
      peerSelect.appendChild(opt);
    });
    peerSelect.value = targetPeerId;
    peerSelect.onchange = () => {
      targetPeerId = peerSelect.value;
    };

    langRow.append(
      wrapLabel(t('comms.sourceLang'), srcSelect),
      wrapLabel(t('comms.targetLang'), dstSelect),
      wrapLabel(t('comms.targetPeer'), peerSelect)
    );
    card.appendChild(langRow);

    card.appendChild(
      createCheckbox(t('comms.autoSpeak'), settings.autoSpeakIncoming, (v) =>
        deps.updateSettings({ autoSpeakIncoming: v })
      )
    );

    // Ввод текста + кнопка микрофона STT
    const sendRow = document.createElement('div');
    sendRow.className = 'hud-row';

    const msgInput = document.createElement('input');
    msgInput.className = 'hud-input';
    msgInput.placeholder = t('comms.messagePlaceholder');

    const micBtn = document.createElement('button');
    micBtn.type = 'button';
    micBtn.className = `hud-btn ${isMicActive ? 'hud-btn-danger' : 'hud-btn-primary'}`;
    micBtn.textContent = isMicActive ? t('comms.micStop') : t('comms.micStart');
    micBtn.onclick = () => {
      if (isMicActive) {
        peerComms.stopListening();
        isMicActive = false;
        renderFull();
      } else {
        const started = peerComms.startListening(settings.sourceSpeechLang, (finalText) => {
          isMicActive = false;
          void sendTranslatedMessage(finalText);
        });
        isMicActive = started;
        renderFull();
      }
    };

    const sendBtn = document.createElement('button');
    sendBtn.type = 'button';
    sendBtn.className = 'hud-btn hud-btn-primary';
    sendBtn.textContent = t('comms.sendText');
    sendBtn.onclick = () => {
      if (msgInput.value.trim()) {
        const text = msgInput.value;
        msgInput.value = '';
        void sendTranslatedMessage(text);
      }
    };

    async function sendTranslatedMessage(text: string): Promise<void> {
      const s = deps.getSettings();
      await peerComms.sendMessage(
        text,
        targetPeerId,
        s.sourceSpeechLang,
        s.targetTranslateLang,
        endpoints.getActiveByType('llm')
      );
      renderFull();
    }

    sendRow.append(msgInput, micBtn, sendBtn);
    card.appendChild(sendRow);

    // Участники онлайн и журнал переведенных сообщений
    const peersInfo = document.createElement('div');
    peersInfo.className = 'hud-muted';
    const peersList = peerComms.getPeers();
    peersInfo.textContent = `${t('comms.peersOnline')}: ${peersList.length} (${peersList.map((p) => p.name).join(', ') || settings.userName})`;
    card.appendChild(peersInfo);

    const logBox = document.createElement('div');
    logBox.className = 'hud-list';
    const msgs = peerComms.getMessages().slice(-8).reverse();
    if (msgs.length === 0) {
      logBox.innerHTML = `<div class="hud-muted">${t('comms.transcriptLog')} — empty</div>`;
    } else {
      msgs.forEach((m: TranslatedSpeechMessage) => {
        const item = document.createElement('div');
        item.className = 'hud-list-item';
        item.innerHTML = `
          <strong>${escapeHtml(m.fromName)} → ${m.toPeerId === 'all' ? 'ALL' : escapeHtml(m.toPeerId)} [${m.sourceLang.toUpperCase()}→${m.targetLang.toUpperCase()}]</strong>
          <span>${escapeHtml(m.translatedText)}</span>
          <small>${escapeHtml(m.originalText)}</small>
        `;
        logBox.appendChild(item);
      });
    }
    card.appendChild(logBox);
    parent.appendChild(card);
  }

  function renderDiagnosticsTab(parent: HTMLElement, settings: AppSettingsState): void {
    const t = translator.t;
    const grid = document.createElement('div');
    grid.className = 'hud-diag-grid';
    grid.id = 'hud-diag-grid';

    const fields = [
      ['diag-fps', t('diag.fps'), '—'],
      ['diag-frame', t('diag.frameTime'), '—'],
      ['diag-draws', t('diag.drawCalls'), '—'],
      ['diag-tris', t('diag.triangles'), '—'],
      ['diag-mem', t('diag.memory'), '—'],
      ['diag-ml', t('diag.mlLatency'), '—'],
      ['diag-imu', t('diag.imuLatency'), '—'],
      ['diag-batt', t('diag.battery'), '—'],
      ['diag-power', t('diag.charging'), '—'],
      ['diag-therm', t('diag.thermal'), '—'],
    ];

    fields.forEach(([id, label, initial]) => {
      const tile = document.createElement('div');
      tile.className = 'hud-stat-tile';
      tile.innerHTML = `<span class="hud-stat-label">${label}</span><strong class="hud-stat-val" id="${id}">${initial}</strong>`;
      grid.appendChild(tile);
    });

    parent.appendChild(grid);

    // Карточка Audio Settings для пространственного баланса, моделей затухания и усиления BT-устройств
    const audio = settings.audioSettings;
    const patchAudio = (patch: Partial<AppSettingsState['audioSettings']>) => {
      const latest = deps.getSettings().audioSettings;
      deps.updateSettings({
        audioSettings: { ...latest, ...patch },
      });
    };

    const audioCard = document.createElement('div');
    audioCard.className = 'hud-card hud-audio-card';

    const headerRow = document.createElement('div');
    headerRow.className = 'hud-row hud-row-between';

    const titleCol = document.createElement('div');
    titleCol.innerHTML = `
      <div class="hud-card-title">${escapeHtml(t('audio.title'))}</div>
      <div class="hud-audio-subtitle">${escapeHtml(t('audio.subtitle'))}</div>
    `;

    const testMainBtn = document.createElement('button');
    testMainBtn.type = 'button';
    testMainBtn.className = 'hud-btn hud-btn-primary';
    testMainBtn.textContent = t('audio.testSpatial');
    testMainBtn.onclick = () => void audioBalancer.playSpatialTestTone();

    headerRow.append(titleCol, testMainBtn);
    audioCard.appendChild(headerRow);

    // Выбор глобальной модели затухания (Linear / Inverse / Exponential)
    const modelWrap = document.createElement('div');
    modelWrap.className = 'hud-field';
    const modelLbl = document.createElement('div');
    modelLbl.className = 'hud-field-label';
    modelLbl.textContent = t('audio.attenuationModel');
    const modelBtns = document.createElement('div');
    modelBtns.className = 'hud-row hud-row-wrap';
    (['linear', 'inverse', 'exponential'] as AttenuationModelType[]).forEach((model) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `hud-btn ${audio.attenuationModel === model ? 'hud-btn-primary' : ''}`;
      btn.textContent = t(`audio.model.${model}`);
      btn.onclick = () => {
        patchAudio({ attenuationModel: model });
        renderFull();
      };
      modelBtns.appendChild(btn);
    });
    modelWrap.append(modelLbl, modelBtns);
    audioCard.appendChild(modelWrap);

    // Сетка основных параметров: Баланс, Общее усиление, Rolloff, Ref Dist, Max Dist
    const controlsGrid = document.createElement('div');
    controlsGrid.className = 'hud-audio-controls-grid';

    const panField = createRangeField(
      `${t('audio.spatialBalance')}: ${Math.round(audio.spatialBalance * 100)}%`,
      -1,
      1,
      0.05,
      audio.spatialBalance,
      (val) => {
        const lbl = panField.querySelector('.hud-muted');
        if (lbl) lbl.textContent = `${t('audio.spatialBalance')}: ${Math.round(val * 100)}%`;
        patchAudio({ spatialBalance: val });
      }
    );

    const gainField = createRangeField(
      `${t('audio.masterGain')}: ${Math.round(audio.masterGain * 100)}%`,
      0,
      2,
      0.05,
      audio.masterGain,
      (val) => {
        const lbl = gainField.querySelector('.hud-muted');
        if (lbl) lbl.textContent = `${t('audio.masterGain')}: ${Math.round(val * 100)}%`;
        patchAudio({ masterGain: val });
      }
    );

    const rolloffField = createRangeField(
      `${t('audio.rolloff')}: ${audio.rolloffFactor.toFixed(1)}`,
      0.1,
      5,
      0.1,
      audio.rolloffFactor,
      (val) => {
        const lbl = rolloffField.querySelector('.hud-muted');
        if (lbl) lbl.textContent = `${t('audio.rolloff')}: ${val.toFixed(1)}`;
        patchAudio({ rolloffFactor: val });
      }
    );

    const refField = createRangeField(
      `${t('audio.refDistance')}: ${audio.refDistance.toFixed(1)} m`,
      0.2,
      10,
      0.2,
      audio.refDistance,
      (val) => {
        const lbl = refField.querySelector('.hud-muted');
        if (lbl) lbl.textContent = `${t('audio.refDistance')}: ${val.toFixed(1)} m`;
        patchAudio({ refDistance: val });
      }
    );

    const maxField = createRangeField(
      `${t('audio.maxDistance')}: ${audio.maxDistance.toFixed(0)} m`,
      5,
      100,
      1,
      audio.maxDistance,
      (val) => {
        const lbl = maxField.querySelector('.hud-muted');
        if (lbl) lbl.textContent = `${t('audio.maxDistance')}: ${val.toFixed(0)} m`;
        patchAudio({ maxDistance: val });
      }
    );

    controlsGrid.append(panField, gainField, rolloffField, refField, maxField);
    audioCard.appendChild(controlsGrid);

    // Секция подключенных Bluetooth-устройств
    const btHeader = document.createElement('div');
    btHeader.className = 'hud-row hud-row-between';
    const btTitle = document.createElement('div');
    btTitle.className = 'hud-field-label';
    btTitle.textContent = t('audio.btDevices');
    const pairBtBtn = document.createElement('button');
    pairBtBtn.type = 'button';
    pairBtBtn.className = 'hud-btn';
    pairBtBtn.textContent = t('audio.pairBtNow');
    pairBtBtn.onclick = async () => {
      await wirelessHub.pairBluetoothDevice();
      renderFull();
    };
    btHeader.append(btTitle, pairBtBtn);
    audioCard.appendChild(btHeader);

    const btDevices = wirelessHub
      .getDevices()
      .filter((d) => d.transport === 'bluetooth');

    const btList = document.createElement('div');
    btList.className = 'hud-list';
    if (btDevices.length === 0) {
      btList.innerHTML = `<div class="hud-muted">${escapeHtml(t('audio.noBtDevices'))}</div>`;
    } else {
      btDevices.forEach((dev) => {
        const currentAudio = deps.getSettings().audioSettings;
        const profile = audioBalancer.getOrDefaultDeviceProfile(
          currentAudio,
          dev.id,
          dev.name
        );

        const updateDeviceProfile = (
          patch: Partial<typeof profile>
        ) => {
          const latest = deps.getSettings().audioSettings;
          const prev = audioBalancer.getOrDefaultDeviceProfile(
            latest,
            dev.id,
            dev.name
          );
          patchAudio({
            btDeviceProfiles: {
              ...latest.btDeviceProfiles,
              [dev.id]: { ...prev, ...patch },
            },
          });
        };

        const row = document.createElement('div');
        row.className = 'hud-list-item hud-audio-bt-row';

        const top = document.createElement('div');
        top.className = 'hud-row hud-row-between';
        top.innerHTML = `<strong>[BT] ${escapeHtml(dev.name)} <span class="hud-badge is-ok">${escapeHtml(dev.status)}</span></strong>`;

        const testDevBtn = document.createElement('button');
        testDevBtn.type = 'button';
        testDevBtn.className = 'hud-btn';
        testDevBtn.textContent = t('audio.testSpatial');
        testDevBtn.onclick = () => void audioBalancer.playSpatialTestTone(dev.id);
        top.appendChild(testDevBtn);

        const devControls = document.createElement('div');
        devControls.className = 'hud-audio-controls-grid';

        const devGain = createRangeField(
          `${t('audio.btGain')}: ${Math.round(profile.gain * 100)}%`,
          0,
          2,
          0.05,
          profile.gain,
          (val) => {
            const lbl = devGain.querySelector('.hud-muted');
            if (lbl) lbl.textContent = `${t('audio.btGain')}: ${Math.round(val * 100)}%`;
            updateDeviceProfile({ gain: val });
          }
        );

        const devPan = createRangeField(
          `${t('audio.btPan')}: ${Math.round(profile.pan * 100)}%`,
          -1,
          1,
          0.05,
          profile.pan,
          (val) => {
            const lbl = devPan.querySelector('.hud-muted');
            if (lbl) lbl.textContent = `${t('audio.btPan')}: ${Math.round(val * 100)}%`;
            updateDeviceProfile({ pan: val });
          }
        );

        const devModelSel = document.createElement('select');
        devModelSel.className = 'hud-select';
        (['linear', 'inverse', 'exponential'] as AttenuationModelType[]).forEach((m) => {
          const opt = document.createElement('option');
          opt.value = m;
          opt.textContent = t(`audio.model.${m}`);
          devModelSel.appendChild(opt);
        });
        devModelSel.value = profile.attenuationModel;
        devModelSel.onchange = () => {
          updateDeviceProfile({
            attenuationModel: devModelSel.value as AttenuationModelType,
          });
        };

        devControls.append(
          devGain,
          devPan,
          wrapLabel(t('audio.attenuationModel'), devModelSel)
        );
        row.append(top, devControls);
        btList.appendChild(row);
      });
    }

    audioCard.appendChild(btList);
    parent.appendChild(audioCard);
  }

  function renderEndpointsTab(parent: HTMLElement): void {
    const t = translator.t;
    const wrapper = document.createElement('div');
    wrapper.className = 'hud-card';

    const top = document.createElement('div');
    top.className = 'hud-row hud-row-between';
    top.innerHTML = `<div class="hud-card-title">${t('endpoints.title')}</div>`;

    const actionBtns = document.createElement('div');
    actionBtns.className = 'hud-row';

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'hud-btn hud-btn-primary';
    addBtn.textContent = `+ ${t('endpoints.add')}`;
    addBtn.onclick = () => {
      editingEndpoint = {
        id: `ep-${Date.now()}`,
        name: 'Custom OpenAI Endpoint',
        type: 'llm',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: '',
        model: 'gpt-4o-mini',
        availableModels: [],
        customHeadersJson: '{}',
        enabled: true,
        lastTestStatus: 'idle',
        lastTestMessage: '',
        lastLatencyMs: null,
      };
      renderFull();
    };

    const deleteAllBtn = document.createElement('button');
    deleteAllBtn.type = 'button';
    deleteAllBtn.className = 'hud-btn hud-btn-danger';
    deleteAllBtn.textContent = t('endpoints.deleteAll');
    deleteAllBtn.onclick = () => {
      endpoints.removeAll();
      editingEndpoint = null;
      renderFull();
    };

    actionBtns.append(addBtn, deleteAllBtn);
    top.appendChild(actionBtns);
    wrapper.appendChild(top);

    // Форма добавления / редактирования эндпоинта
    if (editingEndpoint) {
      const draft = { ...editingEndpoint };
      const form = document.createElement('div');
      form.className = 'hud-endpoint-form';

      const nameIn = document.createElement('input');
      nameIn.className = 'hud-input';
      nameIn.value = draft.name;
      nameIn.placeholder = t('endpoints.name');

      const typeSel = document.createElement('select');
      typeSel.className = 'hud-select';
      ENDPOINT_CATEGORIES.forEach((cat: EndpointCategory) => {
        const opt = document.createElement('option');
        opt.value = cat;
        opt.textContent = cat.toUpperCase();
        typeSel.appendChild(opt);
      });
      typeSel.value = draft.type;

      const urlIn = document.createElement('input');
      urlIn.className = 'hud-input';
      urlIn.value = draft.baseUrl;
      urlIn.placeholder = t('endpoints.url');

      const keyIn = document.createElement('input');
      keyIn.className = 'hud-input';
      keyIn.type = 'password';
      keyIn.value = draft.apiKey;
      keyIn.placeholder = t('endpoints.apiKey');

      const modelIn = document.createElement('input');
      modelIn.className = 'hud-input';
      modelIn.value = draft.model;
      modelIn.placeholder = t('endpoints.model');

      const headersIn = document.createElement('input');
      headersIn.className = 'hud-input';
      headersIn.value = draft.customHeadersJson;
      headersIn.placeholder = t('endpoints.headers');

      const formBtns = document.createElement('div');
      formBtns.className = 'hud-row';

      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'hud-btn hud-btn-primary';
      saveBtn.textContent = t('endpoints.save');
      saveBtn.onclick = () => {
        endpoints.upsert({
          ...draft,
          name: nameIn.value.trim() || 'Endpoint',
          type: typeSel.value as EndpointCategory,
          baseUrl: urlIn.value.trim(),
          apiKey: keyIn.value.trim(),
          model: modelIn.value.trim(),
          customHeadersJson: headersIn.value.trim() || '{}',
        });
        editingEndpoint = null;
        renderFull();
      };

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'hud-btn';
      cancelBtn.textContent = t('endpoints.cancel');
      cancelBtn.onclick = () => {
        editingEndpoint = null;
        renderFull();
      };

      formBtns.append(saveBtn, cancelBtn);
      form.append(
        wrapLabel(t('endpoints.name'), nameIn),
        wrapLabel(t('endpoints.type'), typeSel),
        wrapLabel(t('endpoints.url'), urlIn),
        wrapLabel(t('endpoints.apiKey'), keyIn),
        wrapLabel(t('endpoints.model'), modelIn),
        wrapLabel(t('endpoints.headers'), headersIn),
        formBtns
      );
      wrapper.appendChild(form);
    }

    // Список существующих эндпоинтов с кнопками Test Connection, Fetch Model List, Edit, Delete
    const list = document.createElement('div');
    list.className = 'hud-list';
    const allEps = endpoints.getAll();
    if (allEps.length === 0) {
      list.innerHTML = `<div class="hud-muted">${t('endpoints.empty')}</div>`;
    } else {
      allEps.forEach((ep) => {
        const item = document.createElement('div');
        item.className = 'hud-endpoint-row';

        const meta = document.createElement('div');
        meta.className = 'hud-endpoint-meta';
        meta.innerHTML = `
          <div><strong>[${ep.type.toUpperCase()}] ${escapeHtml(ep.name)}</strong> <span class="hud-badge ${ep.enabled ? 'is-ok' : ''}">${ep.enabled ? t('endpoints.enabled') : t('endpoints.disabled')}</span></div>
          <small>${escapeHtml(ep.baseUrl)} • Model: ${escapeHtml(ep.model || '—')}</small>
          ${ep.lastTestMessage ? `<small class="${ep.lastTestStatus === 'ok' ? 'txt-ok' : 'txt-err'}">${escapeHtml(ep.lastTestMessage)}</small>` : ''}
        `;

        const controls = document.createElement('div');
        controls.className = 'hud-row hud-row-wrap';

        // Выпадающий список загруженных моделей, если есть
        if (ep.availableModels.length > 0) {
          const modelSel = document.createElement('select');
          modelSel.className = 'hud-select hud-select-sm';
          ep.availableModels.forEach((m) => {
            const o = document.createElement('option');
            o.value = m;
            o.textContent = m;
            modelSel.appendChild(o);
          });
          modelSel.value = ep.model;
          modelSel.onchange = () => {
            endpoints.upsert({ ...ep, model: modelSel.value });
          };
          controls.appendChild(modelSel);
        }

        const testBtn = document.createElement('button');
        testBtn.type = 'button';
        testBtn.className = 'hud-btn';
        testBtn.textContent = t('endpoints.test');
        testBtn.onclick = async () => {
          testBtn.disabled = true;
          await endpoints.testConnection(ep.id);
          renderFull();
        };

        const modelsBtn = document.createElement('button');
        modelsBtn.type = 'button';
        modelsBtn.className = 'hud-btn';
        modelsBtn.textContent = t('endpoints.fetchModels');
        modelsBtn.onclick = async () => {
          modelsBtn.disabled = true;
          await endpoints.fetchModels(ep.id);
          renderFull();
        };

        const toggleEnBtn = document.createElement('button');
        toggleEnBtn.type = 'button';
        toggleEnBtn.className = 'hud-btn';
        toggleEnBtn.textContent = ep.enabled ? 'ON' : 'OFF';
        toggleEnBtn.onclick = () => {
          endpoints.upsert({ ...ep, enabled: !ep.enabled });
          renderFull();
        };

        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'hud-btn';
        editBtn.textContent = t('endpoints.edit');
        editBtn.onclick = () => {
          editingEndpoint = { ...ep };
          renderFull();
        };

        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'hud-btn hud-btn-danger';
        delBtn.textContent = t('endpoints.delete');
        delBtn.onclick = () => {
          endpoints.remove(ep.id);
          renderFull();
        };

        controls.append(testBtn, modelsBtn, toggleEnBtn, editBtn, delBtn);
        item.append(meta, controls);
        list.appendChild(item);
      });
    }

    wrapper.appendChild(list);
    parent.appendChild(wrapper);
  }

  function renderSettingsTab(parent: HTMLElement, settings: AppSettingsState): void {
    const t = translator.t;
    const card = document.createElement('div');
    card.className = 'hud-card';

    const uiLangSel = document.createElement('select');
    uiLangSel.className = 'hud-select';
    [
      ['en', 'English'],
      ['ru', 'Русский'],
      ['de', 'Deutsch'],
    ].forEach(([code, label]) => {
      const opt = document.createElement('option');
      opt.value = code;
      opt.textContent = label;
      uiLangSel.appendChild(opt);
    });
    uiLangSel.value = settings.uiLanguage;
    uiLangSel.onchange = () =>
      deps.updateSettings({ uiLanguage: uiLangSel.value as AppLanguage });

    const srcLangSel = createLangSelect(settings.sourceSpeechLang, (v) =>
      deps.updateSettings({ sourceSpeechLang: v })
    );
    const dstLangSel = createLangSelect(settings.targetTranslateLang, (v) =>
      deps.updateSettings({ targetTranslateLang: v })
    );

    const imuSlider = createRangeField(
      `${t('settings.imuStrength')}: ${Math.round(settings.imuStabilizationStrength * 100)}%`,
      0,
      1,
      0.05,
      settings.imuStabilizationStrength,
      (v) => deps.updateSettings({ imuStabilizationStrength: v })
    );

    card.append(
      wrapLabel(t('settings.uiLanguage'), uiLangSel),
      wrapLabel(t('settings.speechFrom'), srcLangSel),
      wrapLabel(t('settings.translateTo'), dstLangSel),
      imuSlider
    );
    parent.appendChild(card);
  }

  // Подписки на внешние обновления
  const unsubLang = translator.subscribe(() => {
    handOverlay.refreshLocalization();
    renderFull();
  });
  const unsubWireless = wirelessHub.subscribe(() => {
    if (activeTab === 'devices' || activeTab === 'diagnostics') renderFull();
  });
  const unsubBtCtrl = btGyroController.subscribe(() => {
    if (activeTab === 'devices' && !collapsed) renderFull();
  });

  renderFull();

  return {
    updateLiveTelemetry({ imu, headset, activeMode, diagnostics, detections, hand }) {
      const badge = document.getElementById('hud-top-badge');
      if (badge) {
        badge.textContent = `${headset.toUpperCase()} • ${activeMode.toUpperCase()} • ${diagnostics.fps} FPS`;
      }

      const currentSettings = deps.getSettings();
      handOverlay.update(hand, currentSettings.webcamMirror);

      if (collapsed) return;

      if (activeTab === 'vision') {
        drawCameraOverlay(
          overlayCanvas,
          previewVideo,
          detections,
          hand,
          currentSettings.webcamMirror,
          currentSettings.handShowLandmarkIndices
        );
        const handEl = document.getElementById('hud-hand-status');
        if (handEl) {
          handEl.textContent = hand.detected
            ? `${translator.t('vision.handDetected')} (${hand.handedness} ${Math.round(hand.handednessConfidence * 100)}%): ${hand.gestureLabel} (${Math.round(hand.gestureConfidence * 100)}%) ${hand.pinching ? '• ' + translator.t('vision.pinchActive') : ''}`
            : `${translator.t('vision.handState')}: ${translator.t('vision.handMissing')}`;
        }
        const objEl = document.getElementById('hud-objects-list');
        if (objEl) {
          objEl.innerHTML =
            detections.length === 0
              ? `<div class="hud-muted">${translator.t('vision.noObjects')}</div>`
              : detections
                  .map(
                    (d) =>
                      `<div class="hud-list-item"><strong>${escapeHtml(d.label)}</strong><span>${Math.round(d.score * 100)}% • ${d.source}</span></div>`
                  )
                  .join('');
        }
      } else if (activeTab === 'devices') {
        const imuEl = document.getElementById('hud-imu-telemetry');
        if (imuEl) {
          imuEl.textContent =
            `Source: ${imu.source} | Rokid HID: ${imu.rokidConnected ? 'CONNECTED' : 'STANDBY'}\n` +
            `Yaw: ${imu.eulerDeg.yaw}° | Pitch: ${imu.eulerDeg.pitch}° | Roll: ${imu.eulerDeg.roll}°\n` +
            `Latency: ${imu.latencyMs} ms | Mode: ${activeMode.toUpperCase()} | IPD: ${imu.ipdMm}mm`;
        }
        const btEl = document.getElementById('hud-bt-ctrl-telemetry');
        if (btEl) {
          const cs = btGyroController.getState();
          btEl.textContent = cs.connected
            ? `${cs.deviceName} [${cs.source.toUpperCase()}] • Trigger: ${cs.triggerPressed ? 'PRESSED' : 'IDLE'}\n` +
              `Gyro Orient: Yaw ${cs.eulerDeg.yaw}° | Pitch ${cs.eulerDeg.pitch}° | Roll ${cs.eulerDeg.roll}°\n` +
              `Laser Hit: ${cs.laserHitLabel ? `${cs.laserHitLabel} (${cs.laserDistanceM} m)` : 'Free space'}`
            : translator.t('btCtrl.disconnected');
        }
        const placeEl = document.getElementById('hud-place-telemetry');
        if (placeEl) {
          placeEl.textContent = placesManager.getPanelSnapshot().statusLine;
        }
      } else if (activeTab === 'diagnostics') {
        const setVal = (id: string, val: string) => {
          const el = document.getElementById(id);
          if (el) el.textContent = val;
        };
        setVal('diag-fps', `${diagnostics.fps}`);
        setVal('diag-frame', `${diagnostics.frameTimeMs} ms`);
        setVal('diag-draws', `${diagnostics.drawCalls}`);
        setVal('diag-tris', `${diagnostics.triangles}`);
        setVal(
          'diag-mem',
          diagnostics.memoryUsedMb !== null ? `${diagnostics.memoryUsedMb} MB` : 'N/A'
        );
        setVal('diag-ml', `${diagnostics.mlInferenceMs} ms`);
        setVal('diag-imu', `${diagnostics.imuLatencyMs} ms`);
        setVal(
          'diag-batt',
          diagnostics.batteryLevelPct !== null
            ? `${diagnostics.batteryLevelPct}%`
            : translator.t('diag.batteryUnsupported')
        );
        setVal(
          'diag-power',
          diagnostics.batteryCharging === null
            ? 'N/A'
            : diagnostics.batteryCharging
              ? translator.t('diag.chargingYes')
              : translator.t('diag.chargingNo')
        );
        setVal('diag-therm', diagnostics.thermalState.toUpperCase());
      }
    },

    handleHeadGesture(action: HeadGestureAction) {
      latestHeadGestureText = action.toUpperCase();
      if (action === 'tilt_right') {
        const nextIdx = (TAB_ORDER.indexOf(activeTab) + 1) % TAB_ORDER.length;
        activeTab = TAB_ORDER[nextIdx];
        renderFull();
      } else if (action === 'tilt_left') {
        const nextIdx =
          (TAB_ORDER.indexOf(activeTab) - 1 + TAB_ORDER.length) % TAB_ORDER.length;
        activeTab = TAB_ORDER[nextIdx];
        renderFull();
      } else if (action === 'shake') {
        collapsed = true;
        renderFull();
      } else if (action === 'nod') {
        if (collapsed) {
          collapsed = false;
          renderFull();
        } else {
          deps.onXrScan();
        }
      }
    },

    setWsConnected(connected: boolean) {
      wsConnected = connected;
      if (activeTab === 'comms' && !collapsed) {
        renderFull();
      }
    },

    refreshComms() {
      if (activeTab === 'comms' && !collapsed) {
        renderFull();
      }
    },

    refreshPlaceControls() {
      if (activeTab === 'devices' && !collapsed) {
        renderFull();
      }
    },

    dispose() {
      unsubLang();
      unsubWireless();
      unsubWebcams();
      unsubBtCtrl();
      handOverlay.dispose();
      root.remove();
    },
  };
}

function drawCameraOverlay(
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement,
  detections: DetectedEntity[],
  hand: CameraHandState,
  mirror = false,
  showLandmarkIndices = true
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!video.videoWidth) return;

  // Рисуем рамки ML-детекции объектов
  ctx.lineWidth = 2;
  ctx.font = '12px sans-serif';
  for (const det of detections) {
    const [xmin, ymin, xmax, ymax] = det.bbox;
    const x = (mirror ? 1 - xmax : xmin) * canvas.width;
    const y = ymin * canvas.height;
    const w = (xmax - xmin) * canvas.width;
    const h = (ymax - ymin) * canvas.height;

    ctx.strokeStyle = '#38bdf8';
    ctx.strokeRect(x, y, w, h);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.78)';
    const labelText = `${det.label} ${Math.round(det.score * 100)}%`;
    ctx.fillRect(x, Math.max(0, y - 18), ctx.measureText(labelText).width + 10, 18);
    ctx.fillStyle = '#e0f2fe';
    ctx.fillText(labelText, x + 5, Math.max(12, y - 5));
  }

  // Рисуем полный 21-точечный скелет руки, соединения костей и метку уверенности
  drawHandSkeletonOnCanvas(ctx, canvas.width, canvas.height, hand, {
    mirror,
    showIndices: showLandmarkIndices,
    showBoundingBox: true,
    showGrid: false,
  });
}

function createCheckbox(
  label: string,
  checked: boolean,
  onChange: (val: boolean) => void
): HTMLLabelElement {
  const wrap = document.createElement('label');
  wrap.className = 'hud-checkbox';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.onchange = () => onChange(input.checked);
  const span = document.createElement('span');
  span.textContent = label;
  wrap.append(input, span);
  return wrap;
}

function createRangeField(
  label: string,
  min: number,
  max: number,
  step: number,
  value: number,
  onChange: (val: number) => void
): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.className = 'hud-range-wrap';
  const lbl = document.createElement('div');
  lbl.className = 'hud-muted';
  lbl.textContent = label;
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.oninput = () => onChange(Number(input.value));
  wrap.append(lbl, input);
  return wrap;
}

function createLangSelect(
  value: TranslationLanguageCode,
  onChange: (val: TranslationLanguageCode) => void
): HTMLSelectElement {
  const sel = document.createElement('select');
  sel.className = 'hud-select';
  TRANSLATION_LANGUAGES.forEach((l) => {
    const opt = document.createElement('option');
    opt.value = l.code;
    opt.textContent = `${l.nativeLabel} (${l.code.toUpperCase()})`;
    sel.appendChild(opt);
  });
  sel.value = value;
  sel.onchange = () => onChange(sel.value as TranslationLanguageCode);
  return sel;
}

function wrapLabel(title: string, control: HTMLElement): HTMLDivElement {
  const box = document.createElement('div');
  box.className = 'hud-field';
  const lbl = document.createElement('label');
  lbl.className = 'hud-field-label';
  lbl.textContent = title;
  box.append(lbl, control);
  return box;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

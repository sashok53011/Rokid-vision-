/**
 * Главный 3D-сценарий XR Blocks (SpatialVisionScene).
 *
 * Назначение:
 * Наследует `xb.Script` и объединяет все модули приложения в едином цикле обновления WebXR:
 * - Окружение и облачный рендеринг (streamCloudEnvironment);
 * - Трекинг IMU и протокол Rokid Max 1st Gen (readRokidImuAndProtocol);
 * - Автоматическое и ручное переключение режимов Monoscopic / SBS 3D / 360° (switchViewingMode);
 * - Камерная ML-детекция объектов и трекинг руки (detectObjectsFromCamera, trackHandsFromCamera);
 * - Бесконтактные жесты головы через XR Blocks HeadGestureRecognition и IMU (recognizeHeadGestures);
 * - Удаленная навигация по сцене (navigateRemotely);
 * - Пространственная карточка управления `xb.UICard` в мировых координатах;
 * - Телеметрия рендерера и батареи (monitorPerformanceAndBattery).
 */

import * as THREE from 'three';
import * as xb from 'xrblocks';
import type {
  AppSettingsState,
  CameraHandState,
  DetectedEntity,
  HeadGestureAction,
  HeadsetProfile,
  ImuTelemetry,
  PerformanceDiagnostics,
  ResolvedViewingMode,
  SpatialPlaceId,
} from '../types';
import type { InterfaceTranslator } from '../modules/localizeInterface';
import type { EndpointManager } from '../modules/manageCustomEndpoints';
import type { CameraObjectDetectionController } from '../modules/detectObjectsFromCamera';
import type { CameraHandTracker } from '../modules/trackHandsFromCamera';
import type { HeadGestureController } from '../modules/recognizeHeadGestures';
import type { RokidImuController } from '../modules/readRokidImuAndProtocol';
import type { ViewingModeController } from '../modules/switchViewingMode';
import type { RemoteNavigationController } from '../modules/navigateRemotely';
import type { CloudEnvironmentController } from '../modules/streamCloudEnvironment';
import type { DiagnosticsMonitor } from '../modules/monitorPerformanceAndBattery';
import type { SpatialAudioBalancer } from '../modules/balanceSpatialAudio';
import type { DetectionClassManager } from '../modules/manageDetectionClasses';
import type { BluetoothGyroController } from '../modules/connectBluetoothGyroController';
import type { SpatialPlacesController } from '../modules/build3dPlacesAndControlPanels';
import { HAND_SKELETON_CONNECTIONS } from '../modules/renderHandDiagnosticOverlay';
import { evaluateGestureScores } from '../modules/trackHandsFromCamera';

export interface SpatialSceneServices {
  translator: InterfaceTranslator;
  endpoints: EndpointManager;
  cameraDetector: CameraObjectDetectionController;
  handTracker: CameraHandTracker;
  headGestures: HeadGestureController;
  rokidImu: RokidImuController;
  viewingMode: ViewingModeController;
  remoteNav: RemoteNavigationController;
  cloudEnv: CloudEnvironmentController;
  placesManager: SpatialPlacesController;
  diagnostics: DiagnosticsMonitor;
  audioBalancer: SpatialAudioBalancer;
  detectionManager: DetectionClassManager;
  btGyroController: BluetoothGyroController;
  getSettings: () => AppSettingsState;
  onUpdateAudioSettings: (patch: Partial<AppSettingsState['audioSettings']>) => void;
  onModeCycleRequest: (next: 'monoscopic' | 'sbs' | '360') => void;
  onPlaceChangeRequest: (place: SpatialPlaceId) => void;
  onPlacePanelTriggered?: () => void;
  onTelemetryTick: (payload: {
    imu: ImuTelemetry;
    headset: HeadsetProfile;
    activeMode: ResolvedViewingMode;
    diagnostics: PerformanceDiagnostics;
    detections: DetectedEntity[];
    hand: CameraHandState;
  }) => void;
  onHeadGestureTriggered: (action: HeadGestureAction) => void;
}

export class SpatialVisionScene extends xb.Script {
  private services: SpatialSceneServices;
  private worldRig = new THREE.Group();
  private handMarker!: THREE.Mesh;
  private handSkeletonGroup = new THREE.Group();
  private handJointsMesh!: THREE.InstancedMesh;
  private handBonesLine!: THREE.LineSegments;
  private handBonePositions = new Float32Array(HAND_SKELETON_CONNECTIONS.length * 2 * 3);
  private readonly _jointMatrix = new THREE.Matrix4();
  private readonly _jointScale = new THREE.Vector3();
  private readonly _jointQuat = new THREE.Quaternion();
  private readonly _jointPos = new THREE.Vector3();
  private readonly _tmpLandmarkWorld: THREE.Vector3[] = Array.from(
    { length: 21 },
    () => new THREE.Vector3()
  );
  private objectTagsGroup = new THREE.Group();

  private spatialCard!: xb.UICard;
  private cardTitle!: xb.UIText;
  private cardTelemetry!: xb.UIText;
  private cardVisionText!: xb.UIText;
  private btnMono!: xb.UIButton;
  private btnSbs!: xb.UIButton;
  private btn360!: xb.UIButton;
  private btnScan!: xb.UIButton;

  private audioCard!: xb.UICard;
  private audioCardTitle!: xb.UIText;
  private audioStatusText!: xb.UIText;
  private audioBalanceSlider!: xb.UISlider;
  private audioGainSlider!: xb.UISlider;
  private audioTestBtn!: xb.UIButton;

  private webcamCard!: xb.UICard;
  private webcamCardTitle!: xb.UIText;
  private webcamImage!: xb.UIImage;
  private webcamTexture: THREE.VideoTexture | null = null;

  private btLaserGroup = new THREE.Group();
  private btControllerBody!: THREE.Mesh;
  private btControllerRing!: THREE.Mesh;
  private btLaserBeam!: THREE.Mesh;
  private btLaserCoreLine!: THREE.Line;
  private btLaserDot!: THREE.Mesh;
  private btRaycaster = new THREE.Raycaster();
  private prevBtTrigger = false;

  private readonly _tmpCamPos = new THREE.Vector3();
  private readonly _tmpCamEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly _tmpYawQuat = new THREE.Quaternion();
  private readonly _tmpGyroQuat = new THREE.Quaternion();
  private readonly _tmpOffset = new THREE.Vector3();
  private readonly _tmpTipWorld = new THREE.Vector3();
  private readonly _tmpBeamDir = new THREE.Vector3();
  private readonly _yAxis = new THREE.Vector3(0, 1, 0);

  private lastMlRunAt = 0;
  private latestDetections: DetectedEntity[] = [];
  private latestHand: CameraHandState = {
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
  private mlBusy = false;
  private lastUiSyncAt = 0;
  private headsetProfile: HeadsetProfile = 'desktop_monitor';

  constructor(services: SpatialSceneServices) {
    super();
    this.services = services;
    this.worldRig.name = 'NavigableWorldRig';
    this.add(this.worldRig);
  }

  init(): void {
    const {
      cloudEnv,
      viewingMode,
      rokidImu,
      translator,
      getSettings,
      endpoints,
    } = this.services;

    const settings = getSettings();
    this.headsetProfile = rokidImu.detectHeadsetProfile();
    viewingMode.setIpdMm(settings.ipdMm);
    viewingMode.setMode(settings.viewingMode, this.headsetProfile);
    viewingMode.attach360Dome(cloudEnv.domeMesh);

    this.worldRig.add(cloudEnv.rootGroup);
    this.worldRig.add(this.services.placesManager.rootGroup);
    this.services.placesManager.setActivePlace(settings.activeScenePlace);
    cloudEnv.setBaseLabVisible(settings.activeScenePlace === 'calibration_lab');

    const renderer = xb.core.renderer as unknown as THREE.WebGLRenderer;
    const scene = xb.core.scene as THREE.Scene;
    if (renderer && scene) {
      cloudEnv.initEnvironment(renderer, scene);
    }
    cloudEnv.setCloudStream(
      settings.cloudRenderEnabled,
      endpoints.getActiveByType('cloud_render')
    );

    // 3D-маркер точки щипка и 21-точечный пространственный скелет кисти
    const handGeo = new THREE.SphereGeometry(0.022, 16, 12);
    const handMat = new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      emissive: 0x0369a1,
      roughness: 0.25,
      metalness: 0.5,
    });
    this.handMarker = new THREE.Mesh(handGeo, handMat);
    this.handMarker.visible = false;
    this.handMarker.xb = { pointerEvents: 'none' };
    this.add(this.handMarker);

    const jointGeo = new THREE.SphereGeometry(0.011, 12, 10);
    const jointMat = new THREE.MeshStandardMaterial({
      color: 0xfacc15,
      emissive: 0x0ea5e9,
      emissiveIntensity: 0.35,
      roughness: 0.3,
    });
    this.handJointsMesh = new THREE.InstancedMesh(jointGeo, jointMat, 21);
    this.handJointsMesh.xb = { pointerEvents: 'none' };

    const bonesGeo = new THREE.BufferGeometry();
    bonesGeo.setAttribute(
      'position',
      new THREE.BufferAttribute(this.handBonePositions, 3)
    );
    const bonesMat = new THREE.LineBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.9,
    });
    this.handBonesLine = new THREE.LineSegments(bonesGeo, bonesMat);
    this.handBonesLine.xb = { pointerEvents: 'none' };

    this.handSkeletonGroup.name = 'HandDiagnostic3DSkeleton';
    this.handSkeletonGroup.xb = { pointerEvents: 'none' };
    this.handSkeletonGroup.visible = false;
    this.handSkeletonGroup.add(this.handJointsMesh, this.handBonesLine);
    this.add(this.handSkeletonGroup);

    this.objectTagsGroup.name = 'DetectedObjectMarkers';
    this.add(this.objectTagsGroup);

    this.buildSpatialCard(translator);
    this.buildAudioSettingsCard(translator, settings);
    this.buildWebcamPreviewCard(translator);
    this.buildBtLaserPointer();

    // Подключение встроенного распознавателя жестов головы XR Blocks
    const xbHeadGestures = xb.core.input.headGestures;
    if (xbHeadGestures) {
      xbHeadGestures.addEventListener('gesture', (ev) => {
        const name = ev.detail?.name;
        if (name) {
          this.services.headGestures.triggerFromXRBlocks(name);
        }
      });
    }

    this.services.headGestures.onGesture((action) => {
      this.services.onHeadGestureTriggered(action);
    });

    translator.subscribe(() => {
      this.refreshSpatialCardLocalization();
    });
  }

  private buildSpatialCard(translator: InterfaceTranslator): void {
    this.cardTitle = new xb.UIText({
      text: translator.t('app.title'),
      style: { fontSize: 26, fontWeight: 'bold', textAlign: 'center' },
    });

    this.cardTelemetry = new xb.UIText({
      text: 'IMU: Ready | Mode: Auto',
      style: {
        fontSize: 16,
        opacity: 0.85,
        textAlign: 'center',
        whiteSpace: 'pre-line',
      },
    });

    this.cardVisionText = new xb.UIText({
      text: translator.t('vision.noObjects'),
      style: {
        fontSize: 15,
        padding: 10,
        backgroundColor: 'rgba(15, 23, 42, 0.72)',
        borderRadius: 12,
        whiteSpace: 'pre-line',
      },
    });

    this.btnMono = new xb.UIButton({
      label: 'Mono',
      style: { flexGrow: 1 },
      onClick: () => this.services.onModeCycleRequest('monoscopic'),
    });
    this.btnSbs = new xb.UIButton({
      label: 'SBS 3D',
      style: { flexGrow: 1 },
      onClick: () => this.services.onModeCycleRequest('sbs'),
    });
    this.btn360 = new xb.UIButton({
      label: '360°',
      style: { flexGrow: 1 },
      onClick: () => this.services.onModeCycleRequest('360'),
    });
    this.btnScan = new xb.UIButton({
      label: translator.t('vision.scanNow'),
      icon: 'radar',
      style: { width: '100%' },
      onClick: () => void this.runXrWorldScan(),
    });

    const placeSwitcherRow = new xb.UIPanel({
      style: { width: '100%', flexDirection: 'row', gap: 6 },
      children: [
        new xb.UIButton({
          label: 'Lab',
          style: { flexGrow: 1 },
          onClick: () => this.services.onPlaceChangeRequest('calibration_lab'),
        }),
        new xb.UIButton({
          label: 'DC',
          style: { flexGrow: 1 },
          onClick: () => this.services.onPlaceChangeRequest('datacenter'),
        }),
        new xb.UIButton({
          label: 'Ship',
          style: { flexGrow: 1 },
          onClick: () => this.services.onPlaceChangeRequest('spaceship'),
        }),
        new xb.UIButton({
          label: 'Plane',
          style: { flexGrow: 1 },
          onClick: () => this.services.onPlaceChangeRequest('airplane'),
        }),
        new xb.UIButton({
          label: 'Room',
          style: { flexGrow: 1 },
          onClick: () => this.services.onPlaceChangeRequest('cyber_lounge'),
        }),
      ],
    });

    this.spatialCard = new xb.UICard({
      size: { width: 0.72, height: 'auto' },
      manipulation: true,
      edge: true,
      style: { flexDirection: 'column', gap: 12, padding: 18 },
      children: [
        new xb.UIExitButton(),
        this.cardTitle,
        this.cardTelemetry,
        new xb.UIPanel({
          style: { width: '100%', flexDirection: 'row', gap: 8 },
          children: [this.btnMono, this.btnSbs, this.btn360],
        }),
        placeSwitcherRow,
        this.cardVisionText,
        this.btnScan,
      ],
    });
    this.spatialCard.name = 'Rokid Spatial Control Card';
    this.spatialCard.position.set(-0.18, 1.84, -1.36);
    this.spatialCard.rotation.x = 0.08;
    this.add(this.spatialCard);
  }

  private buildAudioSettingsCard(
    translator: InterfaceTranslator,
    settings: AppSettingsState
  ): void {
    const audio = settings.audioSettings;
    this.audioCardTitle = new xb.UIText({
      text: translator.t('audio.title'),
      style: { fontSize: 22, fontWeight: 'bold', textAlign: 'center' },
    });

    this.audioStatusText = new xb.UIText({
      text: `${audio.attenuationModel.toUpperCase()} • Gain ${Math.round(audio.masterGain * 100)}% • Pan ${Math.round(audio.spatialBalance * 100)}%`,
      style: { fontSize: 15, opacity: 0.82, textAlign: 'center' },
    });

    this.audioBalanceSlider = new xb.UISlider({
      ariaLabel: translator.t('audio.spatialBalance'),
      min: -1,
      max: 1,
      step: 0.05,
      value: audio.spatialBalance,
      style: { width: '100%', height: 36 },
      onInput: (val) => {
        this.services.onUpdateAudioSettings({ spatialBalance: val });
        this.refreshAudioCardSummary();
      },
    });

    this.audioGainSlider = new xb.UISlider({
      ariaLabel: translator.t('audio.masterGain'),
      min: 0,
      max: 2,
      step: 0.05,
      value: audio.masterGain,
      style: { width: '100%', height: 36 },
      onInput: (val) => {
        this.services.onUpdateAudioSettings({ masterGain: val });
        this.refreshAudioCardSummary();
      },
    });

    this.audioTestBtn = new xb.UIButton({
      label: translator.t('audio.testSpatial'),
      icon: 'volume_up',
      style: { width: '100%' },
      onClick: () => void this.services.audioBalancer.playSpatialTestTone(),
    });

    this.audioCard = new xb.UICard({
      size: { width: 0.54, height: 'auto' },
      manipulation: true,
      edge: true,
      style: { flexDirection: 'column', gap: 10, padding: 16 },
      children: [
        this.audioCardTitle,
        this.audioStatusText,
        new xb.UIPanel({
          style: { width: '100%', flexDirection: 'row', gap: 6 },
          children: [
            new xb.UIButton({
              label: 'Lin',
              style: { flexGrow: 1 },
              onClick: () => {
                this.services.onUpdateAudioSettings({ attenuationModel: 'linear' });
                this.refreshAudioCardSummary();
              },
            }),
            new xb.UIButton({
              label: 'Inv',
              style: { flexGrow: 1 },
              onClick: () => {
                this.services.onUpdateAudioSettings({ attenuationModel: 'inverse' });
                this.refreshAudioCardSummary();
              },
            }),
            new xb.UIButton({
              label: 'Exp',
              style: { flexGrow: 1 },
              onClick: () => {
                this.services.onUpdateAudioSettings({ attenuationModel: 'exponential' });
                this.refreshAudioCardSummary();
              },
            }),
          ],
        }),
        this.audioBalanceSlider,
        this.audioGainSlider,
        this.audioTestBtn,
      ],
    });
    this.audioCard.name = 'Audio Settings Card';
    this.audioCard.position.set(0.84, 1.62, -1.16);
    this.audioCard.rotation.y = -0.35;
    this.add(this.audioCard);
  }

  private refreshAudioCardSummary(): void {
    const audio = this.services.getSettings().audioSettings;
    this.audioStatusText.text = `${audio.attenuationModel.toUpperCase()} • Gain ${Math.round(audio.masterGain * 100)}% • Pan ${Math.round(audio.spatialBalance * 100)}%`;
  }

  public syncAudioCard(audio: AppSettingsState['audioSettings']): void {
    if (!this.audioStatusText) return;
    this.audioBalanceSlider.value = audio.spatialBalance;
    this.audioGainSlider.value = audio.masterGain;
    this.refreshAudioCardSummary();
  }

  private buildWebcamPreviewCard(translator: InterfaceTranslator): void {
    const video = this.services.cameraDetector.getVideoElement();
    this.webcamTexture = new THREE.VideoTexture(video);
    this.webcamTexture.colorSpace = THREE.SRGBColorSpace;
    this.webcamTexture.minFilter = THREE.LinearFilter;
    this.webcamTexture.magFilter = THREE.LinearFilter;

    this.webcamCardTitle = new xb.UIText({
      text: translator.t('vision.cameraFeed'),
      style: { fontSize: 18, fontWeight: 'bold', textAlign: 'center' },
    });

    this.webcamImage = new xb.UIImage({
      src: this.webcamTexture,
      ariaLabel: 'Live Webcam Feed',
      pointerEvents: 'none',
      style: {
        width: '100%',
        height: 210,
        objectFit: 'cover',
        borderRadius: 12,
        backgroundColor: '#020617',
      },
    });

    this.webcamCard = new xb.UICard({
      size: { width: 0.56, height: 'auto' },
      manipulation: true,
      edge: true,
      style: { flexDirection: 'column', gap: 10, padding: 14 },
      children: [this.webcamCardTitle, this.webcamImage],
    });
    this.webcamCard.name = '3D Spatial Webcam Card';
    this.webcamCard.position.set(-0.98, 1.62, -1.16);
    this.webcamCard.rotation.y = 0.35;
    this.webcamCard.visible = false;
    this.add(this.webcamCard);
  }

  private buildBtLaserPointer(): void {
    this.btLaserGroup.name = 'BTGyroLaserPointer';
    this.btLaserGroup.xb = { pointerEvents: 'none' };
    this.btLaserGroup.visible = false;

    // Корпус 3DoF Bluetooth-контроллера
    const bodyGeo = new THREE.CylinderGeometry(0.015, 0.019, 0.125, 16);
    bodyGeo.rotateX(Math.PI / 2);
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0x0f172a,
      roughness: 0.35,
      metalness: 0.65,
    });
    this.btControllerBody = new THREE.Mesh(bodyGeo, bodyMat);
    this.btControllerBody.xb = { pointerEvents: 'none' };

    const ringGeo = new THREE.TorusGeometry(0.017, 0.003, 10, 24);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8 });
    this.btControllerRing = new THREE.Mesh(ringGeo, ringMat);
    this.btControllerRing.position.z = -0.058;
    this.btControllerRing.xb = { pointerEvents: 'none' };

    // Объемный лазерный луч: направлен вдоль -Z от кончика контроллера
    const beamGeo = new THREE.CylinderGeometry(0.0022, 0.0042, 1, 10, 1, true);
    beamGeo.rotateX(Math.PI / 2);
    beamGeo.translate(0, 0, -0.5);
    const beamMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.65,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.btLaserBeam = new THREE.Mesh(beamGeo, beamMat);
    this.btLaserBeam.position.z = -0.065;
    this.btLaserBeam.xb = { pointerEvents: 'none' };

    // Внутренний яркий сердечник луча
    const lineGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, -1),
    ]);
    const lineMat = new THREE.LineBasicMaterial({
      color: 0xe0f2fe,
      transparent: true,
      opacity: 0.95,
    });
    this.btLaserCoreLine = new THREE.Line(lineGeo, lineMat);
    this.btLaserCoreLine.position.z = -0.065;
    this.btLaserCoreLine.xb = { pointerEvents: 'none' };

    // Светящаяся точка-прицел на пересечении луча со сценой
    const dotGeo = new THREE.SphereGeometry(0.014, 16, 12);
    const dotMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
    });
    this.btLaserDot = new THREE.Mesh(dotGeo, dotMat);
    this.btLaserDot.position.z = -3.0;
    this.btLaserDot.xb = { pointerEvents: 'none' };

    this.btLaserGroup.add(
      this.btControllerBody,
      this.btControllerRing,
      this.btLaserBeam,
      this.btLaserCoreLine,
      this.btLaserDot
    );
    this.add(this.btLaserGroup);
  }

  private refreshSpatialCardLocalization(): void {
    const { translator } = this.services;
    this.cardTitle.text = translator.t('app.title');
    this.btnScan.label = translator.t('vision.scanNow');
    this.audioCardTitle.text = translator.t('audio.title');
    this.audioTestBtn.label = translator.t('audio.testSpatial');
    if (this.webcamCardTitle) {
      this.webcamCardTitle.text = translator.t('vision.cameraFeed');
    }
  }

  public async runXrWorldScan(): Promise<void> {
    try {
      const worldObjects = xb.world?.objects;
      if (!worldObjects) return;
      const found = await worldObjects.runDetection();
      if (found && found.length > 0) {
        const mapped: DetectedEntity[] = found.map((obj, idx) => ({
          id: `xb-${idx}-${obj.label}`,
          label: obj.label,
          score: 0.92,
          bbox: [0.3, 0.3, 0.7, 0.7],
          worldPosition: [obj.position.x, obj.position.y, obj.position.z],
          source: 'xrblocks',
        }));
        const settings = this.services.getSettings();
        this.latestDetections = this.services.detectionManager.filterEntities(
          settings.detectionObjects,
          mapped
        );
      }
    } catch {
      // На устройствах без глубины/камеры XR сканирование пропускается без сбоя
    }
  }

  update(): void {
    const delta = xb.getDeltaTime();
    const elapsed = performance.now() / 1000;
    const camera = xb.core.camera as THREE.PerspectiveCamera;
    const renderer = xb.core.renderer as unknown as THREE.WebGLRenderer;
    const scene = xb.core.scene as THREE.Scene;
    const settings = this.services.getSettings();

    // 1. Обновляем окружение, активную 3D-локацию и удаленную навигацию
    this.services.cloudEnv.update(elapsed);
    this.services.placesManager.update(elapsed, delta);
    this.services.remoteNav.update(delta, this.worldRig);

    // 2. Обновляем IMU, слушателя Web Audio и распознавание жестов головы
    if (camera) {
      this.services.audioBalancer.updateListenerFromCamera(camera);
    }
    const imu = camera
      ? this.services.rokidImu.updateFromCamera(
          camera,
          settings.imuStabilizationStrength,
          settings.ipdMm
        )
      : this.services.rokidImu.getTelemetry();

    this.services.headGestures.pushOrientation(
      imu.eulerDeg,
      settings.headGesturesEnabled
    );

    // 3. Обновляем диагностику FPS/рендерера
    this.services.diagnostics.tickFrame(renderer);

    // 4. Запускаем ML-пайплайн камеры (~12 Гц, без блокировки рендер-потока)
    const now = performance.now();
    if (
      !this.mlBusy &&
      now - this.lastMlRunAt > 85 &&
      this.services.cameraDetector.isCameraActive()
    ) {
      this.lastMlRunAt = now;
      this.mlBusy = true;
      void this.runCameraMlStep(settings, imu.latencyMs).finally(() => {
        this.mlBusy = false;
      });
    }

    // 5. Обновляем 3D-маркер и 21-точечный 3D-скелет руки из камеры
    if (this.latestHand.detected && this.latestHand.landmarks.length >= 21) {
      const mirror = settings.webcamMirror;
      const tip = this.latestHand.landmarks[8];
      const tipX = mirror ? 1 - tip.x : tip.x;
      this.handMarker.visible = true;
      this.handMarker.position.set(
        (0.5 - tipX) * 1.1,
        1.45 + (0.5 - tip.y) * 0.8,
        -0.9 - tip.z * 0.5
      );
      const mat = this.handMarker.material as THREE.MeshStandardMaterial;
      mat.color.setHex(this.latestHand.pinching ? 0x22c55e : 0x38bdf8);
      this.handMarker.scale.setScalar(this.latestHand.pinching ? 1.45 : 1.0);

      // Обновляем 21 сустав и кости скелета в 3D-пространстве
      this.handSkeletonGroup.visible = settings.handDiagnosticOverlayEnabled;
      if (this.handSkeletonGroup.visible) {
        for (let i = 0; i < 21; i++) {
          const lm = this.latestHand.landmarks[i];
          const lx = mirror ? 1 - lm.x : lm.x;
          this._jointPos.set(
            (0.5 - lx) * 1.1,
            1.45 + (0.5 - lm.y) * 0.8,
            -0.9 - lm.z * 0.5
          );
          this._tmpLandmarkWorld[i].copy(this._jointPos);
          const s = i === 0 ? 1.35 : i === 4 || i === 8 ? 1.2 : 0.85;
          this._jointScale.setScalar(s);
          this._jointMatrix.compose(this._jointPos, this._jointQuat, this._jointScale);
          this.handJointsMesh.setMatrixAt(i, this._jointMatrix);
        }
        this.handJointsMesh.instanceMatrix.needsUpdate = true;

        let offset = 0;
        for (const conn of HAND_SKELETON_CONNECTIONS) {
          const a = this._tmpLandmarkWorld[conn.from];
          const b = this._tmpLandmarkWorld[conn.to];
          this.handBonePositions[offset++] = a.x;
          this.handBonePositions[offset++] = a.y;
          this.handBonePositions[offset++] = a.z;
          this.handBonePositions[offset++] = b.x;
          this.handBonePositions[offset++] = b.y;
          this.handBonePositions[offset++] = b.z;
        }
        const posAttr = this.handBonesLine.geometry.getAttribute(
          'position'
        ) as THREE.BufferAttribute;
        posAttr.needsUpdate = true;
        (this.handBonesLine.material as THREE.LineBasicMaterial).color.setHex(
          this.latestHand.pinching ? 0x22c55e : 0x38bdf8
        );
      }
    } else {
      this.handMarker.visible = false;
      this.handSkeletonGroup.visible = false;
    }

    // 6. Если активен режим SBS 3D Stereo вне нативной WebXR-сессии — рендерим стереопару
    if (renderer && scene && camera) {
      this.services.viewingMode.renderSBSIfActive(renderer, scene, camera);
    }

    // 6b. Обновляем 3D-экран веб-камеры при активном потоке
    if (this.webcamCard && this.webcamTexture) {
      const camActive = this.services.cameraDetector.isCameraActive();
      const show3d = camActive && settings.webcam3dPreviewEnabled;
      this.webcamCard.visible = show3d;
      if (show3d) {
        const videoEl = this.services.cameraDetector.getVideoElement();
        if (videoEl.readyState >= 2) {
          this.webcamTexture.repeat.x = settings.webcamMirror ? -1 : 1;
          this.webcamTexture.offset.x = settings.webcamMirror ? 1 : 0;
          this.webcamTexture.needsUpdate = true;
        }
      }
    }

    // 6c. Обновляем Bluetooth гироскопический контроллер и 3D лазерный луч
    this.updateBtControllerLaser(delta, camera, settings);

    // 7. Периодически обновляем пространственную карточку и 2D HUD (~5 Гц)
    if (now - this.lastUiSyncAt > 200) {
      this.lastUiSyncAt = now;
      const diag = this.services.diagnostics.getSnapshot();
      const activeMode = this.services.viewingMode.getActiveMode();

      const placeSnap = this.services.placesManager.getPanelSnapshot();

      this.cardTelemetry.text =
        `${this.headsetProfile.toUpperCase()} • ${activeMode.toUpperCase()} • ${diag.fps} FPS\n` +
        `IMU (${imu.source}): Y ${imu.eulerDeg.yaw}° P ${imu.eulerDeg.pitch}° R ${imu.eulerDeg.roll}°\n` +
        `${placeSnap.statusLine}`;

      if (this.latestDetections.length > 0) {
        this.cardVisionText.text = this.latestDetections
          .slice(0, 4)
          .map((d) => `• ${d.label} (${Math.round(d.score * 100)}%)`)
          .join('\n');
      } else {
        this.cardVisionText.text = this.services.translator.t('vision.noObjects');
      }

      this.services.onTelemetryTick({
        imu,
        headset: this.headsetProfile,
        activeMode,
        diagnostics: diag,
        detections: this.latestDetections,
        hand: this.latestHand,
      });
    }
  }

  private async runCameraMlStep(
    settings: AppSettingsState,
    imuLatencyMs: number
  ): Promise<void> {
    let totalMlMs = 0;

    if (settings.cameraObjectDetectionEnabled) {
      const visionEp = this.services.endpoints.getActiveByType('vision');
      const detRes = await this.services.cameraDetector.detectFrame(visionEp);
      this.latestDetections = this.services.detectionManager.filterEntities(
        settings.detectionObjects,
        detRes.entities
      );
      totalMlMs += detRes.inferenceMs;
    } else {
      this.latestDetections = [];
    }

    if (settings.cameraHandTrackingEnabled) {
      const video = this.services.cameraDetector.getVideoElement();
      this.latestHand = await this.services.handTracker.trackFrame(video);
      totalMlMs += this.latestHand.inferenceMs;
    }

    this.services.diagnostics.setLatencies(totalMlMs, imuLatencyMs);
  }

  private updateBtControllerLaser(
    delta: number,
    camera: THREE.PerspectiveCamera | undefined,
    settings: AppSettingsState
  ): void {
    const gyroState = this.services.btGyroController.update(delta);
    const showLaser = gyroState.connected && settings.btLaserBeamEnabled && Boolean(camera);
    this.btLaserGroup.visible = showLaser;

    if (!showLaser || !camera) {
      this.prevBtTrigger = gyroState.triggerPressed;
      return;
    }

    camera.getWorldPosition(this._tmpCamPos);
    this._tmpCamEuler.setFromQuaternion(camera.quaternion, 'YXZ');
    this._tmpYawQuat.setFromAxisAngle(this._yAxis, this._tmpCamEuler.y);

    // Позиционируем виртуальную руку контроллера справа-внизу относительно взгляда
    this._tmpOffset
      .set(0.24, -0.2, -0.42)
      .applyQuaternion(this._tmpYawQuat)
      .add(this._tmpCamPos);
    this.btLaserGroup.position.copy(this._tmpOffset);

    this.services.btGyroController.getThreeQuaternion(this._tmpGyroQuat);
    this.btLaserGroup.quaternion.copy(this._tmpYawQuat).multiply(this._tmpGyroQuat);

    // Запускаем луч Raycaster из кончика контроллера вдоль локальной оси -Z
    this._tmpTipWorld.set(0, 0, -0.065).applyMatrix4(this.btLaserGroup.matrixWorld);
    this._tmpBeamDir
      .set(0, 0, -1)
      .applyQuaternion(this.btLaserGroup.quaternion)
      .normalize();

    this.btRaycaster.set(this._tmpTipWorld, this._tmpBeamDir);
    this.btRaycaster.near = 0.05;
    this.btRaycaster.far = 8.0;

    const targets: THREE.Object3D[] = [
      this.spatialCard,
      this.audioCard,
      this.services.cloudEnv.rootGroup,
      this.services.placesManager.rootGroup,
    ];
    if (this.webcamCard?.visible) targets.push(this.webcamCard);

    const hits = this.btRaycaster.intersectObjects(targets, true);
    const hit = hits.find((h) => this.isAncestryVisible(h.object));
    const beamLength = hit ? Math.max(0.15, hit.distance) : 6.0;

    this.btLaserBeam.scale.set(1, 1, beamLength);
    this.btLaserCoreLine.scale.set(1, 1, beamLength);
    this.btLaserDot.position.set(0, 0, -0.065 - beamLength);
    this.btLaserDot.visible = Boolean(hit);
    this.btLaserDot.scale.setScalar(gyroState.triggerPressed ? 1.45 : 1.0);

    const beamColor = gyroState.triggerPressed
      ? 0x22c55e
      : hit
        ? 0x38bdf8
        : 0x0ea5e9;
    (this.btLaserBeam.material as THREE.MeshBasicMaterial).color.setHex(beamColor);
    (this.btControllerRing.material as THREE.MeshBasicMaterial).color.setHex(beamColor);
    (this.btLaserDot.material as THREE.MeshBasicMaterial).color.setHex(beamColor);

    let hitLabel: string | null = null;
    if (hit) {
      let cur: THREE.Object3D | null = hit.object;
      while (cur && !cur.name) {
        cur = cur.parent;
      }
      hitLabel = cur?.name || '3D Object';
    }
    this.services.btGyroController.setLaserHitInfo(
      hitLabel,
      hit ? Number(hit.distance.toFixed(2)) : null
    );

    // Обработка нажатия курка BT-контроллера по элементам UI и кнопкам 3D-пультов
    if (gyroState.triggerPressed && !this.prevBtTrigger && hit) {
      this.triggerLaserClick(hit.object);
    }
    this.prevBtTrigger = gyroState.triggerPressed;
  }

  private isAncestryVisible(object: THREE.Object3D | null): boolean {
    let cur: THREE.Object3D | null = object;
    while (cur) {
      if (!cur.visible) return false;
      cur = cur.parent;
    }
    return true;
  }

  onSelectStart(event: {
    target?: THREE.Object3D;
    intersection?: THREE.Intersection;
    stopPropagation?: () => void;
  }): void {
    const candidate = event.target ?? event.intersection?.object ?? null;
    if (!candidate || !this.isAncestryVisible(candidate)) return;

    let cur: THREE.Object3D | null = candidate;
    while (cur) {
      const actionId = cur.userData?.panelActionId;
      if (typeof actionId === 'string') {
        if (this.services.placesManager.triggerPanelAction(actionId)) {
          this.services.onPlacePanelTriggered?.();
          event.stopPropagation?.();
        }
        return;
      }
      cur = cur.parent;
    }
  }

  private triggerLaserClick(object: THREE.Object3D): void {
    let cur: THREE.Object3D | null = object;
    while (cur) {
      const actionId = cur.userData?.panelActionId;
      if (typeof actionId === 'string') {
        if (this.services.placesManager.triggerPanelAction(actionId)) {
          this.services.onPlacePanelTriggered?.();
        }
        return;
      }
      if (cur instanceof xb.UIButton && typeof cur.onClick === 'function') {
        cur.onClick();
        return;
      }
      cur = cur.parent;
    }
  }

  dispose(): void {
    this.handMarker.geometry.dispose();
    (this.handMarker.material as THREE.Material).dispose();
    this.handJointsMesh.geometry.dispose();
    (this.handJointsMesh.material as THREE.Material).dispose();
    this.handBonesLine.geometry.dispose();
    (this.handBonesLine.material as THREE.Material).dispose();
    this.btControllerBody.geometry.dispose();
    (this.btControllerBody.material as THREE.Material).dispose();
    this.btControllerRing.geometry.dispose();
    (this.btControllerRing.material as THREE.Material).dispose();
    this.btLaserBeam.geometry.dispose();
    (this.btLaserBeam.material as THREE.Material).dispose();
    this.btLaserCoreLine.geometry.dispose();
    (this.btLaserCoreLine.material as THREE.Material).dispose();
    this.btLaserDot.geometry.dispose();
    (this.btLaserDot.material as THREE.Material).dispose();
    this.webcamTexture?.dispose();
    this.webcamTexture = null;
    this.services.cameraDetector.dispose();
    this.services.handTracker.dispose();
    this.services.rokidImu.dispose();
    this.services.remoteNav.dispose();
    this.services.cloudEnv.dispose();
    this.services.placesManager.dispose();
    this.services.diagnostics.dispose();
    this.services.audioBalancer.dispose();
    this.services.btGyroController.dispose();
  }
}

/**
 * Модуль процедурных 3D-локаций, комнат и интерактивных пультов управления
 * (build3dPlacesAndControlPanels).
 *
 * Назначение:
 * Генерирует и управляет переключаемыми 3D-пространствами без внешних ассетов (Zero 404):
 * 1. `calibration_lab` — Оптическая лаборатория калибровки (базовая сцена по умолчанию);
 * 2. `datacenter` — Серверный зал (42U стойки с мигающими LED на InstancedMesh,
 *    вентиляторы охлаждения и интерактивный пульт управления дата-центром);
 * 3. `spaceship` — Мостик космического корабля (обзорный иллюминатор со звездным полем
 *    и планетой, голографический стол и штурманский пульт управления кораблем);
 * 4. `airplane` — Кабина самолета (стеклянная авионика PFD/ND/EICAS, штурвалы,
 *    РУД и панель автопилота MCP с линией горизонта за окном);
 * 5. `cyber_lounge` — Архитектурный зал с голографическим макетом города на столе.
 *
 * Входные параметры:
 * - setActivePlace(placeId: SpatialPlaceId) — переключение активной 3D-комнаты;
 * - triggerPanelAction(actionId: string) — срабатывание кнопки 3D-пульта (клик/XR/BT-лазер/HUD);
 * - update(elapsedSec: number, delta: number) — анимация элементов и экранов.
 *
 * Выходные данные:
 * - SpatialPlacesController: { rootGroup, setActivePlace, getActivePlace,
 *   triggerPanelAction, getPanelSnapshot, update, dispose }.
 *
 * ЗАГЛУШКА ТЕЛЕМЕТРИИ ПУЛЬТОВ:
 * Показания экранов дата-центра (температура, PUE), корабля (Warp, щиты) и самолета
 * (высота, скорость, тангаж/крен, N1) моделируются локально. В продакшне могут быть
 * привязаны к реальному Prometheus/SNMP API, телеметрии БПЛА/симулятора X-Plane/MSFS.
 */

import * as THREE from 'three';
import type { SpatialPlaceId } from '../types';

export interface SpatialPanelActionInfo {
  id: string;
  label: string;
  active: boolean;
}

export interface SpatialPlaceSnapshot {
  placeId: SpatialPlaceId;
  statusLine: string;
  actions: SpatialPanelActionInfo[];
}

export interface SpatialPlacesController {
  rootGroup: THREE.Group;
  setActivePlace(placeId: SpatialPlaceId): void;
  getActivePlace(): SpatialPlaceId;
  triggerPanelAction(actionId: string): boolean;
  getPanelSnapshot(): SpatialPlaceSnapshot;
  update(elapsedSec: number, delta: number): void;
  dispose(): void;
}

interface PlaceBuilderState {
  group: THREE.Group;
  update: (elapsed: number, delta: number) => void;
  getSnapshot: () => SpatialPlaceSnapshot;
  triggerAction: (actionId: string) => boolean;
}

/** Вспомогательный создатель кликабельной 3D-кнопки для пульта управления */
function createConsoleButton(
  label: string,
  actionId: string,
  colorHex: number,
  disposables: Array<{ dispose(): void }>,
  width = 0.14,
  depth = 0.065
): { mesh: THREE.Mesh; mat: THREE.MeshStandardMaterial } {
  const geo = new THREE.BoxGeometry(width, 0.026, depth);
  const mat = new THREE.MeshStandardMaterial({
    color: colorHex,
    emissive: colorHex,
    emissiveIntensity: 0.35,
    roughness: 0.3,
    metalness: 0.25,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = label;
  mesh.userData.panelActionId = actionId;
  disposables.push(geo, mat);
  return { mesh, mat };
}

/** Создает CanvasTexture c правильным sRGB цветовым пространством */
function createScreenSurface(
  width: number,
  height: number,
  disposables: Array<{ dispose(): void }>
): {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
} {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  disposables.push(texture);
  return { canvas, ctx, texture };
}

export function createSpatialPlacesManager(): SpatialPlacesController {
  const rootGroup = new THREE.Group();
  rootGroup.name = 'SpatialPlacesCollection';

  const disposables: Array<{ dispose(): void }> = [];
  const places = new Map<SpatialPlaceId, PlaceBuilderState>();
  let activePlace: SpatialPlaceId = 'calibration_lab';

  // ==================== 1. ЛАБОРАТОРИЯ КАЛИБРОВКИ ====================
  function buildCalibrationLab(): PlaceBuilderState {
    const group = new THREE.Group();
    group.name = 'PlaceCalibrationLab';
    return {
      group,
      update: () => {},
      getSnapshot: () => ({
        placeId: 'calibration_lab',
        statusLine: 'Optical Gimbal Bench • Local Grid Nominal',
        actions: [],
      }),
      triggerAction: () => false,
    };
  }

  // ==================== 2. ДАТА-ЦЕНТР И ПУЛЬТ УПРАВЛЕНИЯ ====================
  function buildDatacenterPlace(): PlaceBuilderState {
    const group = new THREE.Group();
    group.name = 'PlaceDatacenter';

    let coolingBoost = false;
    let failoverActive = false;
    let rackPowerHigh = true;
    let maintenanceLights = true;
    let lastDrawAt = -1;

    // Антистатический фальшпол
    const floorCanvas = document.createElement('canvas');
    floorCanvas.width = 256;
    floorCanvas.height = 256;
    const fCtx = floorCanvas.getContext('2d')!;
    fCtx.fillStyle = '#0a101d';
    fCtx.fillRect(0, 0, 256, 256);
    fCtx.strokeStyle = '#1e3a5f';
    fCtx.lineWidth = 4;
    fCtx.strokeRect(2, 2, 252, 252);
    fCtx.fillStyle = '#142238';
    for (let x = 24; x < 236; x += 24) {
      for (let y = 24; y < 236; y += 24) {
        fCtx.fillRect(x, y, 8, 8);
      }
    }
    const floorTex = new THREE.CanvasTexture(floorCanvas);
    floorTex.colorSpace = THREE.SRGBColorSpace;
    floorTex.wrapS = THREE.RepeatWrapping;
    floorTex.wrapT = THREE.RepeatWrapping;
    floorTex.repeat.set(12, 12);

    const floorGeo = new THREE.PlaneGeometry(14, 16);
    const floorMat = new THREE.MeshStandardMaterial({
      map: floorTex,
      roughness: 0.55,
      metalness: 0.35,
    });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, 0.01, -2.5);
    floor.xb = { pointerEvents: 'none' };
    group.add(floor);
    disposables.push(floorTex, floorGeo, floorMat);

    // 8 серверных стоек 42U по бокам холодного коридора
    const rackGeo = new THREE.BoxGeometry(0.85, 2.25, 1.05);
    const rackMat = new THREE.MeshStandardMaterial({
      color: 0x0f172a,
      roughness: 0.65,
      metalness: 0.45,
    });
    const trimGeo = new THREE.BoxGeometry(0.04, 2.2, 0.04);
    const trimMat = new THREE.MeshStandardMaterial({
      color: 0x0284c7,
      emissive: 0x0ea5e9,
      emissiveIntensity: 0.65,
      roughness: 0.25,
    });
    disposables.push(rackGeo, rackMat, trimGeo, trimMat);

    const ledPositions: Array<[number, number, number]> = [];
    for (let side = -1; side <= 1; side += 2) {
      for (let i = 0; i < 4; i++) {
        const rack = new THREE.Group();
        const rx = side * 2.15;
        const rz = -0.8 - i * 1.45;
        rack.position.set(rx, 0, rz);

        const body = new THREE.Mesh(rackGeo, rackMat);
        body.position.y = 1.125;
        rack.add(body);

        const trim = new THREE.Mesh(trimGeo, trimMat);
        trim.position.set(-side * 0.43, 1.12, 0.52);
        rack.add(trim);

        group.add(rack);

        // Координаты индикаторов 1U серверов для InstancedMesh
        for (let u = 0; u < 14; u++) {
          ledPositions.push([
            rx - side * 0.435,
            0.3 + u * 0.135,
            rz + (u % 3 - 1) * 0.24,
          ]);
        }
      }
    }

    // Потолочная арка холодного коридора + вращающиеся кулеры
    const ceilingMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      roughness: 0.4,
      metalness: 0.75,
    });
    const archGeo = new THREE.BoxGeometry(3.8, 0.1, 6.2);
    const archMesh = new THREE.Mesh(archGeo, ceilingMat);
    archMesh.position.set(0, 2.75, -3.0);
    group.add(archMesh);
    disposables.push(ceilingMat, archGeo);

    const fans: THREE.Mesh[] = [];
    const fanGeo = new THREE.BoxGeometry(0.45, 0.03, 0.08);
    const fanMat = new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      metalness: 0.8,
      roughness: 0.2,
    });
    disposables.push(fanGeo, fanMat);
    for (let i = 0; i < 3; i++) {
      const fan = new THREE.Mesh(fanGeo, fanMat);
      fan.position.set(0, 2.66, -1.6 - i * 1.5);
      group.add(fan);
      fans.push(fan);
    }

    // Инстансированные LED-индикаторы серверов
    const ledGeo = new THREE.BoxGeometry(0.025, 0.025, 0.06);
    const ledMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const ledsMesh = new THREE.InstancedMesh(ledGeo, ledMat, ledPositions.length);
    ledsMesh.xb = { pointerEvents: 'none' };
    const dummy = new THREE.Object3D();
    const colorTmp = new THREE.Color();
    for (let i = 0; i < ledPositions.length; i++) {
      const [lx, ly, lz] = ledPositions[i];
      dummy.position.set(lx, ly, lz);
      dummy.updateMatrix();
      ledsMesh.setMatrixAt(i, dummy.matrix);
      ledsMesh.setColorAt(i, colorTmp.setHex(i % 5 === 0 ? 0x38bdf8 : 0x22c55e));
    }
    ledsMesh.computeBoundingSphere();
    group.add(ledsMesh);
    disposables.push(ledGeo, ledMat);

    // Освещение коридора
    const dcLight = new THREE.PointLight(0x38bdf8, 3.2, 11);
    dcLight.position.set(0, 2.55, -2.2);
    group.add(dcLight);

    // --- ИНТЕРАКТИВНЫЙ ПУЛЬТ УПРАВЛЕНИЯ ДАТА-ЦЕНТРОМ ---
    const consoleGroup = new THREE.Group();
    consoleGroup.name = 'Datacenter Control Console';
    consoleGroup.position.set(0, 0, -1.35);
    group.add(consoleGroup);

    const pedGeo = new THREE.BoxGeometry(1.18, 0.84, 0.48);
    const pedMat = new THREE.MeshStandardMaterial({
      color: 0x162033,
      roughness: 0.45,
      metalness: 0.72,
    });
    const ped = new THREE.Mesh(pedGeo, pedMat);
    ped.position.y = 0.42;
    consoleGroup.add(ped);

    const deskGeo = new THREE.BoxGeometry(1.36, 0.08, 0.56);
    const deskMat = new THREE.MeshStandardMaterial({
      color: 0x334155,
      roughness: 0.25,
      metalness: 0.85,
    });
    const desk = new THREE.Mesh(deskGeo, deskMat);
    desk.position.set(0, 0.86, 0.04);
    desk.rotation.x = 0.28;
    consoleGroup.add(desk);
    disposables.push(pedGeo, pedMat, deskGeo, deskMat);

    // Монитор NOC на пульте
    const screen = createScreenSurface(640, 320, disposables);
    const scrGeo = new THREE.PlaneGeometry(1.24, 0.62);
    const scrMat = new THREE.MeshBasicMaterial({ map: screen.texture });
    const scrMesh = new THREE.Mesh(scrGeo, scrMat);
    scrMesh.name = 'Datacenter NOC Telemetry Display';
    scrMesh.position.set(0, 1.24, -0.14);
    scrMesh.rotation.x = -0.18;
    consoleGroup.add(scrMesh);

    const frameGeo = new THREE.BoxGeometry(1.3, 0.68, 0.04);
    const frameMesh = new THREE.Mesh(frameGeo, pedMat);
    frameMesh.position.set(0, 1.24, -0.165);
    frameMesh.rotation.x = -0.18;
    consoleGroup.add(frameMesh);
    disposables.push(scrGeo, scrMat, frameGeo);

    // Физические кнопки на столешнице пульта
    const btnCool = createConsoleButton('DC Cooling Boost', 'dc_cooling', 0x0ea5e9, disposables);
    const btnFailover = createConsoleButton('DC Node Failover', 'dc_failover', 0xf59e0b, disposables);
    const btnPower = createConsoleButton('DC Rack Power', 'dc_power', 0x22c55e, disposables);
    const btnLight = createConsoleButton('DC Aisle Lights', 'dc_lights', 0x818cf8, disposables);

    const btns = [btnCool, btnFailover, btnPower, btnLight];
    btns.forEach((b, idx) => {
      b.mesh.position.set(-0.39 + idx * 0.26, 0.91, 0.14);
      b.mesh.rotation.x = 0.28;
      consoleGroup.add(b.mesh);
    });

    function redrawScreen(elapsed: number): void {
      const { ctx, canvas, texture } = screen;
      ctx.fillStyle = '#030816';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.strokeStyle = coolingBoost ? '#22d3ee' : '#38bdf8';
      ctx.lineWidth = 3;
      ctx.strokeRect(8, 8, canvas.width - 16, canvas.height - 16);

      ctx.fillStyle = '#7dd3fc';
      ctx.font = 'bold 24px monospace';
      ctx.fillText('DATACENTER NOC CONTROL PANEL', 24, 44);

      const tempC = coolingBoost
        ? (26.4 + Math.sin(elapsed * 2) * 0.4).toFixed(1)
        : (39.2 + Math.sin(elapsed * 1.5) * 0.8).toFixed(1);
      const pue = coolingBoost ? '1.14' : '1.28';
      const powerKw = rackPowerHigh ? (142.8 + Math.sin(elapsed) * 2.1).toFixed(1) : '64.0';
      const rpm = coolingBoost ? '4800 RPM' : '1950 RPM';

      ctx.font = 'bold 20px monospace';
      ctx.fillStyle = coolingBoost ? '#4ade80' : '#facc15';
      ctx.fillText(`RACK TEMP: ${tempC} °C`, 26, 95);
      ctx.fillStyle = '#e0f2fe';
      ctx.fillText(`CLUSTER: ${failoverActive ? 'NODE-B2 (FAILOVER)' : 'NODE-A1 (PRIMARY)'}`, 26, 130);
      ctx.fillText(`POWER LOAD: ${powerKw} kW  •  PUE: ${pue}`, 26, 165);
      ctx.fillText(`TURBINES: ${rpm}  •  AIRFLOW: ${coolingBoost ? 'TURBO' : 'AUTO'}`, 26, 200);

      // Мини-график нагрузки
      ctx.fillStyle = 'rgba(14, 165, 233, 0.18)';
      ctx.fillRect(26, 224, 588, 66);
      ctx.fillStyle = '#38bdf8';
      for (let b = 0; b < 24; b++) {
        const h =
          18 +
          Math.abs(Math.sin(elapsed * 2.5 + b * 0.45)) *
            (rackPowerHigh ? 42 : 18);
        ctx.fillRect(34 + b * 24, 286 - h, 16, h);
      }

      texture.needsUpdate = true;
    }

    function syncButtonMaterials(): void {
      btnCool.mat.emissiveIntensity = coolingBoost ? 1.4 : 0.3;
      btnFailover.mat.emissiveIntensity = failoverActive ? 1.4 : 0.3;
      btnPower.mat.emissiveIntensity = rackPowerHigh ? 1.3 : 0.25;
      btnLight.mat.emissiveIntensity = maintenanceLights ? 1.3 : 0.2;
      dcLight.intensity = maintenanceLights ? 3.4 : 0.9;
      trimMat.emissive.setHex(coolingBoost ? 0x22d3ee : 0x0ea5e9);
    }

    function triggerAction(actionId: string): boolean {
      if (actionId === 'dc_cooling') coolingBoost = !coolingBoost;
      else if (actionId === 'dc_failover') failoverActive = !failoverActive;
      else if (actionId === 'dc_power') rackPowerHigh = !rackPowerHigh;
      else if (actionId === 'dc_lights') maintenanceLights = !maintenanceLights;
      else return false;
      syncButtonMaterials();
      redrawScreen(performance.now() / 1000);
      return true;
    }

    syncButtonMaterials();
    redrawScreen(0);

    return {
      group,
      update: (elapsed, delta) => {
        const fanSpeed = coolingBoost ? 12.0 : 3.2;
        for (const f of fans) f.rotation.y += fanSpeed * delta;

        // Мерцание серверных индикаторов
        for (let i = 0; i < ledPositions.length; i++) {
          if ((i + Math.floor(elapsed * 8)) % 9 === 0) {
            const on = Math.sin(elapsed * 14 + i) > 0;
            colorTmp.setHex(
              failoverActive && i % 4 === 0
                ? 0xf59e0b
                : on
                  ? 0x22c55e
                  : 0x0f172a
            );
            ledsMesh.setColorAt(i, colorTmp);
          }
        }
        if (ledsMesh.instanceColor) ledsMesh.instanceColor.needsUpdate = true;

        if (elapsed - lastDrawAt > 0.25) {
          lastDrawAt = elapsed;
          redrawScreen(elapsed);
        }
      },
      getSnapshot: () => ({
        placeId: 'datacenter',
        statusLine: `${failoverActive ? 'NODE-B2' : 'NODE-A1'} • ${coolingBoost ? 'TURBO COOL' : 'NORMAL'} • ${rackPowerHigh ? '142 kW' : '64 kW'}`,
        actions: [
          { id: 'dc_cooling', label: 'Cooling Boost', active: coolingBoost },
          { id: 'dc_failover', label: 'Node Failover', active: failoverActive },
          { id: 'dc_power', label: 'High Power', active: rackPowerHigh },
          { id: 'dc_lights', label: 'Aisle Lights', active: maintenanceLights },
        ],
      }),
      triggerAction,
    };
  }

  // ==================== 3. МОСТИК КОСМИЧЕСКОГО КОРАБЛЯ И ПУЛЬТ ====================
  function buildSpaceshipPlace(): PlaceBuilderState {
    const group = new THREE.Group();
    group.name = 'PlaceSpaceshipBridge';

    let warpEngaged = false;
    let shieldsUp = true;
    let redAlert = false;
    let sectorPingAt = 0;
    let lastDrawAt = -1;

    // Палуба мостика
    const deckGeo = new THREE.CylinderGeometry(5.8, 6.2, 0.14, 32);
    const deckMat = new THREE.MeshStandardMaterial({
      color: 0x0d1424,
      roughness: 0.45,
      metalness: 0.75,
    });
    const deck = new THREE.Mesh(deckGeo, deckMat);
    deck.position.set(0, -0.06, -1.2);
    deck.xb = { pointerEvents: 'none' };
    group.add(deck);
    disposables.push(deckGeo, deckMat);

    // Каркасные шпангоуты обзорного купола мостика
    const ribGeo = new THREE.TorusGeometry(4.4, 0.08, 12, 36, Math.PI);
    const ribMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      roughness: 0.3,
      metalness: 0.88,
    });
    for (let i = 0; i < 3; i++) {
      const rib = new THREE.Mesh(ribGeo, ribMat);
      rib.position.set(0, 0.2, -1.5 - i * 1.15);
      rib.xb = { pointerEvents: 'none' };
      group.add(rib);
    }
    disposables.push(ribGeo, ribMat);

    // Планета с кольцом за обзорным иллюминатором
    const planetGeo = new THREE.SphereGeometry(2.2, 32, 24);
    const planetMat = new THREE.MeshStandardMaterial({
      color: 0x1d4ed8,
      emissive: 0x0b1e4d,
      roughness: 0.7,
      metalness: 0.1,
    });
    const planet = new THREE.Mesh(planetGeo, planetMat);
    planet.position.set(4.6, 2.8, -14.5);
    planet.xb = { pointerEvents: 'none' };
    group.add(planet);

    const ringGeo = new THREE.RingGeometry(2.85, 4.1, 48);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x7dd3fc,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.45,
    });
    const planetRing = new THREE.Mesh(ringGeo, ringMat);
    planetRing.position.copy(planet.position);
    planetRing.rotation.set(1.15, 0.35, 0.2);
    planetRing.xb = { pointerEvents: 'none' };
    group.add(planetRing);
    disposables.push(planetGeo, planetMat, ringGeo, ringMat);

    // Поле звезд на InstancedMesh (движутся быстрее при Варп-прыжке)
    const starCount = 260;
    const starGeo = new THREE.BoxGeometry(0.035, 0.035, 0.22);
    const starMat = new THREE.MeshBasicMaterial({ color: 0xe0f2fe });
    const starsMesh = new THREE.InstancedMesh(starGeo, starMat, starCount);
    starsMesh.frustumCulled = false;
    starsMesh.xb = { pointerEvents: 'none' };
    const starSeeds: Array<{ x: number; y: number; z: number; speed: number }> = [];
    const dummy = new THREE.Object3D();
    for (let i = 0; i < starCount; i++) {
      const x = (Math.random() - 0.5) * 24;
      const y = (Math.random() - 0.2) * 14;
      const z = -4 - Math.random() * 22;
      starSeeds.push({ x, y, z, speed: 0.7 + Math.random() * 1.4 });
      dummy.position.set(x, y, z);
      dummy.updateMatrix();
      starsMesh.setMatrixAt(i, dummy.matrix);
    }
    group.add(starsMesh);
    disposables.push(starGeo, starMat);

    // Голографическое ядро щитов/навигации в центре мостика
    const shieldSphereGeo = new THREE.IcosahedronGeometry(0.19, 1);
    const shieldSphereMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      wireframe: true,
      transparent: true,
      opacity: 0.65,
    });
    const holoOrb = new THREE.Mesh(shieldSphereGeo, shieldSphereMat);
    holoOrb.position.set(0, 1.42, -1.95);
    holoOrb.xb = { pointerEvents: 'none' };
    group.add(holoOrb);
    disposables.push(shieldSphereGeo, shieldSphereMat);

    const bridgeLight = new THREE.PointLight(0x38bdf8, 3.0, 12);
    bridgeLight.position.set(0, 2.8, -1.5);
    group.add(bridgeLight);

    // --- ШТУРМАНСКИЙ ПУЛЬТ УПРАВЛЕНИЯ КОСМИЧЕСКИМ КОРАБЛЕМ ---
    const helmGroup = new THREE.Group();
    helmGroup.name = 'Spaceship Helm Control Panel';
    helmGroup.position.set(0, 0, -1.32);
    group.add(helmGroup);

    const helmMat = new THREE.MeshStandardMaterial({
      color: 0x111827,
      roughness: 0.28,
      metalness: 0.88,
    });
    const helmBaseGeo = new THREE.CylinderGeometry(0.62, 0.78, 0.82, 8);
    const helmBase = new THREE.Mesh(helmBaseGeo, helmMat);
    helmBase.position.y = 0.41;
    helmGroup.add(helmBase);

    const helmDeckGeo = new THREE.BoxGeometry(1.52, 0.08, 0.62);
    const helmDeck = new THREE.Mesh(helmDeckGeo, helmMat);
    helmDeck.position.set(0, 0.85, 0.06);
    helmDeck.rotation.x = 0.24;
    helmGroup.add(helmDeck);
    disposables.push(helmMat, helmBaseGeo, helmDeckGeo);

    // Главный тактический экран корабля
    const helmScreen = createScreenSurface(640, 300, disposables);
    const scrGeo = new THREE.PlaneGeometry(1.36, 0.62);
    const scrMat = new THREE.MeshBasicMaterial({ map: helmScreen.texture });
    const scrMesh = new THREE.Mesh(scrGeo, scrMat);
    scrMesh.name = 'Spaceship Tactical Navigation Screen';
    scrMesh.position.set(0, 1.24, -0.14);
    scrMesh.rotation.x = -0.22;
    helmGroup.add(scrMesh);
    disposables.push(scrGeo, scrMat);

    // Рычаг тяги Warp Drive слева на консоли
    const throttleLeverGeo = new THREE.CylinderGeometry(0.014, 0.014, 0.16, 12);
    const throttleMat = new THREE.MeshStandardMaterial({
      color: 0x22d3ee,
      emissive: 0x0891b2,
      metalness: 0.85,
      roughness: 0.2,
    });
    const throttleLever = new THREE.Mesh(throttleLeverGeo, throttleMat);
    throttleLever.position.set(-0.56, 0.94, 0.12);
    throttleLever.name = 'Spaceship Warp Throttle';
    throttleLever.userData.panelActionId = 'ship_warp';
    helmGroup.add(throttleLever);
    disposables.push(throttleLeverGeo, throttleMat);

    const btnWarp = createConsoleButton('Engage Warp Drive', 'ship_warp', 0x06b6d4, disposables);
    const btnShields = createConsoleButton('Toggle Deflectors', 'ship_shields', 0x3b82f6, disposables);
    const btnAlert = createConsoleButton('Red Alert Mode', 'ship_alert', 0xef4444, disposables);
    const btnScan = createConsoleButton('Sector Radar Scan', 'ship_scan', 0xa855f7, disposables);

    [btnWarp, btnShields, btnAlert, btnScan].forEach((b, idx) => {
      b.mesh.position.set(-0.34 + idx * 0.24, 0.91, 0.16);
      b.mesh.rotation.x = 0.24;
      helmGroup.add(b.mesh);
    });

    function redrawScreen(elapsed: number): void {
      const { ctx, canvas, texture } = helmScreen;
      ctx.fillStyle = redAlert ? '#19050a' : '#03091a';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.strokeStyle = redAlert ? '#ef4444' : warpEngaged ? '#22d3ee' : '#38bdf8';
      ctx.lineWidth = 3;
      ctx.strokeRect(8, 8, canvas.width - 16, canvas.height - 16);

      ctx.fillStyle = redAlert ? '#fca5a5' : '#7dd3fc';
      ctx.font = 'bold 23px monospace';
      ctx.fillText('STARSHIP BRIDGE HELM CONTROL', 22, 42);

      ctx.font = 'bold 19px monospace';
      ctx.fillStyle = warpEngaged ? '#22d3ee' : '#e0f2fe';
      ctx.fillText(
        `PROPULSION: ${warpEngaged ? 'WARP FACTOR 8.4 (ENGAGED)' : 'IMPULSE 0.25c'}`,
        22,
        88
      );
      ctx.fillStyle = shieldsUp ? '#4ade80' : '#f87171';
      ctx.fillText(`DEFLECTOR SHIELDS: ${shieldsUp ? 'ONLINE 100%' : 'OFFLINE'}`, 22, 122);
      ctx.fillStyle = redAlert ? '#f87171' : '#cbd5e1';
      ctx.fillText(`ALERT STATUS: ${redAlert ? 'CONDITION RED' : 'CRUISE STANDBY'}`, 22, 156);

      // Радар сектора справа на дисплее
      const rcx = 525;
      const rcy = 178;
      ctx.strokeStyle = redAlert ? 'rgba(248,113,113,0.55)' : 'rgba(56,189,248,0.55)';
      ctx.lineWidth = 1.5;
      for (const r of [28, 56, 84]) {
        ctx.beginPath();
        ctx.arc(rcx, rcy, r, 0, Math.PI * 2);
        ctx.stroke();
      }
      const sweepAng = elapsed * 2.2;
      ctx.beginPath();
      ctx.moveTo(rcx, rcy);
      ctx.lineTo(rcx + Math.cos(sweepAng) * 84, rcy + Math.sin(sweepAng) * 84);
      ctx.stroke();

      if (elapsed - sectorPingAt < 3) {
        ctx.fillStyle = '#4ade80';
        ctx.fillText('SCAN PING: 3 ANOMALIES', 22, 235);
      } else {
        ctx.fillStyle = '#94a3b8';
        ctx.fillText('HEADING: 247.4° MK • PITCH +2.1°', 22, 235);
      }
      texture.needsUpdate = true;
    }

    function syncShipVisuals(): void {
      btnWarp.mat.emissiveIntensity = warpEngaged ? 1.5 : 0.3;
      btnShields.mat.emissiveIntensity = shieldsUp ? 1.3 : 0.2;
      btnAlert.mat.emissiveIntensity = redAlert ? 1.6 : 0.3;
      btnScan.mat.emissiveIntensity = 0.6;
      holoOrb.visible = shieldsUp;
      throttleLever.rotation.x = warpEngaged ? -0.55 : 0.15;
      bridgeLight.color.setHex(redAlert ? 0xef4444 : warpEngaged ? 0x22d3ee : 0x38bdf8);
    }

    function triggerAction(actionId: string): boolean {
      if (actionId === 'ship_warp') warpEngaged = !warpEngaged;
      else if (actionId === 'ship_shields') shieldsUp = !shieldsUp;
      else if (actionId === 'ship_alert') redAlert = !redAlert;
      else if (actionId === 'ship_scan') sectorPingAt = performance.now() / 1000;
      else return false;
      syncShipVisuals();
      redrawScreen(performance.now() / 1000);
      return true;
    }

    syncShipVisuals();
    redrawScreen(0);

    return {
      group,
      update: (elapsed, delta) => {
        const starSpeed = warpEngaged ? 24 : 2.2;
        const streakScale = warpEngaged ? 7.5 : 1.0;
        for (let i = 0; i < starCount; i++) {
          const s = starSeeds[i];
          s.z += s.speed * starSpeed * delta;
          if (s.z > 2) s.z = -24;
          dummy.position.set(s.x, s.y, s.z);
          dummy.scale.set(1, 1, streakScale);
          dummy.updateMatrix();
          starsMesh.setMatrixAt(i, dummy.matrix);
        }
        starsMesh.instanceMatrix.needsUpdate = true;

        planet.rotation.y += 0.04 * delta;
        holoOrb.rotation.y += 0.8 * delta;
        holoOrb.rotation.x = Math.sin(elapsed * 0.7) * 0.25;
        if (redAlert) {
          bridgeLight.intensity = 2.0 + Math.sin(elapsed * 7) * 1.4;
        } else {
          bridgeLight.intensity = 3.0;
        }

        if (elapsed - lastDrawAt > 0.2) {
          lastDrawAt = elapsed;
          redrawScreen(elapsed);
        }
      },
      getSnapshot: () => ({
        placeId: 'spaceship',
        statusLine: `${warpEngaged ? 'WARP 8.4' : 'IMPULSE'} • ${shieldsUp ? 'SHIELDS 100%' : 'SHIELDS OFF'}${redAlert ? ' • RED ALERT' : ''}`,
        actions: [
          { id: 'ship_warp', label: 'Warp Drive', active: warpEngaged },
          { id: 'ship_shields', label: 'Deflector Shields', active: shieldsUp },
          { id: 'ship_alert', label: 'Red Alert', active: redAlert },
          { id: 'ship_scan', label: 'Sector Scan', active: false },
        ],
      }),
      triggerAction,
    };
  }

  // ==================== 4. КАБИНА САМОЛЕТА И ПУЛЬТ АВИОНИКИ ====================
  function buildAirplanePlace(): PlaceBuilderState {
    const group = new THREE.Group();
    group.name = 'PlaceAirplaneCockpit';

    let autopilotOn = true;
    let togaThrust = false;
    let gearDown = false;
    let flapsStep = 0; // 0°, 15°, 30°
    let lastDrawAt = -1;

    // Небосвод с облачным слоем и горизонтом за лобовым стеклом
    const skyScreen = createScreenSurface(512, 256, disposables);
    const sCtx = skyScreen.ctx;
    const skyGrad = sCtx.createLinearGradient(0, 0, 0, 256);
    skyGrad.addColorStop(0, '#0c4a6e');
    skyGrad.addColorStop(0.45, '#38bdf8');
    skyGrad.addColorStop(0.52, '#fed7aa');
    skyGrad.addColorStop(0.54, '#334155');
    skyGrad.addColorStop(1, '#0f172a');
    sCtx.fillStyle = skyGrad;
    sCtx.fillRect(0, 0, 512, 256);
    skyScreen.texture.needsUpdate = true;

    const skyDomeGeo = new THREE.SphereGeometry(22, 32, 20);
    const skyDomeMat = new THREE.MeshBasicMaterial({
      map: skyScreen.texture,
      side: THREE.BackSide,
      depthWrite: false,
    });
    const skyDome = new THREE.Mesh(skyDomeGeo, skyDomeMat);
    skyDome.xb = { pointerEvents: 'none' };
    group.add(skyDome);
    disposables.push(skyDomeGeo, skyDomeMat);

    // Пол кабины и боковые переборки
    const cockpitMat = new THREE.MeshStandardMaterial({
      color: 0x1e2530,
      roughness: 0.7,
      metalness: 0.35,
    });
    const floorGeo = new THREE.BoxGeometry(2.6, 0.1, 2.8);
    const floor = new THREE.Mesh(floorGeo, cockpitMat);
    floor.position.set(0, -0.04, -1.0);
    group.add(floor);

    // Переплеты лобового стекла кабины пилотов
    const strutGeo = new THREE.BoxGeometry(0.06, 1.55, 0.08);
    for (const sx of [-0.95, 0, 0.95]) {
      const strut = new THREE.Mesh(strutGeo, cockpitMat);
      strut.position.set(sx, 1.78, -1.62);
      strut.rotation.x = 0.42;
      group.add(strut);
    }

    // Козырек панели приборов (Glareshield)
    const glareGeo = new THREE.BoxGeometry(1.95, 0.12, 0.55);
    const glare = new THREE.Mesh(glareGeo, cockpitMat);
    glare.position.set(0, 1.38, -1.36);
    group.add(glare);
    disposables.push(cockpitMat, floorGeo, strutGeo, glareGeo);

    // --- ГЛАВНАЯ ПРИБОРНАЯ ПАНЕЛЬ АВИОНИКИ И РУД ---
    const panelGroup = new THREE.Group();
    panelGroup.name = 'Airplane Avionics Control Panel';
    panelGroup.position.set(0, 0, -1.28);
    group.add(panelGroup);

    const mipGeo = new THREE.BoxGeometry(1.84, 0.68, 0.18);
    const mipMat = new THREE.MeshStandardMaterial({
      color: 0x2a3444,
      roughness: 0.55,
      metalness: 0.5,
    });
    const mip = new THREE.Mesh(mipGeo, mipMat);
    mip.position.set(0, 1.0, -0.08);
    mip.rotation.x = -0.18;
    panelGroup.add(mip);

    // Центральный пьедестал РУД
    const pedGeo = new THREE.BoxGeometry(0.56, 0.72, 0.62);
    const ped = new THREE.Mesh(pedGeo, mipMat);
    ped.position.set(0, 0.36, 0.16);
    panelGroup.add(ped);
    disposables.push(mipGeo, mipMat, pedGeo);

    // Стеклянный дисплей PFD / ND / EICAS
    const avionics = createScreenSurface(768, 280, disposables);
    const aviGeo = new THREE.PlaneGeometry(1.68, 0.58);
    const aviMat = new THREE.MeshBasicMaterial({ map: avionics.texture });
    const aviMesh = new THREE.Mesh(aviGeo, aviMat);
    aviMesh.name = 'Airplane Glass Avionics PFD/ND';
    aviMesh.position.set(0, 1.02, 0.02);
    aviMesh.rotation.x = -0.18;
    panelGroup.add(aviMesh);
    disposables.push(aviGeo, aviMat);

    // Два штурвала пилота и второго пилота
    const yokeMat = new THREE.MeshStandardMaterial({
      color: 0x0f172a,
      roughness: 0.45,
      metalness: 0.4,
    });
    const yokeStemGeo = new THREE.CylinderGeometry(0.024, 0.028, 0.34, 12);
    yokeStemGeo.rotateX(Math.PI / 2);
    const yokeBarGeo = new THREE.TorusGeometry(0.11, 0.018, 10, 24, Math.PI * 1.25);
    const yokes: THREE.Group[] = [];
    for (const yx of [-0.52, 0.52]) {
      const yg = new THREE.Group();
      yg.position.set(yx, 0.88, 0.24);
      const stem = new THREE.Mesh(yokeStemGeo, yokeMat);
      stem.position.z = -0.14;
      const bar = new THREE.Mesh(yokeBarGeo, yokeMat);
      bar.rotation.z = -Math.PI * 0.125;
      yg.add(stem, bar);
      panelGroup.add(yg);
      yokes.push(yg);
    }
    disposables.push(yokeMat, yokeStemGeo, yokeBarGeo);

    // Рычаги РУД (Throttle Quadrant) на центральном пьедестале
    const throttleGeo = new THREE.BoxGeometry(0.045, 0.18, 0.045);
    const throttleMat = new THREE.MeshStandardMaterial({
      color: 0xe2e8f0,
      roughness: 0.25,
      metalness: 0.85,
    });
    const thrLeft = new THREE.Mesh(throttleGeo, throttleMat);
    const thrRight = new THREE.Mesh(throttleGeo, throttleMat);
    thrLeft.position.set(-0.07, 0.78, 0.14);
    thrRight.position.set(0.07, 0.78, 0.14);
    thrLeft.name = 'Throttle Lever L';
    thrRight.name = 'Throttle Lever R';
    thrLeft.userData.panelActionId = 'plane_toga';
    thrRight.userData.panelActionId = 'plane_toga';
    panelGroup.add(thrLeft, thrRight);
    disposables.push(throttleGeo, throttleMat);

    // Кнопки автопилота MCP на козырьке
    const btnAp = createConsoleButton('AP Master', 'plane_ap', 0x22c55e, disposables, 0.13, 0.055);
    const btnToga = createConsoleButton('TO/GA Thrust', 'plane_toga', 0xf59e0b, disposables, 0.13, 0.055);
    const btnGear = createConsoleButton('Landing Gear', 'plane_gear', 0x38bdf8, disposables, 0.13, 0.055);
    const btnFlaps = createConsoleButton('Flaps Step', 'plane_flaps', 0xa855f7, disposables, 0.13, 0.055);

    [btnAp, btnToga, btnGear, btnFlaps].forEach((b, idx) => {
      b.mesh.position.set(-0.27 + idx * 0.18, 1.36, 0.06);
      panelGroup.add(b.mesh);
    });

    const cockpitLight = new THREE.PointLight(0xfef3c7, 2.5, 8);
    cockpitLight.position.set(0, 2.0, -0.8);
    group.add(cockpitLight);

    function redrawAvionics(elapsed: number): void {
      const { ctx, canvas, texture } = avionics;
      ctx.fillStyle = '#050a14';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // 1) PFD (Primary Flight Display) слева
      const bank = autopilotOn ? Math.sin(elapsed * 0.4) * 0.05 : Math.sin(elapsed * 1.1) * 0.24;
      ctx.save();
      ctx.beginPath();
      ctx.rect(18, 18, 224, 244);
      ctx.clip();
      ctx.translate(130, 140);
      ctx.rotate(bank);
      ctx.fillStyle = '#0284c7';
      ctx.fillRect(-180, -180, 360, 180);
      ctx.fillStyle = '#78350f';
      ctx.fillRect(-180, 0, 360, 180);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-160, 0);
      ctx.lineTo(160, 0);
      ctx.stroke();
      ctx.restore();

      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 2;
      ctx.strokeRect(18, 18, 224, 244);
      ctx.fillStyle = '#4ade80';
      ctx.font = 'bold 15px monospace';
      ctx.fillText(autopilotOn ? 'CMD A  ALT HOLD' : 'MANUAL FLIGHT', 28, 38);

      const ias = togaThrust ? 318 : gearDown ? 156 : 264;
      const alt = 32400 + Math.round(Math.sin(elapsed * 0.5) * 40);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(`IAS ${ias} KT`, 26, 248);
      ctx.fillText(`ALT ${alt} FT`, 132, 248);

      // 2) ND (Navigation Display) по центру
      ctx.strokeStyle = '#38bdf8';
      ctx.strokeRect(272, 18, 224, 244);
      ctx.beginPath();
      ctx.arc(384, 155, 78, Math.PI, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = '#7dd3fc';
      ctx.fillText('HDG 284° • WPT ROKID', 286, 42);
      ctx.fillStyle = '#e879f9';
      ctx.fillRect(380, 94, 8, 56);

      // 3) EICAS (Двигатели, шасси, закрылки) справа
      ctx.strokeStyle = '#38bdf8';
      ctx.strokeRect(526, 18, 224, 244);
      const n1 = togaThrust ? '97.4%' : '74.2%';
      const egt = togaThrust ? '862°C' : '615°C';
      const flapDeg = flapsStep * 15;
      ctx.fillStyle = '#e0f2fe';
      ctx.fillText(`ENG 1/2 N1: ${n1}`, 540, 56);
      ctx.fillText(`EGT: ${egt}`, 540, 88);
      ctx.fillStyle = gearDown ? '#4ade80' : '#94a3b8';
      ctx.fillText(`GEAR: ${gearDown ? 'DOWN 3-GREEN' : 'UP & LOCKED'}`, 540, 140);
      ctx.fillStyle = flapDeg > 0 ? '#facc15' : '#e0f2fe';
      ctx.fillText(`FLAPS: ${flapDeg}°`, 540, 174);
      ctx.fillStyle = '#38bdf8';
      ctx.fillText(`TRIM: +1.8 UP`, 540, 212);

      texture.needsUpdate = true;
    }

    function syncPlaneControls(): void {
      btnAp.mat.emissiveIntensity = autopilotOn ? 1.4 : 0.25;
      btnToga.mat.emissiveIntensity = togaThrust ? 1.5 : 0.3;
      btnGear.mat.emissiveIntensity = gearDown ? 1.4 : 0.3;
      btnFlaps.mat.emissiveIntensity = flapsStep > 0 ? 1.3 : 0.3;
      const thrTilt = togaThrust ? -0.52 : -0.1;
      thrLeft.rotation.x = thrTilt;
      thrRight.rotation.x = thrTilt;
    }

    function triggerAction(actionId: string): boolean {
      if (actionId === 'plane_ap') autopilotOn = !autopilotOn;
      else if (actionId === 'plane_toga') togaThrust = !togaThrust;
      else if (actionId === 'plane_gear') gearDown = !gearDown;
      else if (actionId === 'plane_flaps') flapsStep = (flapsStep + 1) % 3;
      else return false;
      syncPlaneControls();
      redrawAvionics(performance.now() / 1000);
      return true;
    }

    syncPlaneControls();
    redrawAvionics(0);

    return {
      group,
      update: (elapsed) => {
        const bank = autopilotOn ? Math.sin(elapsed * 0.4) * 0.04 : Math.sin(elapsed * 1.1) * 0.22;
        for (const yg of yokes) {
          yg.rotation.z = bank;
        }
        skyDome.rotation.z = -bank * 0.35;

        if (elapsed - lastDrawAt > 0.16) {
          lastDrawAt = elapsed;
          redrawAvionics(elapsed);
        }
      },
      getSnapshot: () => ({
        placeId: 'airplane',
        statusLine: `${autopilotOn ? 'AP CMD' : 'MANUAL'} • N1 ${togaThrust ? '97%' : '74%'} • GEAR ${gearDown ? 'DOWN' : 'UP'} • FLAPS ${flapsStep * 15}°`,
        actions: [
          { id: 'plane_ap', label: 'AP Master', active: autopilotOn },
          { id: 'plane_toga', label: 'TO/GA Thrust', active: togaThrust },
          { id: 'plane_gear', label: 'Landing Gear', active: gearDown },
          { id: 'plane_flaps', label: `Flaps ${flapsStep * 15}°`, active: flapsStep > 0 },
        ],
      }),
      triggerAction,
    };
  }

  // ==================== 5. АРХИТЕКТУРНЫЙ ЗАЛ / ПЕРЕГОВОРНАЯ ====================
  function buildCyberLoungePlace(): PlaceBuilderState {
    const group = new THREE.Group();
    group.name = 'PlaceArchitectureLounge';

    let holoCityMode = true;

    // Теплый пол + деревянный конференц-стол
    const floorGeo = new THREE.CylinderGeometry(6.5, 6.5, 0.06, 40);
    const floorMat = new THREE.MeshStandardMaterial({
      color: 0x1c1917,
      roughness: 0.78,
      metalness: 0.1,
    });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.position.set(0, -0.02, -1.6);
    floor.xb = { pointerEvents: 'none' };
    group.add(floor);

    const tableGeo = new THREE.CylinderGeometry(1.15, 0.92, 0.08, 32);
    const tableMat = new THREE.MeshStandardMaterial({
      color: 0x3b2f2f,
      roughness: 0.42,
      metalness: 0.15,
    });
    const table = new THREE.Mesh(tableGeo, tableMat);
    table.position.set(0, 0.76, -1.75);
    group.add(table);

    const legGeo = new THREE.CylinderGeometry(0.18, 0.28, 0.74, 24);
    const leg = new THREE.Mesh(legGeo, floorMat);
    leg.position.set(0, 0.37, -1.75);
    group.add(leg);
    disposables.push(floorGeo, floorMat, tableGeo, tableMat, legGeo);

    // Голографический макет города на столе (InstancedMesh башни)
    const cityGroup = new THREE.Group();
    cityGroup.position.set(0, 0.81, -1.75);
    group.add(cityGroup);

    const bldgCount = 36;
    const bldgGeo = new THREE.BoxGeometry(0.08, 1, 0.08);
    const bldgMat = new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      emissive: 0x0284c7,
      emissiveIntensity: 0.5,
      transparent: true,
      opacity: 0.82,
      roughness: 0.25,
    });
    const cityMesh = new THREE.InstancedMesh(bldgGeo, bldgMat, bldgCount);
    cityMesh.xb = { pointerEvents: 'none' };
    const dummy = new THREE.Object3D();
    for (let i = 0; i < bldgCount; i++) {
      const gx = (i % 6) - 2.5;
      const gz = Math.floor(i / 6) - 2.5;
      const h = 0.08 + ((i * 37) % 19) * 0.018;
      dummy.position.set(gx * 0.2, h / 2, gz * 0.2);
      dummy.scale.set(1, h, 1);
      dummy.updateMatrix();
      cityMesh.setMatrixAt(i, dummy.matrix);
    }
    cityMesh.computeBoundingSphere();
    cityGroup.add(cityMesh);
    disposables.push(bldgGeo, bldgMat);

    // Кнопка на краю стола
    const btnDiorama = createConsoleButton('Toggle Holo Diorama', 'lounge_holo', 0x38bdf8, disposables);
    btnDiorama.mesh.position.set(0, 0.82, -0.78);
    group.add(btnDiorama.mesh);

    const warmLight = new THREE.PointLight(0xfde68a, 2.8, 10);
    warmLight.position.set(0, 2.6, -1.6);
    group.add(warmLight);

    return {
      group,
      update: (_elapsed, delta) => {
        cityGroup.rotation.y += (holoCityMode ? 0.22 : 0.04) * delta;
      },
      getSnapshot: () => ({
        placeId: 'cyber_lounge',
        statusLine: `Architecture Briefing Room • Holo Diorama: ${holoCityMode ? 'ACTIVE' : 'PAUSED'}`,
        actions: [{ id: 'lounge_holo', label: 'Holo Diorama Spin', active: holoCityMode }],
      }),
      triggerAction: (actionId) => {
        if (actionId !== 'lounge_holo') return false;
        holoCityMode = !holoCityMode;
        bldgMat.emissiveIntensity = holoCityMode ? 0.65 : 0.15;
        btnDiorama.mat.emissiveIntensity = holoCityMode ? 1.4 : 0.25;
        return true;
      },
    };
  }

  function ensurePlace(placeId: SpatialPlaceId): PlaceBuilderState {
    const existing = places.get(placeId);
    if (existing) return existing;

    let created: PlaceBuilderState;
    if (placeId === 'datacenter') created = buildDatacenterPlace();
    else if (placeId === 'spaceship') created = buildSpaceshipPlace();
    else if (placeId === 'airplane') created = buildAirplanePlace();
    else if (placeId === 'cyber_lounge') created = buildCyberLoungePlace();
    else created = buildCalibrationLab();

    created.group.visible = placeId === activePlace;
    rootGroup.add(created.group);
    places.set(placeId, created);
    return created;
  }

  // Инициализируем базовую комнату сразу
  ensurePlace('calibration_lab');

  return {
    rootGroup,
    setActivePlace(placeId: SpatialPlaceId): void {
      activePlace = placeId;
      ensurePlace(placeId);
      for (const [id, st] of places.entries()) {
        st.group.visible = id === placeId;
      }
    },
    getActivePlace: () => activePlace,
    triggerPanelAction(actionId: string): boolean {
      const current = places.get(activePlace);
      return current ? current.triggerAction(actionId) : false;
    },
    getPanelSnapshot(): SpatialPlaceSnapshot {
      return ensurePlace(activePlace).getSnapshot();
    },
    update(elapsedSec: number, delta: number): void {
      const current = places.get(activePlace);
      if (current) current.update(elapsedSec, delta);
    },
    dispose(): void {
      for (const d of disposables) d.dispose();
    },
  };
}

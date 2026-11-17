/**
 * Модуль удаленной и локальной навигации в пространстве (navigateRemotely).
 *
 * Назначение:
 * Позволяет перемещаться по виртуальной сцене и поворачивать мир относительно пользователя
 * как локально (клавиши WASD/стрелки, кнопки UI, геймпад), так и удаленно
 * (команды nav:command от других устройств по WebSocket/Wi-Fi).
 * Использует плавное экспоненциальное демпфирование (THREE.MathUtils.damp) без резких рывков.
 *
 * Входные параметры:
 * - worldRig: THREE.Group — корневой контейнер сцены, который сдвигается/вращается при навигации;
 * - action: RemoteNavCommand ('forward' | 'back' | 'left' | 'right' | 'reset').
 *
 * Выходные данные:
 * - Плавное обновление позиции/ориентации worldRig в каждом кадре update(delta).
 */

import * as THREE from 'three';

export type RemoteNavCommand = 'forward' | 'back' | 'left' | 'right' | 'reset';

export interface RemoteNavigationController {
  dispatch(command: RemoteNavCommand, broadcast?: boolean): void;
  applyRemoteCommand(command: RemoteNavCommand): void;
  update(deltaSec: number, worldRig: THREE.Object3D): void;
  onBroadcast(cb: (command: RemoteNavCommand) => void): () => void;
  dispose(): void;
}

export function createRemoteNavigationController(): RemoteNavigationController {
  const targetPos = new THREE.Vector3(0, 0, 0);
  let targetYaw = 0;
  const listeners = new Set<(cmd: RemoteNavCommand) => void>();

  const STEP_METERS = 0.45;
  const TURN_RAD = THREE.MathUtils.degToRad(20);

  function applyCommand(command: RemoteNavCommand): void {
    if (command === 'reset') {
      targetPos.set(0, 0, 0);
      targetYaw = 0;
      return;
    }
    if (command === 'left') {
      targetYaw += TURN_RAD;
      return;
    }
    if (command === 'right') {
      targetYaw -= TURN_RAD;
      return;
    }
    const dir = command === 'forward' ? 1 : -1;
    // Двигаем мировую сцену навстречу взгляду (имитация шага вперед/назад)
    targetPos.x += Math.sin(targetYaw) * STEP_METERS * dir;
    targetPos.z += Math.cos(targetYaw) * STEP_METERS * dir;
  }

  const onKeyDown = (e: KeyboardEvent) => {
    const active = document.activeElement?.tagName;
    if (active === 'INPUT' || active === 'TEXTAREA' || active === 'SELECT') {
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') applyCommand('forward');
    else if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') applyCommand('back');
    else if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') applyCommand('left');
    else if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') applyCommand('right');
    else if (e.key === 'r' || e.key === 'R') applyCommand('reset');
  };

  window.addEventListener('keydown', onKeyDown);

  return {
    dispatch(command: RemoteNavCommand, broadcast = true) {
      applyCommand(command);
      if (broadcast) {
        for (const cb of listeners) cb(command);
      }
    },

    applyRemoteCommand(command: RemoteNavCommand) {
      applyCommand(command);
    },

    update(deltaSec: number, worldRig: THREE.Object3D) {
      const dt = Math.min(deltaSec, 0.1);
      worldRig.position.x = THREE.MathUtils.damp(worldRig.position.x, targetPos.x, 7, dt);
      worldRig.position.y = THREE.MathUtils.damp(worldRig.position.y, targetPos.y, 7, dt);
      worldRig.position.z = THREE.MathUtils.damp(worldRig.position.z, targetPos.z, 7, dt);
      worldRig.rotation.y = THREE.MathUtils.damp(worldRig.rotation.y, targetYaw, 7, dt);
    },

    onBroadcast(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },

    dispose() {
      window.removeEventListener('keydown', onKeyDown);
    },
  };
}

import { Matrix4, Object3D, Vector3 } from 'three';
import { LiveSceneTransform } from './live-frame-state';

export type SceneStateTuple = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

const STATE_COMPONENT_COUNT = 10;

export function writeSceneState(objects: Object3D, target: SceneStateTuple): SceneStateTuple {
  target[0] = objects.position.x;
  target[1] = objects.position.y;
  target[2] = objects.position.z;
  target[3] = objects.quaternion.x;
  target[4] = objects.quaternion.y;
  target[5] = objects.quaternion.z;
  target[6] = objects.quaternion.w;
  target[7] = objects.scale.x;
  target[8] = objects.scale.y;
  target[9] = objects.scale.z;
  return target;
}

export function copySceneState(source: SceneStateTuple, target: SceneStateTuple): SceneStateTuple {
  for (let i = 0; i < STATE_COMPONENT_COUNT; i += 1) {
    target[i] = source[i];
  }
  return target;
}

export function sceneStateChanged(a: SceneStateTuple, b: SceneStateTuple, epsilon = 1e-5): boolean {
  for (let i = 0; i < STATE_COMPONENT_COUNT; i += 1) {
    if (Math.abs(a[i] - b[i]) > epsilon) {
      return true;
    }
  }
  return false;
}

export function applyLiveSceneTransform(objects: Object3D, scene: LiveSceneTransform) {
  objects.position.fromArray(scene.position);
  objects.quaternion.fromArray(scene.rotation);
  objects.scale.set(scene.scale[0], scene.scale[1], scene.scale[2]);
}

export function updateSceneMatrixWorld(objects: Object3D): Matrix4 {
  objects.updateWorldMatrix(true, false);
  return objects.matrixWorld;
}

export function simulationToWorld(matrixWorld: Matrix4, simulation: Vector3, target: Vector3): Vector3 {
  return target.copy(simulation).applyMatrix4(matrixWorld);
}

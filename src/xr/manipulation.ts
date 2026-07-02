import { Group, Matrix4, Object3D, Quaternion, Vector3, WebXRSpaceEventMap } from 'three';

export class SqueezeManipulation {
  private readonly objects: Object3D;
  readonly grippingControllers: Group<WebXRSpaceEventMap>[] = [];

  private grabMode: 'none' | 'single' | 'dual' = 'none';
  private readonly singleGrabPrevMatrix = new Matrix4();

  private readonly dualGrabState = {
    prevDistance: 0,
    prevCenter: new Vector3(),
    prevAxis: new Vector3(),
  };

  private readonly tempPosA = new Vector3();
  private readonly tempPosB = new Vector3();
  private readonly tempAxis = new Vector3();
  private readonly tempCenter = new Vector3();
  private readonly tempScale = new Vector3();
  private readonly tempQuat = new Quaternion();
  private readonly tempMatrix = new Matrix4();
  private readonly tempMatrixA = new Matrix4();
  private readonly tempMatrixB = new Matrix4();
  private readonly tempMatrixC = new Matrix4();
  private readonly parentInverse = new Matrix4();

  constructor(objects: Object3D) {
    this.objects = objects;
  }

  get isGrabbing(): boolean {
    return this.grabMode !== 'none';
  }

  startGrip(controller: Group<WebXRSpaceEventMap>) {
    if (this.grippingControllers.includes(controller)) {
      return;
    }
    this.grippingControllers.push(controller);
    this.grabMode = 'none';
    this.dualGrabState.prevDistance = 0;
  }

  endGrip(controller: Group<WebXRSpaceEventMap>) {
    const index = this.grippingControllers.indexOf(controller);
    if (index >= 0) {
      this.grippingControllers.splice(index, 1);
    }
    this.grabMode = 'none';
    this.dualGrabState.prevDistance = 0;
  }

  update() {
    const gripCount = this.grippingControllers.length;
    if (gripCount === 0) {
      this.grabMode = 'none';
      return;
    }

    if (gripCount === 1) {
      this.updateSingleGrab(this.grippingControllers[0]);
      return;
    }

    this.updateDualGrab(this.grippingControllers[0], this.grippingControllers[1]);
  }

  reset() {
    this.grippingControllers.length = 0;
    this.grabMode = 'none';
    this.dualGrabState.prevDistance = 0;
  }

  private updateSingleGrab(controller: Group<WebXRSpaceEventMap>) {
    controller.updateWorldMatrix(true, false);

    if (this.grabMode !== 'single') {
      this.grabMode = 'single';
      this.singleGrabPrevMatrix.copy(controller.matrixWorld);
      return;
    }

    this.tempMatrix.copy(this.singleGrabPrevMatrix).invert();
    this.tempMatrixA.multiplyMatrices(controller.matrixWorld, this.tempMatrix);
    this.applyWorldDeltaToObjects(this.tempMatrixA);
    this.singleGrabPrevMatrix.copy(controller.matrixWorld);
  }

  private updateDualGrab(c1: Group<WebXRSpaceEventMap>, c2: Group<WebXRSpaceEventMap>) {
    c1.getWorldPosition(this.tempPosA);
    c2.getWorldPosition(this.tempPosB);

    const distance = this.tempPosA.distanceTo(this.tempPosB);
    if (distance < 1e-4) {
      this.dualGrabState.prevDistance = distance;
      this.grabMode = 'dual';
      return;
    }

    this.tempCenter.copy(this.tempPosA).lerp(this.tempPosB, 0.5);
    this.tempAxis.copy(this.tempPosB).sub(this.tempPosA).normalize();

    if (this.grabMode !== 'dual' || this.dualGrabState.prevDistance < 1e-4) {
      this.grabMode = 'dual';
      this.dualGrabState.prevDistance = distance;
      this.dualGrabState.prevCenter.copy(this.tempCenter);
      this.dualGrabState.prevAxis.copy(this.tempAxis);
      return;
    }

    let ratio = distance / this.dualGrabState.prevDistance;
    if (!Number.isFinite(ratio) || ratio <= 0) {
      ratio = 1;
    }
    ratio = Math.min(5, Math.max(0.2, ratio));

    this.tempQuat.setFromUnitVectors(this.dualGrabState.prevAxis, this.tempAxis).normalize();
    this.tempScale.set(ratio, ratio, ratio);

    this.tempMatrixA.makeTranslation(this.tempCenter.x, this.tempCenter.y, this.tempCenter.z);
    this.tempMatrixB.makeRotationFromQuaternion(this.tempQuat);
    this.tempMatrixC.makeScale(this.tempScale.x, this.tempScale.y, this.tempScale.z);
    this.tempMatrix.makeTranslation(
      -this.dualGrabState.prevCenter.x,
      -this.dualGrabState.prevCenter.y,
      -this.dualGrabState.prevCenter.z,
    );

    this.tempMatrixA.multiply(this.tempMatrixB).multiply(this.tempMatrixC).multiply(this.tempMatrix);
    this.applyWorldDeltaToObjects(this.tempMatrixA);

    this.dualGrabState.prevDistance = distance;
    this.dualGrabState.prevCenter.copy(this.tempCenter);
    this.dualGrabState.prevAxis.copy(this.tempAxis);
  }

  private applyWorldDeltaToObjects(worldDelta: Matrix4) {
    this.objects.updateWorldMatrix(true, false);
    this.tempMatrixA.copy(worldDelta).multiply(this.objects.matrixWorld);

    const parent = this.objects.parent;
    if (parent) {
      parent.updateWorldMatrix(true, false);
      this.parentInverse.copy(parent.matrixWorld).invert();
      this.tempMatrixB.multiplyMatrices(this.parentInverse, this.tempMatrixA);
    } else {
      this.tempMatrixB.copy(this.tempMatrixA);
    }

    this.tempMatrixB.decompose(this.objects.position, this.objects.quaternion, this.objects.scale);
  }
}

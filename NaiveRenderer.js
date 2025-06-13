"use strict";

import * as THREE from "three";

const DEFAULT_OPTIONS = {
    atomLimit: 2048,
    bondLimit: 2048,
}

const UP = new THREE.Vector3(0, 1, 0);

const matrix = new THREE.Matrix4();
const posA = new THREE.Vector3();
const posB = new THREE.Vector3();
const posU = new THREE.Vector3();

const rot = new THREE.Matrix4();

const t = new THREE.Vector3();
const r = new THREE.Quaternion();
const s = new THREE.Vector3(.035, .035, .035);

const colorA = new THREE.Color();
const colorB = new THREE.Color();

const hackScale = new THREE.Vector3(.035, .035, .035);

class NaiveRenderer extends THREE.Object3D {
    constructor(options = DEFAULT_OPTIONS) {
        super();

        this.material = new THREE.MeshStandardMaterial();

        this.atomsMesh = new THREE.InstancedMesh(
            new THREE.IcosahedronGeometry(1, 2),
            this.material,
            options.atomLimit,
        );
        this.atomsMesh.count = 0;
        this.atomsMesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 100);
        this.add(this.atomsMesh);

        this.bondsMesh = new THREE.InstancedMesh(
            new THREE.CylinderGeometry(1, 1, 1, 16, 1, true).rotateX(Math.PI * .5),
            this.material,
            options.bondLimit,
        );
        this.bondsMesh.count = 0;
        this.bondsMesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 100);
        this.add(this.bondsMesh);

        /** @type {ArrayLike<number>} */
        this._bonds = []; 
    }

    /**
     * @param {ArrayLike<number>} positions
     * @param {ArrayLike<number>} colors
     * @param {ArrayLike<number>} bonds
     */
    setData(positions, colors, bonds) {
        const atomCount = positions.length / 3;
        this.atomsMesh.count = atomCount;

        for (let i = 0; i < atomCount; ++i) {
            colorA.fromArray(colors, i * 3);
            this.atomsMesh.setColorAt(i, colorA);
        }

        const bondCount = bonds.length / 2;
        this.bondsMesh.count = bondCount;

        this._bonds = bonds; 

        for (let i = 0; i < bondCount; ++i) {
            const [ia, ib] = [bonds[i*2 + 0], bonds[i*2 + 1]];
            colorA.fromArray(colors, ia * 3);
            colorB.fromArray(colors, ib * 3);
            colorA.lerp(colorB, .5);
            this.bondsMesh.setColorAt(i, colorA);
        }

        this.atomsMesh.instanceColor.needsUpdate = true;
        this.bondsMesh.instanceColor.needsUpdate = true;
        
        this.setPositions(positions);
    }

    /**
     * @param {ArrayLike<number>} positions
     */
    setPositions(positions) {
        const atomCount = positions.length / 3;
        this.atomsMesh.count = atomCount;

        // TODO: independent scales
        matrix.identity();
        matrix.scale(hackScale);

        for (let i = 0; i < atomCount; ++i) {
            t.fromArray(positions, i * 3);
            matrix.setPosition(t);
            this.atomsMesh.setMatrixAt(i, matrix);
        }

        const bonds = this._bonds;
        const bondCount = bonds.length;

        for (let i = 0; i < bondCount; ++i) {
            const [ia, ib] = [bonds[i*2 + 0], bonds[i*2 + 1]];
            posA.fromArray(positions, ia * 3);
            posB.fromArray(positions, ib * 3);

            const d = posU.copy(posA).sub(posB).length();
            rot.lookAt(posA, posB, UP);
            r.setFromRotationMatrix(rot);
            r.normalize();

            t.lerpVectors(posA, posB, .5);
            s.copy(hackScale).multiplyScalar(.5);
            s.z = d;

            matrix.compose(t, r, s);

            this.bondsMesh.setMatrixAt(i, matrix);
        }

        this.atomsMesh.instanceMatrix.needsUpdate = true;
        this.bondsMesh.instanceMatrix.needsUpdate = true;
    }
}

export default NaiveRenderer;
export { NaiveRenderer };

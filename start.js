"use strict";

import * as THREE from "three";
import Stats from "stats";
import { XRButton } from './XRButton.js';
import { html } from "./utility.js";

import { OrbitControls } from 'https://unpkg.com/three@0.119.1/examples/jsm/controls/OrbitControls.js';

// TODO: look into HTMLMesh (https://threejs.org/examples/?q=xr#webgpu_xr_native_layers)

export default async function start() {
    // threejs + xr setup
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    
    renderer.setAnimationLoop(animate);
    
    renderer.xr.enabled = true;
    renderer.xr.addEventListener("sessionstart", enter_xr);
    renderer.xr.addEventListener("sessionend", exit_xr);
    
    const stats = Stats();

    const container = document.querySelector("body");
    container.appendChild(renderer.domElement);
    container.appendChild(stats.domElement);
    container.appendChild(XRButton.createButton(renderer));

    //

    const clock = new THREE.Clock();

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x505050);

    const objects = new THREE.Object3D();
    scene.add(objects);

    objects.position.set(0, 1, 0);

    const light = new THREE.DirectionalLight();

    const light2 = new THREE.AmbientLight(new THREE.Color(), .25);
    scene.add(light2);

    const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 50);
    camera.position.set(1, 0, 3);
    scene.add(camera);
    camera.add(light);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.maxDistance = 10;
    controls.target.set(0, 1, 0);
    controls.update();

    const count = Math.pow(2, 12);
    console.log(count);

    const atoms = new THREE.InstancedMesh(
        new THREE.IcosahedronGeometry(1, 2),
        new THREE.MeshStandardMaterial(),
        count,
    );
    objects.add(atoms);

    const bonds = new THREE.InstancedMesh(
        new THREE.CylinderGeometry().rotateX(Math.PI * .5),
        new THREE.MeshStandardMaterial(),
        count,
    );
    objects.add(bonds);

    const matrix = new THREE.Matrix4();
    const scaleA = new THREE.Vector3(1, 1, 1).multiplyScalar(.01);
    const scaleB = new THREE.Vector3(1, 1, 1);
    const color = new THREE.Color();

    const rot = new THREE.Matrix4();
    const up = new THREE.Vector3();

    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const t = new THREE.Vector3();

    const r = new THREE.Quaternion().identity();

    const bondRadius = .5;

    const positions = new Array(count * 3).fill(0);
    for (let i = 1; i < count; ++i) {
        t.randomDirection().multiplyScalar(10);
        a.fromArray(positions, (i - 1) * 3);
        t.sub(a).normalize();

        a.addScaledVector(t, THREE.MathUtils.randFloat(0.01, 0.05) * 2);
        a.toArray(positions, i * 3);
    }

    // colors
    for (let i = 0; i < count; ++i) {
        color.setHSL((i / count) + Math.random() * .2, .75, .5);
        atoms.setColorAt(i, color);
    }

    const c = new THREE.Color();

    for (let i = 0; i < count-1; ++i) {
        atoms.getColorAt((i+0), color);
        atoms.getColorAt((i+1), c);

        color.lerpColors(color, c, .5);
        bonds.setColorAt(i, color);
    }

    bonds.count = count - 1;

    function update_atoms() {
        for (let i = 0; i < count; ++i) {
            a.fromArray(positions, i * 3);

            matrix.identity();
            matrix.setPosition(a);
            matrix.scale(scaleA);

            atoms.setMatrixAt(i, matrix);
        }

        atoms.instanceMatrix.needsUpdate = true;
    }

    function update_bonds() {
        for (let i = 0; i < count-1; ++i) {
            a.fromArray(positions, (i+0) * 3);
            b.fromArray(positions, (i+1) * 3);
            const d = t.copy(a).sub(b).length();

            rot.identity();
            rot.lookAt(a, b, up);
            r.setFromRotationMatrix(rot);
            r.normalize();

            t.addVectors(a, b).multiplyScalar(.5);
            scaleB.copy(scaleA).multiplyScalar(bondRadius);
            scaleB.z = d;

            matrix.compose(t, r, scaleB);

            bonds.setMatrixAt(i, matrix);
        }

        bonds.instanceMatrix.needsUpdate = true;
    }

    update_atoms();
    update_bonds();

    function shift(dt) {
        for (let i = 0; i < count; ++i) {
            t.randomDirection();
            a.fromArray(positions, i * 3);
            a.addScaledVector(t, dt * .05);
            a.toArray(positions, i * 3);
        }

        for (let i = 0; i < count-1; ++i) {
            a.fromArray(positions, (i+0) * 3);
            b.fromArray(positions, (i+1) * 3);

            t.copy(b).sub(a);

            if (t.lengthSq() > 0.001) {
                t.multiplyScalar(dt);
                a.add(t);
                a.toArray(positions, (i+0) * 3);
            }
        }

        update_atoms();
        update_bonds();
    }

    // control loop
    function animate() {
        UPDATE_VIEWPORT();

        const dt = Math.min(1/15, clock.getDelta());

        shift(dt);

        if (renderer.xr.isPresenting) {
            update_xr(dt);
        }

        renderer.render(scene, camera);

        stats.update();
    }

    // fit browser window
    function UPDATE_VIEWPORT() {
        if (renderer.xr.isPresenting)
            return;

        const parent = renderer.domElement.parentElement;
        const { width, height } = parent.getBoundingClientRect();

        const aspect = width / height;

        renderer.setSize(width, height, true);
        renderer.setPixelRatio(window.devicePixelRatio);

        camera.aspect = aspect;
        camera.updateProjectionMatrix();
    }

    window.addEventListener("resize", UPDATE_VIEWPORT);
    UPDATE_VIEWPORT();

    // xr mode
    const target = new THREE.Vector3();
    const rotation = new THREE.Matrix4();
    const ray = new THREE.Ray();

    renderer.xr.addEventListener("sessionstart", enter_xr);
    renderer.xr.addEventListener("sessionend", exit_xr);

    function enter_xr() {
    }

    function exit_xr() {
        UPDATE_VIEWPORT();
    }

    function update_xr(dt) {
        const camera = renderer.xr.getCamera();

        rotation.identity().extractRotation(camera.matrixWorld);
        ray.direction.set(0, 0, -1).applyMatrix4(rotation);
        ray.origin.setFromMatrixPosition(camera.matrixWorld);
    }
}


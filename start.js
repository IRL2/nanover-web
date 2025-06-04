"use strict";

import * as THREE from "three";
import Stats from "stats";
import { XRButton } from './XRButton.js';
import { html } from "./utility.js";

import { OrbitControls } from 'https://unpkg.com/three@0.119.1/examples/jsm/controls/OrbitControls.js';

// TODO: look into HTMLMesh (https://threejs.org/examples/?q=xr#webgpu_xr_native_layers)

export default async function start() {
    const data = await fetch("./traj.json").then((r) => r.json());
    console.log(data);

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

    const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 50);
    camera.position.set(1, 0, 3);
    scene.add(camera);

    camera.add(new THREE.DirectionalLight());
    scene.add(new THREE.AmbientLight(new THREE.Color(), .25));

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.maxDistance = 10;
    controls.target.set(0, 1, 0);
    controls.update();

    const atomCount = data.positions[0].length;
    const bondCount = data.topology.bonds.length;
    console.log(atomCount, bondCount);

    const atoms = new THREE.InstancedMesh(
        new THREE.IcosahedronGeometry(1, 2),
        new THREE.MeshStandardMaterial(),
        atomCount,
    );
    objects.add(atoms);

    const bonds = new THREE.InstancedMesh(
        new THREE.CylinderGeometry().rotateX(Math.PI * .5),
        new THREE.MeshStandardMaterial(),
        bondCount,
    );
    objects.add(bonds);

    objects.scale.multiplyScalar(.1);

    const matrix = new THREE.Matrix4();
    const scaleA = new THREE.Vector3(1, 1, 1).multiplyScalar(.035);
    const scaleB = new THREE.Vector3(1, 1, 1);
    const colorA = new THREE.Color();
    const colorB = new THREE.Color();

    const rot = new THREE.Matrix4();
    const up = new THREE.Vector3();

    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const t = new THREE.Vector3();

    const r = new THREE.Quaternion().identity();

    const bondRadius = .5;

    const positions = new Array(atomCount * 3).fill(0);

    function frame_positions_index(index) {
        const sum = new THREE.Vector3();

        for (let i = 0; i < atomCount; ++i) {
            t.fromArray(data.positions[index][i]);
            t.toArray(positions, i * 3);

            sum.add(t);
        }

        sum.divideScalar(atomCount);
        sum.multiply(objects.scale);
        sum.add(objects.position);

        controls.target.copy(sum);
        controls.update();
    }
    frame_positions_index(0);

    const elementColors = new Map([
        [1, new THREE.Color("white")],
        [6, new THREE.Color("black")],
        [7, new THREE.Color("blue")],
        [8, new THREE.Color("red")],
    ]);

    // colors
    for (let i = 0; i < atomCount; ++i) {
        colorA.setHSL((i / atomCount) + Math.random() * .1, .25, .5);

        const element = data.topology.elements[i];

        if (elementColors.has(element)) {
            colorA.lerp(elementColors.get(element), .65);
        }

        atoms.setColorAt(i, colorA);
    }

    for (let i = 0; i < bondCount; ++i) {
        const [ia, ib] = data.topology.bonds[i];
        atoms.getColorAt(ia, colorA);
        atoms.getColorAt(ib, colorB);

        colorA.lerp(colorB, .5);
        bonds.setColorAt(i, colorA);
    }

    function update_atoms() {
        for (let i = 0; i < atomCount; ++i) {
            a.fromArray(positions, i * 3);

            matrix.identity();
            matrix.setPosition(a);
            matrix.scale(scaleA);

            atoms.setMatrixAt(i, matrix);
        }

        atoms.instanceMatrix.needsUpdate = true;
    }

    function update_bonds() {
        for (let i = 0; i < bondCount; ++i) {
            const [ia, ib] = data.topology.bonds[i];
            a.fromArray(positions, ia * 3);
            b.fromArray(positions, ib * 3);
            const d = t.copy(a).sub(b).length();

            rot.identity();
            rot.lookAt(a, b, up);
            r.setFromRotationMatrix(rot);
            r.normalize();

            t.lerpVectors(a, b, .5);
            scaleB.copy(scaleA).multiplyScalar(bondRadius);
            scaleB.z = d;

            matrix.compose(t, r, scaleB);

            bonds.setMatrixAt(i, matrix);
        }

        bonds.instanceMatrix.needsUpdate = true;
    }

    update_atoms();
    update_bonds();

    // control loop
    function animate() {
        UPDATE_VIEWPORT();

        const dt = Math.min(1/15, clock.getDelta());

        const frame = Math.floor((performance.now() / 1000 * 30 * 3) % data.positions.length);
        frame_positions_index(frame);
        update_atoms();
        update_bonds();

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

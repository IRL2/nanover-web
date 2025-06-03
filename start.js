"use strict";

import * as THREE from "three";
import Stats from "stats";
import { VRButton } from './VRButton.js';
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
    container.appendChild(VRButton.createButton(renderer));

    //

    const clock = new THREE.Clock();

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x505050);

    const objects = new THREE.Object3D();
    scene.add(objects);

    const light = new THREE.DirectionalLight();
    light.position.set(2, 2, 1);
    scene.add(light);

    const light2 = new THREE.AmbientLight(new THREE.Color(), .25);
    scene.add(light2);

    const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 50);
    camera.position.set(1, 0, 3);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.maxDistance = 10;
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
        new THREE.CylinderGeometry(),
        new THREE.MeshStandardMaterial(),
        count,
    );
    objects.add(bonds);

    const matrix = new THREE.Matrix4();
    const scale = new THREE.Vector3(1, 1, 1).multiplyScalar(.025);
    const color = new THREE.Color();

    const axis = new THREE.Vector3();
    const rot = new THREE.Matrix4();

    for (let i = 0; i < count; ++i) {
        matrix.identity();
        
        axis.randomDirection();
        rot.makeRotationAxis(axis, Math.random());
        matrix.premultiply(rot);

        matrix.scale(scale);
        matrix.setPosition(
            THREE.MathUtils.randFloatSpread(2), 
            THREE.MathUtils.randFloatSpread(2),
            THREE.MathUtils.randFloatSpread(2),
        );

        color.setHSL(Math.random(), .75, .5);

        atoms.setMatrixAt(i, matrix);
        atoms.setColorAt(i, color);

        matrix.scale(new THREE.Vector3(.5, 3, .5));
        
        bonds.setMatrixAt(i, matrix);
        bonds.setColorAt(i, color);
    }

    // control loop
    function animate() {
        UPDATE_VIEWPORT();

        const dt = Math.min(1/15, clock.getDelta());

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


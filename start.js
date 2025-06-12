"use strict";

import * as THREE from "three";
import Stats from "stats";
import { XRButton } from './XRButton.js';
import { html } from "./utility.js";

import { OrbitControls } from 'https://unpkg.com/three@0.119.1/examples/jsm/controls/OrbitControls.js';
import NaiveRenderer from "./NaiveRenderer.js";

// TODO: look into HTMLMesh (https://threejs.org/examples/?q=xr#webgpu_xr_native_layers)

const elementColors = new Map([
    [1, new THREE.Color("white")],
    [6, new THREE.Color("black")],
    [7, new THREE.Color("blue")],
    [8, new THREE.Color("red")],
]);

export default async function start() {
    /** @type {{ traj: any, renderer: NaiveRenderer }[]} */
    const pairs = [];

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

    const myWorker = new Worker("worker.js", { type: "module" });

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
    controls.maxDistance = .5;
    controls.target.set(0, 1, 0);
    controls.update();

    objects.scale.multiplyScalar(.1);

    const c = new THREE.Color();
    function make_color(traj, i) {
        c.setHSL((i / traj.topology.elements.length) + Math.random() * .1, .25, .5);
        c.lerp(elementColors.get(traj.topology.elements[i]), .65);
        return c
    }

    const channel = new MessageChannel();
    myWorker.postMessage({ port: channel.port2 }, { transfer: [channel.port2] });

    channel.port1.addEventListener("message", (event) => {
        const { traj } = event.data;
        const renderer = new NaiveRenderer();
        objects.add(renderer);

        pairs.push({ traj, renderer });

        const atomCount = traj.positions[0].length / 3;

        const colors = new Float32Array(traj.positions[0].length);
        for (let j = 0; j < atomCount; ++j) {
            make_color(traj, j).toArray(colors, j * 3);
            // c.setHSL(i / fileCount, .75, .5);
            // c.toArray(colors, j * 3);
        }

        renderer.setData(
            traj.positions[0],
            colors,
            traj.topology.bonds,
        );
    });
    channel.port1.start();

    const fileCount = 7;

    for (let i = 0; i < fileCount; ++i) {
        const path = `./data/ludo-gluhut-${i}.json`;
        channel.port1.postMessage({ path });
    }

    function frame_positions_index(index) {
        const sum = new THREE.Vector3();
        const pos = new THREE.Vector3();
        let count = 0;

        for (const { traj, renderer} of pairs) {            
            const positions = traj.positions[Math.min(index, traj.positions.length-1)];
            renderer.setPositions(positions);

            const atomCount = positions.length / 3;
            count += atomCount;

            for (let i = 0; i < atomCount; ++i) {
                pos.fromArray(positions, i * 3);
                sum.add(pos);
            }
        }

        // recenter
        sum.divideScalar(count);
        sum.multiply(objects.scale);

        objects.position.set(0, 1, 0).sub(sum);
        controls.update();
    }
    frame_positions_index(0);

    // control loop
    function animate() {
        UPDATE_VIEWPORT();

        const dt = Math.min(1/15, clock.getDelta());

        const max = Math.max(0, ...pairs.map(({ traj }) => traj.positions.length));
        const frame = Math.floor((performance.now() / 1000 * 30 * 3) % max);

        if (pairs.length > 0) {
            frame_positions_index(frame);
        }

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

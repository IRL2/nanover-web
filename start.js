"use strict";

import * as THREE from "three";
import Stats from "stats";
import { XRButton } from './XRButton.js';
import { html } from "./utility.js";
import { base64ToBytes, decode } from "./convert.js";

import { OrbitControls } from 'https://unpkg.com/three@0.119.1/examples/jsm/controls/OrbitControls.js';
import { XRControllerModelFactory } from 'https://unpkg.com/three@0.177.0/examples/jsm/webxr/XRControllerModelFactory.js';
import NaiveRenderer from "./NaiveRenderer.js";

// TODO: look into HTMLMesh (https://threejs.org/examples/?q=xr#webgpu_xr_native_layers)
// TODO: hand tracking (https://github.com/vrmeup/threejs-webxr-hands-example/tree/main)

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

    const clock = new THREE.Clock();

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x505050);

    const objects = new THREE.Object3D();
    scene.add(objects);

    objects.position.set(0, 1, 0);

    const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 50);
    camera.position.set(1, 0, 3);
    scene.add(camera);

    const skybox = new THREE.Mesh(
        new THREE.IcosahedronGeometry(),
        new THREE.MeshBasicMaterial({ color: 0x505050, transparent: true, opacity: .995, side: THREE.BackSide }),
    );
    skybox.scale.set(5, 5, 5);
    skybox.position.set(0, 1, 0);
    scene.add(skybox);
    skybox.visible = false;

    const controllerModelFactory = new XRControllerModelFactory();
    const controllerGrip1 = renderer.xr.getControllerGrip( 0 );
    controllerGrip1.add( controllerModelFactory.createControllerModel( controllerGrip1 ) );
    scene.add( controllerGrip1 );

    const controllerGrip2 = renderer.xr.getControllerGrip( 1 );
    controllerGrip2.add( controllerModelFactory.createControllerModel( controllerGrip2 ) );
    scene.add( controllerGrip2 );

    controllerGrip1.addEventListener( 'connected', ( event )=> {
        if('gamepad' in event.data){
            if('axes' in event.data.gamepad){ //we have a modern controller
                controllerGrip1.gamepad = event.data.gamepad;
            }
        }
    });

    camera.add(new THREE.DirectionalLight(new THREE.Color(), Math.PI));
    scene.add(new THREE.AmbientLight(new THREE.Color(), .25 * Math.PI));

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.maxDistance = 10;
    controls.target.set(0, 1, 0);
    controls.update();

    objects.scale.multiplyScalar(.1);

    const c = new THREE.Color();
    function make_color(traj, i) {
        c.setHSL((i / traj.topology.elements.length) + Math.random() * .1, .25, .5);
        c.lerp(elementColors.get(traj.topology.elements[i]) ?? c, .65);
        return c
    }

    const trajLoaderWorker = new Worker("traj-loader-worker.js", { type: "module" });
    const trajLoaderChannel = new MessageChannel();
    trajLoaderWorker.postMessage({ port: trajLoaderChannel.port2 }, { transfer: [trajLoaderChannel.port2] });

    const websocketWorker = new Worker("websocket-worker.js", { type: "module" });
    const framesChannel = new MessageChannel();
    websocketWorker.postMessage({ port: framesChannel.port2, host: `wss://${location.hostname}` }, { transfer: [framesChannel.port2] });

    trajLoaderChannel.port1.addEventListener("message", (event) => {
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
    trajLoaderChannel.port1.start();

    // for (let i = 0; i < 7; ++i) {
    //     const path = `./data/ludo-gluhut-${i}.json`;
    //     trajLoaderChannel.port1.postMessage({ path });
    // }

    const live = new NaiveRenderer({ atomLimit: 1024 * 8, bondLimit: 1024 * 8 });
    objects.add(live);

    const debug = html("div", { style: "position: absolute; top: 0; left: 100px" }, "TEST");
    document.body.append(debug);

    let socket;

    function test_interaction(position) {
        const interaction = { 
            particles: [0, 1, 2, 3, 4, 5], 
            position: [position.x, position.y, position.z],
            max_force: 1000,
            mass_weighted: true,
            reset_velocities: false,
            interaction_type: "spring",
            scale: 100,
        };
        socket.send(JSON.stringify({ updates: { "interaction.TEST": interaction } }));
    }

    const boxMesh = new THREE.Mesh(
        new THREE.BoxGeometry(),
        new THREE.MeshBasicMaterial({ color: "orange", side: THREE.BackSide, transparent: true, opacity: .5 }),
    )
    objects.add(boxMesh);
    boxMesh.visible = false;

    const boxWire = new THREE.LineSegments(new THREE.WireframeGeometry(boxMesh.geometry));
    boxMesh.add(boxWire);

    framesChannel.port1.addEventListener("message", (event) => {
        const { frame } = event.data;

        if (frame.topology) {
            console.log(frame.topology);
            const atomCount = frame.topology.elements.length;
            const colors = new Float32Array(atomCount * 3);
            for (let j = 0; j < atomCount; ++j) {
                make_color(frame, j);
                c.toArray(colors, j * 3);
            }

            live.setData(
                new Array(atomCount * 3),
                colors,
                frame.topology.bonds,
            );
        }

        if (frame.positions) {
            live.setPositions(frame.positions);
        }

        if (frame.box) {
            const m = new THREE.Matrix3(...frame.box);
            const x = new THREE.Vector3();
            const y = new THREE.Vector3();
            const z = new THREE.Vector3();
            m.extractBasis(x, y, z);

            const scale = new THREE.Vector3(x.length(), y.length(), z.length());
            boxMesh.geometry = new THREE.BoxGeometry(scale.x, scale.y, scale.z);
            scale.multiplyScalar(.5);
            boxMesh.geometry.translate(scale.x, scale.y, scale.z);
            boxMesh.visible = true;

            boxWire.geometry = new THREE.WireframeGeometry(boxMesh.geometry);

            objects.position.set(0, 1, 0);
            const test = new THREE.Vector3();
            boxMesh.getWorldPosition(test);
            objects.position.sub(scale.multiplyScalar(objects.scale.x));
            objects.position.sub(test).y += 1;
        }
    });
    framesChannel.port1.start();

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
    // frame_positions_index(0);

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
        } else {
            target.setFromMatrixPosition(camera.matrixWorld);
            const test = boxMesh.getWorldPosition(new THREE.Vector3());
            target.sub(test);

            boxMesh.getWorldScale(test);
            const s = test.x;

            const d = target.length();
            const u = Math.min(Math.max(d - s - .5, 0), 1);
            boxMesh.material.opacity = (1 - u) * (1 - u) * .5;
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

        // renderer.setClearColor("black", .9);

        rotation.identity().extractRotation(camera.matrixWorld);
        ray.direction.set(0, 0, -1).applyMatrix4(rotation);
        ray.origin.setFromMatrixPosition(camera.matrixWorld);

        target.setFromMatrixPosition(camera.matrixWorld);
        const test = boxMesh.getWorldPosition(new THREE.Vector3());
        target.sub(test);

        const d = target.length();
        const u = Math.min(Math.max(d - .5, 0), 1);
        skybox.material.opacity = (1 - u) * (1 - u);
        boxMesh.material.opacity = (1 - u) * (1 - u) * .5;

        // debug.textContent = JSON.stringify(`${controllerGrip1.gamepad}`);

        try {
            //skybox.material.opacity = Math.max(controllerGrip1.gamepad.axes[2], 0);
        } catch (e) {
            // debug.textContent = e.toString();
        }
    }
}

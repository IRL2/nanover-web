import { Container, Text as UIText } from '@pmndrs/uikit';
import { Slider } from '@pmndrs/uikit-default';
import { Object3D, Vector3, PerspectiveCamera, Group, Matrix4, Quaternion } from 'three';
import { Controller } from 'lil-gui';

export interface UIKitButton {
    container: Container;
    onClick: () => void;
    originalColor: number;
}

export let controlPanel: Container | undefined;
export const uikitButtons: UIKitButton[] = [];
let playButtonText: UIText | undefined;
export let uikitSlider: Slider | undefined;
export let showPanelInDesktop = false;
export let grabHandle: Container | undefined;

// co-location mode state
export let colocationMode = false;
let isConnectedToServer = false;
let connectedRow: Container | undefined;
let playbackRow: Container | undefined;
let colocationBtnText: UIText | undefined;
let colocationColor = 0x4CAF50;
let colocationBtn: Container | undefined;
let colocationStatusText: UIText | undefined;

// panel grab state
let isPanelGrabbed = false;
let hasBeenPlaced = false;
let initialPositionSet = false;
let grabbingController: Group | null = null;

// matrices for calculation
const offsetMatrix = new Matrix4();
const panelWorldMatrix = new Matrix4();
const controllerWorldMatrix = new Matrix4();
const inverseControllerMatrix = new Matrix4();

const targetPos = new Vector3();
const targetRot = new Quaternion();
const targetScale = new Vector3();
const forward = new Vector3();
const yAxis = new Vector3(0, 1, 0);
const xAxis = new Vector3();

const panelPos = new Vector3();
const camPos = new Vector3();

export function setShowPanelInDesktop(value: boolean) {
    showPanelInDesktop = value;
}

export function setConnectedToServer(connected: boolean) {
    isConnectedToServer = connected;
    updateUIVisibility();
}

export function getColocationMode(): boolean {
    return colocationMode;
}

export function setColocationStatusText(text: string) {
    if (colocationStatusText) {
        colocationStatusText.setProperties({ text } as any);
    }
}

function updateUIVisibility() {
    const showPlayback = !isConnectedToServer;
    if (playbackRow) playbackRow.setProperties({ display: showPlayback ? "flex" : "none" } as any);
    if (uikitSlider) uikitSlider.setProperties({ display: showPlayback ? "flex" : "none" } as any);
    if (connectedRow) connectedRow.setProperties({ display: isConnectedToServer ? "flex" : "none" } as any);
}

function toggleColocationMode() {
    colocationMode = !colocationMode;
    colocationColor = colocationMode ? 0xF44336 : 0x4CAF50;
    if (colocationBtnText) {
        colocationBtnText.setProperties({
            text: colocationMode ? "STOP CO-LOCATION" : "CO-LOCATION SETUP"
        } as any);
    }
    if (colocationBtn) {
        colocationBtn.setProperties({ backgroundColor: colocationColor });
    }
    if (colocationStatusText) {
        colocationStatusText.setProperties({
            display: colocationMode ? "flex" : "none",
            text: colocationMode ? "Place anchors with left controller" : "",
        } as any);
    }
}

export function isPanelBeingGrabbed(): boolean {
    return isPanelGrabbed;
}

export function getGrabHandle(): Container | undefined {
    return grabHandle;
}

export function startPanelGrab(controller: Group, panelRot: Object3D) {
    if (isPanelGrabbed) return;

    isPanelGrabbed = true;
    grabbingController = controller;

    panelRot.updateMatrixWorld(true);
    controller.updateMatrixWorld(true);

    panelWorldMatrix.copy(panelRot.matrixWorld);
    controllerWorldMatrix.copy(controller.matrixWorld);
    inverseControllerMatrix.copy(controllerWorldMatrix).invert();

    offsetMatrix.multiplyMatrices(inverseControllerMatrix, panelWorldMatrix);

    grabHandle?.setProperties({ backgroundColor: 0x4488ff });
}

export function endPanelGrab() {
    isPanelGrabbed = false;
    grabbingController = null;
    hasBeenPlaced = true;

    grabHandle?.setProperties({ backgroundColor: 0x888888 });
}

export function resetPanelPlacement() {
    hasBeenPlaced = false;
    initialPositionSet = false;
}

export function updatePanelGrab(panelRot: Object3D) {
    if (!isPanelGrabbed || !grabbingController) return;

    grabbingController.updateMatrixWorld(true);
    panelWorldMatrix.multiplyMatrices(grabbingController.matrixWorld, offsetMatrix);
    if (panelRot.parent) {
        const parentInverse = new Matrix4().copy(panelRot.parent.matrixWorld).invert();
        panelWorldMatrix.premultiply(parentInverse);
    }
    panelWorldMatrix.decompose(targetPos, targetRot, targetScale);
    panelRot.position.copy(targetPos);
    forward.set(0, 0, 1).applyQuaternion(targetRot);
    forward.y = 0;
    forward.normalize();
    
    if (forward.lengthSq() > 0.001) {
        xAxis.crossVectors(yAxis, forward).normalize();
        const m = new Matrix4().makeBasis(xAxis, yAxis, forward);
        panelRot.quaternion.setFromRotationMatrix(m);
    }
    panelRot.scale.copy(targetScale);
}

export interface XRUIContext {
    getFrameSeek: () => Controller;
    getFramePlay: () => Controller;
    recenter: () => void;
}

export function setupXRUI(panelRot: Object3D, context: XRUIContext) {
// transparent root container 
    controlPanel = new Container({
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: undefined,
        gap: 5,
    });

    controlPanel.position.set(0, 0, 0);
    panelRot.add(controlPanel);

    const uiContainer = new Container({
        sizeX: 0.9,
        sizeY: 0.33,
        flexDirection: "column",
        backgroundColor: 0x1a1a1a,
        padding: 5,
        gap: 5,
        borderRadius: 4,
    });
    controlPanel.add(uiContainer);

    const buttonRow = new Container({
        flexDirection: "row",
        gap: 3,
        marginBottom: 4,
        justifyContent: "center",
        alignItems: "center",
    });

    function createUIButton(label: string, color: number, onClick: () => void) {
        const btn = new Container({
            width: 20,
            height: 10,
            backgroundColor: color,
            borderRadius: 2,
            justifyContent: "center",
            alignItems: "center",
            cursor: "pointer",
            pointerEvents: "auto",
        });

        const btnText = new UIText({
            fontSize: 3,
            color: 0xffffff,
            anchorX: "center",
            anchorY: "middle",
        });

        btnText.setProperties({ text: label } as any);

        btn.add(btnText);

        // pointer event listeners for raycasting
        btn.addEventListener('click', onClick);
        btn.addEventListener('pointerenter', () => {
            btn.setProperties({ backgroundColor: color + 0x303030 });
        });
        btn.addEventListener('pointerleave', () => {
            btn.setProperties({ backgroundColor: color });
        });

        uikitButtons.push({ container: btn, onClick, originalColor: color });

        return btn;
    }

    const prevBtn = createUIButton("<", 0x444444, () => {
        const frameSeek = context.getFrameSeek();
        frameSeek.setValue(frameSeek.getValue() - 1);
    });
    const playBtn = createUIButton("PLAY", 0x2196F3, () => {
        const framePlay = context.getFramePlay();
        framePlay.setValue(!framePlay.getValue());

        if (playButtonText) {
            playButtonText.setProperties({ text: framePlay.getValue() ? "PAUSE" : "PLAY" } as any);
        }
    });
    const nextBtn = createUIButton(">", 0x444444, () => {
        const frameSeek = context.getFrameSeek();
        frameSeek.setValue(frameSeek.getValue() + 1);
    });
    const resetBtn = createUIButton("RESET", 0x666666, () => {
        const frameSeek = context.getFrameSeek();
        frameSeek.setValue(0);
    });
    const centerBtn = createUIButton("CENTER", 0x666666, () => context.recenter());

    playButtonText = playBtn.children[0] as UIText;

    buttonRow.add(prevBtn, playBtn, nextBtn, resetBtn, centerBtn);

    uikitSlider = new Slider();
    uikitSlider.setProperties({
        width: "100%",
        value: 0,
        min: 0,
        max: 1,
        step: 1,
        pointerEvents: "auto",
        onValueChange: (value: number) => {
            const frameSeek = context.getFrameSeek();
            const framePlay = context.getFramePlay();
            console.log("Slider value changed:", value, "frameSeek:", frameSeek);
            if (frameSeek) {
                framePlay.setValue(false); // stop playback when user drags
                frameSeek.setValue(Math.round(value));
            }
        },
    } as any);

    if (uikitSlider.thumb) {
        uikitSlider.thumb.setProperties({
            borderColor: 0x888888,
            borderWidth: 1,
            height: 12,
            width: 12,
            transformTranslateX: -6,
            transformTranslateY: -4,
        } as any);
    }

    if (uikitSlider.track) {
        uikitSlider.track.setProperties({
            height: 4,
        } as any);
    }

    uiContainer.add(buttonRow, uikitSlider);

    playbackRow = buttonRow;

    // connected mode UI: co-location setup button + status text
    connectedRow = new Container({
        flexDirection: "column",
        gap: 3,
        marginBottom: 4,
        justifyContent: "center",
        alignItems: "center",
    });

    colocationBtn = new Container({
        width: 45,
        height: 10,
        backgroundColor: colocationColor,
        borderRadius: 2,
        justifyContent: "center",
        alignItems: "center",
        cursor: "pointer",
        pointerEvents: "auto",
    });

    colocationBtnText = new UIText({
        fontSize: 2.5,
        color: 0xffffff,
        anchorX: "center",
        anchorY: "middle",
    });
    colocationBtnText.setProperties({ text: "CO-LOCATION SETUP" } as any);
    colocationBtn.add(colocationBtnText);

    colocationBtn.addEventListener('click', toggleColocationMode);
    colocationBtn.addEventListener('pointerenter', () => {
        colocationBtn?.setProperties({ backgroundColor: colocationColor + 0x303030 });
    });
    colocationBtn.addEventListener('pointerleave', () => {
        colocationBtn?.setProperties({ backgroundColor: colocationColor });
    });

    uikitButtons.push({ container: colocationBtn, onClick: toggleColocationMode, originalColor: colocationColor });

    colocationStatusText = new UIText({
        fontSize: 2,
        color: 0xaaaaaa,
        anchorX: "center",
        anchorY: "middle",
    });
    colocationStatusText.setProperties({ text: "", display: "none" } as any);

    connectedRow.add(colocationBtn, colocationStatusText);
    connectedRow.setProperties({ display: "none" } as any);

    uiContainer.add(connectedRow);

    grabHandle = new Container({
        width: 15,
        height: 3,
        backgroundColor: 0x888888,
        borderRadius: 2,
        cursor: "grab",
        pointerEvents: "auto",
    });

    grabHandle.addEventListener('pointerenter', () => {
        grabHandle?.setProperties({ backgroundColor: 0xaaaaaa });
    });
    grabHandle.addEventListener('pointerleave', () => {
        if (!isPanelGrabbed) {
            grabHandle?.setProperties({ backgroundColor: 0x888888 });
        }
    });
    
    grabHandle.addEventListener('pointerdown', (e) => {
        (grabHandle as any).userData.grabRequested = true;
        (grabHandle as any).userData.pointerId = e.pointerId; 
    });

    grabHandle.addEventListener('pointerup', () => {
        endPanelGrab();
        (grabHandle as any).userData.grabRequested = false;
    });

    controlPanel.add(grabHandle);
}

/**
 * @param controllers - (renderer.xr.getController(0), etc)
 */
export function updateXRUI(
    dt: number,
    isPresenting: boolean,
    camera: PerspectiveCamera,
    panelRot: Object3D,
    frameSeekValue: number,
    maxFrames: number,
    controllers: Group[] = [] 
) {
    if (controlPanel) {
        controlPanel.update(dt * 1000);

        if (uikitSlider && maxFrames > 1) {
            uikitSlider.setProperties({
                max: maxFrames - 1,
                value: frameSeekValue
            } as any);
        }

        controlPanel.visible = isPresenting || showPanelInDesktop;
    }

    
    if (grabHandle && (grabHandle as any).userData.grabRequested && !isPanelGrabbed) {
        let closestController = null;
        let minDistance = Infinity;
        const handlePos = new Vector3();
        grabHandle.getWorldPosition(handlePos);

        for (const c of controllers) {
            const cPos = new Vector3();
            c.getWorldPosition(cPos);
            const dist = cPos.distanceTo(handlePos);
            if (dist < 0.2) {
                 if (dist < minDistance) {
                     minDistance = dist;
                     closestController = c;
                 }
            }
        }

        if (closestController) {
            startPanelGrab(closestController, panelRot);
            (grabHandle as any).userData.grabRequested = false;
        }
    }

    if (isPanelGrabbed && grabbingController) {
        updatePanelGrab(panelRot);
    }

    if ((isPresenting || showPanelInDesktop) && controlPanel && panelRot) {
        panelRot.getWorldPosition(panelPos);
        camera.getWorldPosition(camPos);

        const deltaY = camPos.y - panelPos.y;
        const distXZ = Math.hypot(camPos.x - panelPos.x, camPos.z - panelPos.z);
        const tiltAngle = -Math.atan2(deltaY, distXZ);

        controlPanel.rotation.x = tiltAngle;
    }

    if ((isPresenting && (hasBeenPlaced || isPanelGrabbed))) {
        return;
    }

    if (isPresenting) {
        if (!initialPositionSet) {
            panelRot.position.copy(camera.position);
            panelRot.position.y -= 0.6;

            const forward = new Vector3();
            camera.getWorldDirection(forward);
            forward.y = 0;
            forward.normalize();
            panelRot.position.addScaledVector(forward, 0.8);

            const targetLook = camera.position.clone();
            targetLook.y = panelRot.position.y;
            panelRot.lookAt(targetLook);

            initialPositionSet = true;
        }
    } else {
        if (showPanelInDesktop && controlPanel) {
            panelRot.position.copy(camera.position);
            const forward = new Vector3();
            camera.getWorldDirection(forward);
            panelRot.position.addScaledVector(forward, 2);
            panelRot.lookAt(camera.position);
            if (controlPanel) {
                controlPanel.rotation.x = 0;
            }
        }
    }
}
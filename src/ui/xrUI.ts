import { Container, Svg, Text as UIText } from '@pmndrs/uikit';
import { Object3D, Vector3, PerspectiveCamera, Group, Matrix4, Quaternion } from 'three';
import { Controller } from 'lil-gui';
import twemoji from '@twemoji/api';
import { setupXRPlaybackUI } from './xrPlaybackUI';
import { showNotification } from './xrNotification';
import type { UserCommand } from '../io/network-client';
import {
  forceType,
  forceScale,
  isSimulationPlaying,
  selectionTarget,
  setForceType,
  setSimulationPlaying,
  setSelectionTarget,
} from '../state';

type ForceType = 'gaussian' | 'spring' | 'constant';

export interface UIKitButton {
    container: Container;
    onClick: () => void;
    originalColor: number;
    getDisplayColor?: (hovered: boolean) => number;
}

export let controlPanel: Container | undefined;
export const uikitButtons: UIKitButton[] = [];
export let showPanelInDesktop = false;
export let grabHandle: Container | undefined;

export let colocationMode = false;
let isConnectedToServer = false;
let uiContainerRef: Container | undefined;
let connectedRow: Container | undefined;
let connectedControlsRow: Container | undefined;
let playbackUI: ReturnType<typeof setupXRPlaybackUI> | undefined;
let userCommandsPanel: Container | undefined;
let renderUserCommands: ((commands: UserCommand[]) => void) | undefined;
let userCommands: UserCommand[] = [];
let userCommandButtons: UIKitButton[] = [];
let colocationBtnText: UIText | undefined;
let colocationColor = 0x4CAF50;
let colocationBtn: Container | undefined;
let colocationStatusText: UIText | undefined;
let forceScaleText: UIText | undefined;
let forceScaleRow: Container | undefined;
let simulationPlayBtnText: UIText | undefined;
let selectionTargetBtnText: UIText | undefined;
let colocationButton: UIKitButton | undefined;
const forceTypeButtons = new Map<ForceType, UIKitButton>();

const ACTIVE_BUTTON_SHADE = 0x303030;
const FORCE_BUTTON_COLOR = 0x5C6BC0;
const PLAYBACK_PANEL_HEIGHT = 0.4;
const CONNECTED_PANEL_HEIGHT = 0.55;
const FORCE_TYPE_OPTIONS: { value: ForceType; label: string }[] = [
    { value: 'gaussian', label: 'GAUSS' },
    { value: 'spring', label: 'SPRING' },
    { value: 'constant', label: 'CONST' },
];

function getEmojiSvgUrl(emoji: string): string {
    let url = '';
    twemoji.parse(emoji, {
        callback: (icon) => {
            url = `https://cdn.jsdelivr.net/gh/jdecked/twemoji@latest/assets/svg/${icon}.svg`;
            return '';
        },
    });
    return url;
}

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
    if (!connected) {
        colocationMode = false;
        colocationColor = 0x4CAF50;
    }
    updateColocationUI();
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

export function setUserCommands(commands: UserCommand[]) {
    userCommands = commands;
    renderUserCommands?.(commands);
}

function updateSimulationPlayButtonLabel() {
    simulationPlayBtnText?.setProperties({ text: isSimulationPlaying ? "PAUSE" : "PLAY" } as any);
}

function updateSelectionTargetButtonLabel() {
    selectionTargetBtnText?.setProperties({
        text: selectionTarget === 'single' ? 'SINGLE' : 'RESIDUE',
    } as any);
}

function getButtonBackgroundColor(button: UIKitButton, hovered: boolean) {
    if (button.getDisplayColor) {
        return button.getDisplayColor(hovered);
    }
    return button.originalColor + (hovered ? ACTIVE_BUTTON_SHADE : 0);
}

function setButtonBackgroundColor(button: UIKitButton, hovered: boolean) {
    button.container.setProperties({
        backgroundColor: getButtonBackgroundColor(button, hovered),
    } as any);
}

function setButtonTextSize(button: UIKitButton, fontSize: number) {
    const buttonText = button.container.children[0];
    if (buttonText) {
        (buttonText as UIText).setProperties({ fontSize } as any);
    }
}

function updateForceTypeButtons() {
    for (const button of forceTypeButtons.values()) {
        setButtonBackgroundColor(button, false);
    }
}

function updateColocationUI() {
    if (colocationBtnText) {
        colocationBtnText.setProperties({
            text: colocationMode ? 'STOP CO-LOCATION' : 'CO-LOCATION SETUP',
        } as any);
    }

    if (colocationButton) {
        setButtonBackgroundColor(colocationButton, false);
    }

    if (colocationStatusText) {
        colocationStatusText.setProperties({
            text: colocationMode ? 'Place anchors with left controller' : '',
        } as any);
    }
}

function updateUIVisibility() {
    const showPlayback = !isConnectedToServer;
    const showConnected = isConnectedToServer;
    const showConnectedControls = showConnected && !colocationMode;
    if (uiContainerRef) {
        uiContainerRef.setProperties({
            sizeY: showConnected ? CONNECTED_PANEL_HEIGHT : PLAYBACK_PANEL_HEIGHT,
        } as any);
    }
    playbackUI?.setVisible(showPlayback);
    if (connectedRow) connectedRow.setProperties({ display: showConnected ? "flex" : "none" } as any);
    if (connectedControlsRow) connectedControlsRow.setProperties({ display: showConnectedControls ? "flex" : "none" } as any);
    if (colocationBtn) colocationBtn.setProperties({ display: showConnected ? "flex" : "none" } as any);
    if (colocationStatusText) {
        colocationStatusText.setProperties({ display: showConnected && colocationMode ? "flex" : "none" } as any);
    }
    if (forceScaleText) {
        forceScaleText.setProperties({ display: showConnected ? "flex" : "none" } as any);
    }
}

function toggleColocationMode() {
    colocationMode = !colocationMode;
    colocationColor = colocationMode ? 0xF44336 : 0x4CAF50;
    updateColocationUI();
    updateUIVisibility();
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
    runCommand: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
    publishSharedState?: (updates: Record<string, unknown>, removals?: string[]) => void;
}

export function setupXRUI(panelRot: Object3D, context: XRUIContext) {
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
        sizeY: PLAYBACK_PANEL_HEIGHT,
        flexDirection: "column",
        backgroundColor: 0x1a1a1a,
        padding: 5,
        gap: 5,
        borderRadius: 4,
    });
    uiContainerRef = uiContainer;
    controlPanel.add(uiContainer);

    function createUIButton(
        label: string,
        color: number,
        onClick: () => void,
        getDisplayColor?: (hovered: boolean) => number,
    ): UIKitButton {
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

        const button: UIKitButton = {
            container: btn,
            onClick,
            originalColor: color,
            getDisplayColor,
        };

        btn.addEventListener('click', onClick);
        btn.addEventListener('pointerenter', () => {
            setButtonBackgroundColor(button, true);
        });
        btn.addEventListener('pointerleave', () => {
            setButtonBackgroundColor(button, false);
        });

        uikitButtons.push(button);

        return button;
    }

    userCommandsPanel = new Container({
        sizeX: 0.9,
        flexDirection: "column",
        alignItems: "stretch",
        backgroundColor: 0x1a1a1a,
        padding: 5,
        gap: 4,
        borderRadius: 4,
        display: "none",
    });

    const userCommandsTitle = new UIText({
        fontSize: 2.4,
        color: 0xaaaaaa,
        anchorX: "center",
        anchorY: "middle",
    });
    userCommandsTitle.setProperties({ text: "COMMANDS" } as any);
    userCommandsPanel.add(userCommandsTitle);

    const userCommandsRow = new Container({
        flexDirection: "row",
        width: "100%",
        gap: 4,
        justifyContent: "center",
        alignItems: "flex-start",
    });
    userCommandsPanel.add(userCommandsRow);

    async function runUserCommand(name: string) {
        showNotification(`Run ${name}`);
        const response = await context.runCommand(name);
        if (response && typeof response === 'object') {
            const result = (response as Record<string, unknown>).result;
            if (result !== undefined) {
                showNotification(`${name}: ${String(result)}`);
            } else if (Object.keys(response).length > 0) {
                showNotification(`Completed ${name}`);
            }
        }
    }

    renderUserCommands = (commands) => {
        for (const button of userCommandButtons) {
            const buttonIndex = uikitButtons.indexOf(button);
            if (buttonIndex >= 0) {
                uikitButtons.splice(buttonIndex, 1);
            }
        }
        userCommandButtons = [];
        userCommandsRow.clear();

        for (const command of commands) {
            const label = command.label ?? command.name.split('/').slice(1).join(' ');
            const commandCell = new Container({
                flexDirection: "column",
                width: 18,
                gap: 1,
                alignItems: "center",
            });
            const button = createUIButton(
                '',
                0x546E7A,
                () => { void runUserCommand(command.name); },
            );
            button.container.setProperties({ width: 12, height: 12 } as any);

            const buttonText = button.container.children[0];
            if (buttonText) {
                button.container.remove(buttonText);
                (buttonText as UIText).dispose();
            }

            if (command.icon) {
                button.container.add(new Svg({
                    src: getEmojiSvgUrl(command.icon),
                    width: 8,
                    height: 8,
                    keepAspectRatio: true,
                }));
            }

            const commandLabel = new UIText({
                width: 12,
                fontSize: 1.5,
                color: 0xcccccc,
                textAlign: "center",
                anchorX: "center",
                anchorY: "middle",
            });
            commandLabel.setProperties({ text: label } as any);

            commandCell.add(button.container, commandLabel);
            userCommandsRow.add(commandCell);
            userCommandButtons.push(button);
        }

        userCommandsPanel!.setProperties({ display: commands.length > 0 ? "flex" : "none" } as any);
    };
    renderUserCommands(userCommands);

    playbackUI = setupXRPlaybackUI(uiContainer, context, createUIButton);

    // connected mode UI
    connectedRow = new Container({
        flexDirection: "column",
        width: "100%",
        gap: 6,
        alignItems: "center",
    });

    connectedControlsRow = new Container({
        flexDirection: "column",
        width: "100%",
        gap: 6,
        alignItems: "center",
    });

    const simulationButtonRow = new Container({
        flexDirection: "row",
        width: "100%",
        flexWrap: "no-wrap",
        gap: 4,
        justifyContent: "center",
        alignItems: "center",
    });

    const forceTypeRow = new Container({
        flexDirection: "row",
        width: "100%",
        flexWrap: "no-wrap",
        gap: 2,
        justifyContent: "center",
        alignItems: "center",
    });

    const restartBtn = createUIButton("RESTART", 0x666666, () => {
        void context.runCommand('playback/reset');
    });

    const simPlayBtn = createUIButton("PLAY", 0x2196F3, () => {
        const nextPlaying = !isSimulationPlaying;
        setSimulationPlaying(nextPlaying);
        updateSimulationPlayButtonLabel();
        void context.runCommand(nextPlaying ? 'playback/play' : 'playback/pause');
    });

    simulationPlayBtnText = simPlayBtn.container.children[0] as UIText;
    updateSimulationPlayButtonLabel();

    const stepBtn = createUIButton("STEP", 0x444444, () => {
        void context.runCommand('playback/step');
    });

    setButtonTextSize(restartBtn, 2.5);
    setButtonTextSize(simPlayBtn, 2.5);
    setButtonTextSize(stepBtn, 2.5);
    restartBtn.container.setProperties({ width: 18 } as any);
    simPlayBtn.container.setProperties({ width: 18 } as any);
    stepBtn.container.setProperties({ width: 18 } as any);

    for (const option of FORCE_TYPE_OPTIONS) {
        const forceButton = createUIButton(
            option.label,
            FORCE_BUTTON_COLOR,
            () => {
                setForceType(option.value);
                updateForceTypeButtons();
                context.publishSharedState?.({ 'suggested.interaction.type': option.value });
            },
            () => option.value === forceType ? FORCE_BUTTON_COLOR + ACTIVE_BUTTON_SHADE : FORCE_BUTTON_COLOR,
        );
        forceButton.container.setProperties({ width: 15 } as any);
        setButtonTextSize(forceButton, 2.3);
        forceTypeButtons.set(option.value, forceButton);
        forceTypeRow.add(forceButton.container);
    }

    const selectionTargetBtn = createUIButton("SINGLE", 0x795548, () => {
        const nextTarget = selectionTarget === 'single' ? 'residue' : 'single';
        setSelectionTarget(nextTarget);
        updateSelectionTargetButtonLabel();
    });

    selectionTargetBtnText = selectionTargetBtn.container.children[0] as UIText;
    updateSelectionTargetButtonLabel();
    selectionTargetBtn.container.setProperties({ width: 18 } as any);
    setButtonTextSize(selectionTargetBtn, 2.3);
    forceTypeRow.add(selectionTargetBtn.container);
    simulationButtonRow.add(restartBtn.container, simPlayBtn.container, stepBtn.container);
    connectedControlsRow.add(simulationButtonRow, forceTypeRow);
    connectedRow.add(connectedControlsRow);

    colocationButton = createUIButton(
        "CO-LOCATION SETUP",
        colocationColor,
        toggleColocationMode,
        (hovered) => colocationColor + (hovered ? ACTIVE_BUTTON_SHADE : 0),
    );
    colocationBtn = colocationButton.container;
    colocationBtn.setProperties({ width: 54, marginTop: 1 } as any);
    colocationBtnText = colocationBtn.children[0] as UIText;
    colocationBtnText.setProperties({ fontSize: 2.2 } as any);

    colocationStatusText = new UIText({
        fontSize: 2,
        color: 0xaaaaaa,
        anchorX: "center",
        anchorY: "middle",
    });
    colocationStatusText.setProperties({ text: "", display: "none" } as any);

    forceScaleText = new UIText({
        fontSize: 2,
        color: 0x888888,
        anchorX: "center",
        anchorY: "middle",
    });
    forceScaleText.setProperties({ text: "SCALE: 100", display: "none" } as any);

    forceScaleRow = new Container({
        flexDirection: "row",
        justifyContent: "center",
        alignItems: "center",
    });
    forceScaleRow.add(forceScaleText);

    connectedRow.add(colocationBtn, colocationStatusText);
    connectedRow.setProperties({ display: "none" } as any);

    uiContainer.add(connectedRow, forceScaleRow);
    updateColocationUI();
    updateForceTypeButtons();

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

    controlPanel.add(userCommandsPanel, grabHandle);
    updateUIVisibility();
}

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
        updateForceTypeButtons();

        playbackUI?.syncFrame(frameSeekValue, maxFrames);

        if (forceScaleText) {
            forceScaleText.setProperties({ text: `SCALE: ${Math.round(forceScale)}` } as any);
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

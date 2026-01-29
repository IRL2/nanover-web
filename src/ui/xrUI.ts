import { Container, Text as UIText } from '@pmndrs/uikit';
import { Slider } from '@pmndrs/uikit-default';
import { Object3D, Vector3, PerspectiveCamera } from 'three';
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

export function setShowPanelInDesktop(value: boolean) {
    showPanelInDesktop = value;
}

export interface XRUIContext {
    getFrameSeek: () => Controller;
    getFramePlay: () => Controller;
    recenter: () => void;
}

export function setupXRUI(panelRot: Object3D, context: XRUIContext) {
    //  root container control panel
    controlPanel = new Container({
        sizeX: 0.9,
        sizeY: 0.33,
        flexDirection: "column",
        backgroundColor: 0x1a1a1a,
        padding: 5,
        gap: 5,
        borderRadius: 2,
    });

    controlPanel.position.set(0, 0, 0);
    panelRot.add(controlPanel);

    // button container (horizontal row)
    const buttonRow = new Container({
        flexDirection: "row",
        gap: 3,
        marginBottom: 2,
        justifyContent: "center",
        alignItems: "center",
    });

    // custom button container
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

    // UIKit default Slider component
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

    controlPanel.add(buttonRow, uikitSlider);
}

export function updateXRUI(
    dt: number,
    isPresenting: boolean,
    camera: PerspectiveCamera,
    panelRot: Object3D,
    frameSeekValue: number,
    maxFrames: number
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

    // panel positioning
    if (isPresenting) {
        panelRot.position.copy(camera.position);
        panelRot.position.y -= 0.6;

        const forward = new Vector3();
        camera.getWorldDirection(forward);
        forward.y = 0;
        forward.normalize();
        panelRot.position.addScaledVector(forward, 0.8);

        panelRot.lookAt(camera.position);
        if (controlPanel) {
            controlPanel.rotation.x = Math.PI * 0.15;
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
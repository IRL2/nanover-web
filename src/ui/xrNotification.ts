import { Container, Text as UIText } from '@pmndrs/uikit';
import { Object3D, PerspectiveCamera, Vector3 } from 'three';

const NOTIFICATION_DURATION = 4;
const NOTIFICATION_OFFSET_Y = 0.12;

let notificationRoot: Object3D | undefined;
let notificationPanel: Container | undefined;
let notificationText: UIText | undefined;
let notificationTimer = 0;

const controllerPos = new Vector3();
const cameraPos = new Vector3();

export function setupNotificationUI(parent: Object3D) {
    notificationRoot = new Object3D();
    notificationRoot.visible = false;
    parent.add(notificationRoot);

    notificationPanel = new Container({
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: 0x1a1a1a,
        maxWidth: 40,
        padding: 4,
        borderRadius: 3,
    });

    notificationText = new UIText({
        fontSize: 2.5,
        color: 0xffffff,
        anchorX: "center",
        anchorY: "middle",
    });
    notificationText.setProperties({ text: "" } as any);

    notificationPanel.add(notificationText);
    notificationRoot.add(notificationPanel);
}

export function showNotification(message: string) {
    if (!notificationRoot || !notificationText) {
        return;
    }

    notificationText.setProperties({ text: message } as any);
    notificationRoot.visible = true;
    notificationTimer = NOTIFICATION_DURATION;
}

export function updateNotificationUI(
    dt: number,
    isPresenting: boolean,
    camera: PerspectiveCamera,
    rightController: Object3D | undefined,
) {
    if (!notificationRoot || !notificationPanel) {
        return;
    }

    if (!isPresenting || !rightController || notificationTimer <= 0) {
        notificationRoot.visible = false;
        return;
    }

    notificationTimer -= dt;
    if (notificationTimer <= 0) {
        notificationRoot.visible = false;
        return;
    }

    notificationPanel.update(dt * 1000);

    rightController.getWorldPosition(controllerPos);
    notificationRoot.position.set(controllerPos.x, controllerPos.y + NOTIFICATION_OFFSET_Y, controllerPos.z);

    camera.getWorldPosition(cameraPos);
    notificationRoot.lookAt(cameraPos);
}

import { Container, Text as UIText } from '@pmndrs/uikit';
import { Object3D, PerspectiveCamera, Quaternion, Vector3 } from 'three';

const NOTIFICATION_DURATION = 4;
const NOTIFICATION_OFFSET = new Vector3(-0.14, 0.03, 0);

let notificationRoot: Object3D | undefined;
let notificationPanel: Container | undefined;
let notificationText: UIText | undefined;
let notificationTimer = 0;

const controllerPos = new Vector3();
const cameraPos = new Vector3();
const controllerRotation = new Quaternion();
const notificationOffset = new Vector3();

export function setupNotificationUI(parent: Object3D) {
    notificationRoot = new Object3D();
    notificationRoot.visible = false;
    parent.add(notificationRoot);

    notificationPanel = new Container({
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: 0x1a1a1a,
        maxWidth: 30,
        padding: 3,
        borderRadius: 3,
    });

    notificationText = new UIText({
        fontSize: 2,
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
    rightController.getWorldQuaternion(controllerRotation);
    notificationOffset.copy(NOTIFICATION_OFFSET).applyQuaternion(controllerRotation);
    notificationRoot.position.copy(controllerPos).add(notificationOffset);

    camera.getWorldPosition(cameraPos);
    notificationRoot.lookAt(cameraPos);
}

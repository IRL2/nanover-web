import { CylinderGeometry, Mesh, MeshBasicMaterial, Object3D } from "three";
import { Text } from "troika-three-text";

export default class Button extends Object3D {
    face: Mesh;
    label: Text;

    disabled = false;
    hovered = false;
    active = false;
    onclick = () => {};

    constructor(label: string) {
        super();

        this.face = new Mesh(
            new CylinderGeometry(1, 1, .5, 12),
            new MeshBasicMaterial({ color: 0x555555 }),
        );
        
        this.label = new Text();
        this.label.text = label;
        this.label.fontSize = .35;
        this.label.anchorX = "center";
        this.label.anchorY = "middle";
        this.label.position.y = .3;
        this.label.rotation.x = -Math.PI * .5;

        this.add(this.face);
        this.add(this.label);
    }

    setLabel(label: string) {
        this.label.text = label;
        this.label.sync();
    }

    enter() {
        this.setHovered(true);
    }

    exit() {
        this.setHovered(false);
    }

    setHovered(value: boolean) {
        this.hovered = value;
        this.refresh();
    }

    refresh() {
        if (this.hovered) {
            this.face.scale.set(1.1, 1.1, 1.1);
        } else {
            this.face.scale.set(1, 1, 1);
        }
    }
}

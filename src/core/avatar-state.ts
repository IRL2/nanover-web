export interface AvatarComponentState {
  name: string;
  position: [number, number, number];
  rotation: [number, number, number, number];
}

export type AvatarComponentsState = AvatarComponentState[];

import { Container, Text as UIText } from '@pmndrs/uikit';
import { Slider } from '@pmndrs/uikit-default';
import { Controller } from 'lil-gui';
import { UIKitButton } from './xrUI';

export interface XRPlaybackUIContext {
  getFrameSeek: () => Controller;
  getFramePlay: () => Controller;
  recenter: () => void;
}

export interface XRPlaybackUIController {
  setVisible: (visible: boolean) => void;
  syncFrame: (frameSeekValue: number, maxFrames: number) => void;
}

export interface CreateXRButton {
  (
    label: string,
    color: number,
    onClick: () => void,
    getDisplayColor?: (hovered: boolean) => number,
  ): UIKitButton;
}

export function setupXRPlaybackUI(
  uiContainer: Container,
  context: XRPlaybackUIContext,
  createUIButton: CreateXRButton,
): XRPlaybackUIController {
  const buttonRow = new Container({
    flexDirection: 'row',
    gap: 3,
    marginBottom: 4,
    justifyContent: 'center',
    alignItems: 'center',
  });

  const prevBtn = createUIButton('<', 0x444444, () => {
    const frameSeek = context.getFrameSeek();
    frameSeek.setValue(frameSeek.getValue() - 1);
  });
  const playBtn = createUIButton('PLAY', 0x2196F3, () => {
    const framePlay = context.getFramePlay();
    framePlay.setValue(!framePlay.getValue());

    const playButtonText = playBtn.container.children[0] as UIText;
    playButtonText.setProperties({ text: framePlay.getValue() ? 'PAUSE' : 'PLAY' } as any);
  });
  const nextBtn = createUIButton('>', 0x444444, () => {
    const frameSeek = context.getFrameSeek();
    frameSeek.setValue(frameSeek.getValue() + 1);
  });
  const resetBtn = createUIButton('RESET', 0x666666, () => {
    const frameSeek = context.getFrameSeek();
    frameSeek.setValue(0);
  });
  const centerBtn = createUIButton('CENTER', 0x666666, () => context.recenter());

  buttonRow.add(
    prevBtn.container,
    playBtn.container,
    nextBtn.container,
    resetBtn.container,
    centerBtn.container,
  );

  const slider = new Slider();
  slider.setProperties({
    width: '100%',
    value: 0,
    min: 0,
    max: 1,
    step: 1,
    pointerEvents: 'auto',
    onValueChange: (value: number) => {
      const frameSeek = context.getFrameSeek();
      const framePlay = context.getFramePlay();
      framePlay.setValue(false);
      frameSeek.setValue(Math.round(value));
    },
  } as any);

  if (slider.thumb) {
    slider.thumb.setProperties({
      borderColor: 0x888888,
      borderWidth: 1,
      height: 12,
      width: 12,
      transformTranslateX: -6,
      transformTranslateY: -4,
    } as any);
  }

  if (slider.track) {
    slider.track.setProperties({
      height: 4,
    } as any);
  }

  uiContainer.add(buttonRow, slider);

  return {
    setVisible: (visible: boolean) => {
      const display = visible ? 'flex' : 'none';
      buttonRow.setProperties({ display } as any);
      slider.setProperties({ display } as any);
    },
    syncFrame: (frameSeekValue: number, maxFrames: number) => {
      if (maxFrames > 1) {
        slider.setProperties({
          max: maxFrames - 1,
          value: frameSeekValue,
        } as any);
      }
    },
  };
}

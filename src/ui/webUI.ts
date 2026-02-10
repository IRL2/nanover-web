import { Controller } from 'lil-gui';

export interface WebUIContext {
    getFrameSeek: () => Controller;
    getFramePlay: () => Controller;
    updateTrajectoryName: (name: string) => void;
}

let seekSlider: HTMLInputElement | null = null;
let playPauseBtn: HTMLButtonElement | null = null;
let context: WebUIContext | null = null;

export function setupWebUI(ctx: WebUIContext) {
    context = ctx;

    // tab switching
    const tabBtns = document.querySelectorAll<HTMLButtonElement>('.tab-btn');
    const tabContents = document.querySelectorAll<HTMLElement>('.tab-content');
    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            tabBtns.forEach(b => b.classList.remove('active'));
            tabContents.forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            const target = document.getElementById(`tab-${btn.dataset.tab}`);
            if (target) target.classList.add('active');
        });
    });

    // play / pause
    playPauseBtn = document.getElementById('btn-play-pause') as HTMLButtonElement | null;
    if (playPauseBtn) {
        playPauseBtn.addEventListener('click', () => {
            if (!context) return;
            const fp = context.getFramePlay();
            fp.setValue(!fp.getValue());
            syncPlayPauseLabel();
        });
    }

    seekSlider = document.getElementById('seek-slider') as HTMLInputElement | null;
    if (seekSlider) {
        seekSlider.addEventListener('input', () => {
            if (!context || !seekSlider) return;
            const fp = context.getFramePlay();
            const fs = context.getFrameSeek();
            fp.setValue(false);
            fs.setValue(Number(seekSlider.value));
            syncPlayPauseLabel();
        });
    }
}

function syncPlayPauseLabel() {
    if (!playPauseBtn || !context) return;
    const isPlaying = context.getFramePlay().getValue();
    playPauseBtn.textContent = isPlaying ? 'Pause' : 'Play';
}

export function updateWebUI(currentFrame: number, maxFrames: number) {
    if (seekSlider) {
        seekSlider.max = String(Math.max(0, maxFrames - 1));
        seekSlider.value = String(currentFrame);
    }
    syncPlayPauseLabel();
}

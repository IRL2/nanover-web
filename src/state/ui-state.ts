export let isSimulationPlaying = false;
export let selectionTarget: 'single' | 'residue' = 'single';
export let forceType: 'gaussian' | 'spring' | 'constant' = 'spring';

export function setSimulationPlaying(v: boolean) { isSimulationPlaying = v; }

export function setSelectionTarget(v: 'single' | 'residue') { selectionTarget = v; }

export function setForceType(v: 'gaussian' | 'spring' | 'constant') { forceType = v; }

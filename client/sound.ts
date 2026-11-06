// Sounds made with the Web Audio API. No sound files.

const MUTE_KEY = 'bj.muted';

function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

let muted = readMuted();
let ctx: AudioContext | null = null;

export function isMuted(): boolean {
  return muted;
}

export function setMuted(value: boolean): void {
  muted = value;
  try {
    localStorage.setItem(MUTE_KEY, value ? '1' : '0');
  } catch {
    // Remembering the choice is a convenience only.
  }
}

/** Returns the audio context, creating it on first use. Browsers only allow this after a click or tap. */
function audio(): AudioContext | null {
  if (muted) return null;
  try {
    if (!ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** Call from a user gesture so later sounds are allowed to play. */
export function unlockAudio(): void {
  audio();
}

function tone(c: AudioContext, freq: number, start: number, duration: number, type: OscillatorType, peak: number): void {
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, c.currentTime + start);
  gain.gain.setValueAtTime(0.0001, c.currentTime + start);
  gain.gain.exponentialRampToValueAtTime(peak, c.currentTime + start + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + start + duration);
  osc.connect(gain).connect(c.destination);
  osc.start(c.currentTime + start);
  osc.stop(c.currentTime + start + duration + 0.02);
}

/** A short card "flick": a burst of filtered noise. */
export function playDeal(): void {
  const c = audio();
  if (!c) return;
  const length = Math.floor(c.sampleRate * 0.09);
  const buffer = c.createBuffer(1, length, c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 2;
  const src = c.createBufferSource();
  src.buffer = buffer;
  const filter = c.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = 2600;
  filter.Q.value = 0.8;
  const gain = c.createGain();
  gain.gain.value = 0.5;
  src.connect(filter).connect(gain).connect(c.destination);
  src.start();
}

/** Two quick clinks, like chips landing. */
export function playChip(): void {
  const c = audio();
  if (!c) return;
  tone(c, 1900, 0, 0.07, 'triangle', 0.25);
  tone(c, 2500, 0.05, 0.09, 'triangle', 0.2);
}

export function playWin(): void {
  const c = audio();
  if (!c) return;
  [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(c, f, i * 0.1, 0.22, 'triangle', 0.25));
}

export function playLose(): void {
  const c = audio();
  if (!c) return;
  [392, 329.63, 261.63].forEach((f, i) => tone(c, f, i * 0.14, 0.28, 'sawtooth', 0.12));
}

// Sounds: short recorded effects from Kenney's Casino Audio pack (CC0, see CREDITS.md), played with the
// Web Audio API. The win and lose jingles are still generated in code, since the pack has no match for them.
//
// The files are .mp3 because Safari on iPhone does not play .ogg before iOS 18.4.

const MUTE_KEY = 'poker.muted';

/** Master volume, 0 to 1. There is no volume slider; change this to make every sound quieter or louder. */
const MASTER_VOLUME = 0.8;

/** Playback speed varies a little around 1, so repeated sounds do not feel robotic. */
const RATE_MIN = 0.95;
const RATE_MAX = 1.05;

/** Which files are used for which event. Where there are several, one is picked at random. */
const FILES = {
  deal: ['card-slide-1', 'card-slide-2', 'card-slide-3', 'card-slide-4'],
  flip: ['card-place-1'],
  shuffle: ['card-shuffle'],
  chip: ['chip-lay-1', 'chip-lay-2', 'chip-lay-3'],
  payout: ['chips-handle-5'],
  // The all-in sound layers three short chip sounds one after another, to sound bigger than a single bet.
  allIn: ['chips-collide-4', 'chips-stack-1', 'chips-stack-6'],
} as const;

const ALL_FILES: string[] = [...new Set(Object.values(FILES).flat())];

function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

let muted = readMuted();
let ctx: AudioContext | null = null;
let master: GainNode | null = null;
const buffers = new Map<string, AudioBuffer>();
let loading = false;

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
      master = ctx.createGain();
      master.gain.value = MASTER_VOLUME;
      master.connect(ctx.destination);
      void loadAll(ctx);
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

/** decodeAudioData in its callback form, which older Safari versions need. */
function decode(c: AudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise((resolve, reject) => c.decodeAudioData(data, resolve, reject));
}

async function loadAll(c: AudioContext): Promise<void> {
  if (loading) return;
  loading = true;
  await Promise.all(
    ALL_FILES.map(async (name) => {
      try {
        const res = await fetch(new URL(`sounds/${name}.mp3`, document.baseURI));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        buffers.set(name, await decode(c, await res.arrayBuffer()));
      } catch (err) {
        console.warn(`Could not load the sound ${name}`, err);
      }
    }),
  );
}

function pick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)]!;
}

/** Plays one loaded file with a slightly random speed. Silently does nothing if it has not loaded yet. */
function playFile(name: string, opts: { delay?: number; gain?: number } = {}): void {
  const c = audio();
  if (!c || !master) return;
  const buffer = buffers.get(name);
  if (!buffer) return;
  const src = c.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = RATE_MIN + Math.random() * (RATE_MAX - RATE_MIN);
  const gain = c.createGain();
  gain.gain.value = opts.gain ?? 1;
  src.connect(gain).connect(master);
  src.start(c.currentTime + (opts.delay ?? 0));
}

/** A hole card or board card dealt. */
export function playDeal(): void {
  playFile(pick(FILES.deal));
}

/** Cards turned face up at showdown, or a hand folded. */
export function playFlip(): void {
  playFile(pick(FILES.flip));
}

/** A new hand starts with a fresh shuffle. */
export function playShuffle(): void {
  playFile(pick(FILES.shuffle));
}

/** A bet, call or raise. */
export function playChip(): void {
  playFile(pick(FILES.chip));
}

/** A pot pushed to its winner. */
export function playPayout(): void {
  playFile(pick(FILES.payout));
}

/** All in: a quick cascade of chip sounds. */
export function playAllIn(): void {
  FILES.allIn.forEach((name, i) => playFile(name, { delay: i * 0.09, gain: 1 }));
}

function tone(c: AudioContext, freq: number, start: number, duration: number, type: OscillatorType, peak: number): void {
  if (!master) return;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, c.currentTime + start);
  gain.gain.setValueAtTime(0.0001, c.currentTime + start);
  gain.gain.exponentialRampToValueAtTime(peak, c.currentTime + start + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + start + duration);
  osc.connect(gain).connect(master);
  osc.start(c.currentTime + start);
  osc.stop(c.currentTime + start + duration + 0.02);
}

/** A check: two short, soft knocks on the table. Generated in code: the pack has no knock. */
export function playKnock(): void {
  const c = audio();
  if (!c || !master) return;
  for (const start of [0, 0.11]) {
    const osc = c.createOscillator();
    const gain = c.createGain();
    const t = c.currentTime + start;
    osc.type = 'sine';
    osc.frequency.setValueAtTime(190, t);
    osc.frequency.exponentialRampToValueAtTime(70, t + 0.07);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.35, t + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    osc.connect(gain).connect(master);
    osc.start(t);
    osc.stop(t + 0.1);
  }
}

/** A short rising chime, played when I win a hand. Generated in code: the pack has no jingles. */
export function playWin(): void {
  const c = audio();
  if (!c) return;
  [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(c, f, 0.12 + i * 0.1, 0.22, 'triangle', 0.18));
}

/** A short falling tone for a lost hand. Generated in code. */
export function playLose(): void {
  const c = audio();
  if (!c) return;
  [392, 329.63, 261.63].forEach((f, i) => tone(c, f, i * 0.14, 0.28, 'sawtooth', 0.12));
}

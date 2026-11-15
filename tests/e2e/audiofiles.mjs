// Audio files for tests (written at runtime): WAV in various forms,
// a sung melody and a simple drum bar.

import { writeFileSync } from "node:fs";

/** Writes a WAV: `channels` = list of sample arrays (−1…1), 16 or 24 bit (24 as WAVE_FORMAT_EXTENSIBLE). */
export function writeWav(path, channels, sr, bits = 16) {
  const ch = channels.length;
  const n = channels[0].length;
  const bytes = bits / 8;
  const extensible = bits === 24;
  const fmtLen = extensible ? 40 : 16;
  const data = Buffer.alloc(n * ch * bytes);
  let o = 0;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, channels[c][i]));
      if (bits === 16) data.writeInt16LE(Math.round(v * 32767), o);
      else data.writeIntLE(Math.round(v * 8388607), o, 3);
      o += bytes;
    }
  }
  const head = Buffer.alloc(12 + 8 + fmtLen + 8);
  head.write("RIFF", 0);
  head.writeUInt32LE(head.length - 8 + data.length, 4);
  head.write("WAVE", 8);
  head.write("fmt ", 12);
  head.writeUInt32LE(fmtLen, 16);
  head.writeUInt16LE(extensible ? 0xfffe : 1, 20);
  head.writeUInt16LE(ch, 22);
  head.writeUInt32LE(sr, 24);
  head.writeUInt32LE(sr * ch * bytes, 28);
  head.writeUInt16LE(ch * bytes, 32);
  head.writeUInt16LE(bits, 34);
  if (extensible) {
    head.writeUInt16LE(22, 36);
    head.writeUInt16LE(bits, 38);
    head.writeUInt32LE(ch === 2 ? 3 : 4, 40);
    Buffer.from([1, 0, 0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71]).copy(head, 44);
  }
  head.write("data", 12 + 8 + fmtLen);
  head.writeUInt32LE(data.length, 12 + 8 + fmtLen + 4);
  writeFileSync(path, Buffer.concat([head, data]));
}

/** "Sung" melody (fundamental + overtones, vibrato); each note [MIDI, seconds], with a 40 ms pause between. */
export function sing(notes, sr) {
  const out = [];
  let phase = 0;
  for (const [midi, secs] of notes) {
    const n = Math.round(secs * sr);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const vib = 0.15 * Math.sin(2 * Math.PI * 5.5 * t);
      const f = 440 * 2 ** ((midi + vib - 69) / 12);
      phase += (2 * Math.PI * f) / sr;
      const env = Math.min(1, t / 0.02) * Math.max(0, Math.min(1, (secs - t) / 0.03));
      out.push(env * (0.4 * Math.sin(phase) + 0.15 * Math.sin(2 * phase) + 0.06 * Math.sin(3 * phase)));
    }
    for (let i = 0; i < Math.round(0.04 * sr); i++) out.push(0);
  }
  return out;
}

/** Simple random numbers (repeatable). */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 31 - 1;
  };
}

/**
 * Drums: `steps` sixteenths at `bpm`; `pattern` = { kick: [steps], snare: [...], hat: [...] }.
 * Bass drum = sine with falling pitch, snare = shell tone + noise, hi-hat = high-passed noise.
 */
export function drums(pattern, steps, bpm, sr) {
  const step = 60 / bpm / 4;
  const out = new Float64Array(Math.round((steps * step + 0.5) * sr));
  const rand = rng(7);
  const add = (start, len, fn) => {
    const a = Math.round(start * sr);
    for (let i = 0; i < Math.round(len * sr) && a + i < out.length; i++) out[a + i] += fn(i / sr);
  };
  for (const s of pattern.kick ?? []) {
    let ph = 0;
    add(s * step, 0.3, (t) => {
      const f = 50 + 110 * Math.exp(-t / 0.03);
      ph += (2 * Math.PI * f) / sr;
      return 0.9 * Math.exp(-t / 0.12) * Math.sin(ph);
    });
  }
  for (const s of pattern.snare ?? []) {
    add(s * step, 0.2, (t) => Math.exp(-t / 0.07) * (0.35 * Math.sin(2 * Math.PI * 185 * t) + 0.5 * rand()));
  }
  for (const s of pattern.hat ?? []) {
    let prev = 0;
    let prev2 = 0;
    add(s * step, 0.06, (t) => {
      const x = rand();
      const hp = x - 2 * prev + prev2; // differentiated twice: highs only
      prev2 = prev;
      prev = x;
      return 0.25 * Math.exp(-t / 0.02) * hp;
    });
  }
  return Array.from(out);
}

/** Plucked notes, one every `beatSecs` (sharp attack, decaying, with overtones) – a clear pulse for the tempo.
 *  A note is a MIDI number or `{ midi, amp, accent, secs }`: amplitude factor, attack gain falling back
 *  within about 30 ms (4 = a sforzato 12 dB above), sounding seconds (shorter = staccato). */
export function plucked(notes, beatSecs, sr) {
  const out = [];
  for (const note of notes) {
    const { midi, amp = 1, accent = 1, secs = beatSecs - 0.04 } = typeof note === "number" ? { midi: note } : note;
    const f = 440 * 2 ** ((midi - 69) / 12);
    const n = Math.round(beatSecs * sr);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const gain = amp * (1 + (accent - 1) * Math.exp(-t / 0.03));
      const env = Math.min(1, t / 0.005) * Math.exp(-t * 2) * Math.max(0, Math.min(1, (secs - t) / 0.02));
      const w = 2 * Math.PI * f * t;
      out.push(gain * env * (0.15 * Math.sin(w) + 0.056 * Math.sin(2 * w) + 0.022 * Math.sin(3 * w)));
    }
  }
  return out;
}

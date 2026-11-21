// Drums with pitch: notes off the drum keys play tuned drums (drum kit), the
// switch "Keys: drum kit | pitch" in the Sound window plays every key by
// pitch – audible in playback, at the right pitch in the exported WAV, the same
// via the agent; the track shows what its keys play, the rhythm window only
// offers drum tracks in the drum kit, and a beat on the drum keys is unchanged.
import { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { startApp, makeTest, sleep } from "./harness.mjs";

let app;
const test = makeTest(() => app);
before(async () => {
  app = await startApp();
});
after(async () => {
  await app?.close();
});

const track = (id) => app.eval((id) => T.st.snapshot.peek().project.tracks.find((t) => t.id === id), id);

/** Empty project with one drums track holding `pitches` (half beats, twice); returns its id. */
async function drumsTrack(pitches = [60, 64, 67, 72], params = {}) {
  await app.reset();
  return app.eval(async (pitches, params) => {
    await T.st.run({ type: "addTrack", track: { id: 0, name: "Trommelmelodie", kind: "instrument" } });
    const t = T.st.snapshot.peek().project.tracks.at(-1);
    const notes = [...pitches, ...pitches].map((pitch, i) => ({ pitch, startBeats: i * 0.5, lengthBeats: 0.45, velocity: 110 }));
    await T.st.run({ type: "addClip", trackId: t.id, clip: { id: 0, name: "Melodie", startBeats: 0, source: { type: "notes", lengthBeats: Math.max(4, notes.length / 2), notes } } });
    await T.st.run({ type: "setTrack", trackId: t.id, patch: { instrument: { kind: "drums", preset: "standard", params } } });
    return t.id;
  }, pitches, params);
}

/** Plays from the start for `ms`; highest output level (measured even when muted). */
async function playLevel(ms = 1500) {
  await app.eval(async () => {
    await window.__TAURI__.core.invoke("seek", { seconds: 0 });
    await window.__TAURI__.core.invoke("transport", { action: "play" });
  });
  await app.waitFor(() => T.st.status.peek().playing, { what: "spielt" });
  let peak = 0;
  for (const end = Date.now() + ms; Date.now() < end; ) {
    await sleep(40);
    peak = Math.max(peak, await app.eval(() => T.st.status.peek().peakOut));
  }
  await app.eval(() => window.__TAURI__.core.invoke("transport", { action: "stop" }));
  await app.waitFor(() => !T.st.status.peek().playing, { what: "Stopp" });
  return peak;
}

/** Left channel of a WAV written by Klangwelt (44-byte header). */
function wavLeft(path) {
  const b = readFileSync(path);
  const bits = b.readUInt16LE(34);
  const step = b.readUInt16LE(32);
  const out = [];
  for (let i = 44; i + step <= b.length; i += step) out.push(bits === 24 ? b.readIntLE(i, 3) / 8388608 : b.readInt16LE(i) / 32768);
  return out;
}

/** Energy at frequency `f` in 0.25 s from sample `from` at 48 kHz (Goertzel). */
function energyAt(x, f, from) {
  let re = 0;
  let im = 0;
  for (let i = 0; i < 12000; i++) {
    const w = (2 * Math.PI * f * i) / 48000;
    re += (x[from + i] ?? 0) * Math.cos(w);
    im += (x[from + i] ?? 0) * Math.sin(w);
  }
  return Math.hypot(re, im);
}

test("a melody on a drums track is heard – in the drum kit and by pitch", async () => {
  const id = await drumsTrack();
  const kit = await playLevel();
  assert.ok(kit > 0.02, `Schlagzeug: Pegel ${kit}`);
  await app.mcp("set_sound", { trackId: id, params: { tasten: 1 } });
  assert.equal((await track(id)).instrument.params.tasten, 1);
  const pitched = await playLevel();
  assert.ok(pitched > 0.02, `Tonhöhe: Pegel ${pitched}`);
});

test("export: tuned drums sound at the pitch of their notes, toms by pitch", async () => {
  // four C4, then four G4 in half beats (tempo 120: a hit every 0.25 s)
  const id = await drumsTrack([60, 60, 60, 60, 67, 67, 67, 67], { tasten: 1 });
  await app.eval(() => T.st.run({ type: "setProject", patch: { tempoBpm: 120 } }));
  assert.equal((await track(id)).instrument.params.tasten, 1);
  const r = await app.mcp("export_project", { format: "wav", name: "Toms nach Tonhöhe" });
  const x = wavLeft(r.path);
  const [c4, g4] = [261.63, 392.0];
  const first = 0.25 * 48000; // second C4 hit
  const second = 1.25 * 48000; // second G4 hit
  assert.ok(energyAt(x, c4, first) > 2 * energyAt(x, g4, first), `C4: ${energyAt(x, c4, first)} vs ${energyAt(x, g4, first)}`);
  assert.ok(energyAt(x, g4, second) > 2 * energyAt(x, c4, second), `G4: ${energyAt(x, g4, second)} vs ${energyAt(x, c4, second)}`);
});

test("a beat on the drum keys sounds exactly as before – the switch changes it only by pitch", async () => {
  // kick, hi-hat, snare on their drum keys (their sound is pinned bit for bit by the Rust tests)
  const beat = [36, 42, 38, 42];
  const id = await drumsTrack(beat);
  await app.eval(() => T.st.run({ type: "setProject", patch: { tempoBpm: 120 } }));
  const a = wavLeft((await app.mcp("export_project", { format: "wav", name: "Beat" })).path);
  // by pitch the same keys are tuned drums – audibly different
  await app.mcp("set_sound", { trackId: id, params: { tasten: 1 } });
  const b = wavLeft((await app.mcp("export_project", { format: "wav", name: "Beat nach Tonhöhe" })).path);
  // back to the drum kit: identical to the first export
  await app.mcp("set_sound", { trackId: id, params: { tasten: 0 } });
  const c = wavLeft((await app.mcp("export_project", { format: "wav", name: "Beat wieder" })).path);
  assert.equal(a.length, c.length);
  assert.ok(a.every((v, i) => v === c[i]), "Schlagzeug wieder wie vorher");
  const diff = a.reduce((m, v, i) => Math.max(m, Math.abs(v - (b[i] ?? 0))), 0);
  assert.ok(diff > 0.05, `nach Tonhöhe anders: ${diff}`);
  // the hi-hat (42) is noise up high in the drum kit, a tuned kick drum (F♯2) by pitch: much less energy above 5 kHz
  const hiss = (x) => { let e = 0; for (let i = 1; i < 24000; i++) e += (x[i] - x[i - 1]) ** 2; return e; };
  assert.ok(hiss(a) > 2 * hiss(b), `Hi-Hat-Rauschen nur im Schlagzeug: ${hiss(a)} vs ${hiss(b)}`);
});

test("Sound window: “Keys” switches drum kit ↔ pitch – one undo step, the track follows", async () => {
  const id = await drumsTrack();
  await app.eval((id) => {
    T.st.selection.value = { trackId: id, clipId: null };
    T.st.showPanel("klang");
  }, id);
  await app.waitFor(() => T.$(".snd-keys .seg-btn"), { what: "Tasten-Schalter" });
  await app.eval(() => T.$(".snd-play .seg-btn[data-mode=aus]").click()); // quiet
  const ui = () => app.eval(async (id) => {
    const pr = await import("./pianoroll.js");
    const tracks = await import("./components/tracks.js");
    const t = T.st.snapshot.peek().project.tracks.find((x) => x.id === id);
    return {
      buttons: T.$$(".snd-keys .seg-btn").map((b) => b.textContent),
      on: T.$(".snd-keys .seg-btn.on")?.textContent,
      hint: T.$(".snd-keys-hint").textContent,
      hatIdle: T.$('.snd-fine .pgroup[data-group="Hi-Hat"]').classList.contains("idle"),
      mode: pr.drumMode(t),
      view: pr.viewFor(t),
      drumKeys: tracks.drumKeyNames(t)?.size ?? 0,
    };
  }, id);
  let s = await ui();
  assert.deepEqual(s.buttons, ["Schlagzeug", "Tonhöhe"]);
  assert.equal(s.on, "Schlagzeug");
  assert.match(s.hint, /alle anderen Tasten spielen eine gestimmte Trommel/);
  assert.equal(s.hatIdle, false);
  assert.ok(s.drumKeys >= 13, `Trommelnamen an der Tastatur: ${s.drumKeys}`);
  assert.ok(s.view.low <= 36 && s.view.low + s.view.span > 72, `Ansicht Schlagzeug: ${JSON.stringify(s.view)}`);

  await app.clickOn(".snd-keys .seg-btn", { text: "Tonhöhe" });
  await app.waitFor((id) => T.st.snapshot.peek().project.tracks.find((t) => t.id === id).instrument.params.tasten === 1, { what: "tasten = 1" }, id);
  s = await ui();
  assert.equal(s.on, "Tonhöhe");
  assert.equal(s.mode, "pitch");
  assert.equal(s.hatIdle, true, "Hi-Hat ruht nach Tonhöhe");
  assert.match(s.hint, /unter C3 Bassdrum, C3 bis H4 Tom, ab C5 Snare/);
  assert.equal(s.drumKeys, 0, "nach Tonhöhe keine Trommelnamen");
  assert.ok(s.view.low > 40 && s.view.low <= 60 && s.view.low + s.view.span > 72, `Ansicht Tonhöhe: ${JSON.stringify(s.view)}`);

  await app.eval(() => T.st.act(window.__TAURI__.core.invoke("undo")));
  await app.waitFor(() => T.$(".snd-keys .seg-btn.on")?.textContent === "Schlagzeug", { what: "Schalter nach Undo" });
  s = await ui();
  assert.equal(s.mode, "kit");
  assert.ok(s.view.low <= 36, `Ansicht nach Undo: ${JSON.stringify(s.view)}`);
});

test("agent: the drums describe the keys switch; by pitch the track transposes", async () => {
  const list = await app.mcp("list_instruments", {});
  const drums = list.instrumente.find((i) => i.kind === "drums");
  const keys = drums.params.find((p) => p.key === "tasten");
  assert.ok(keys && keys.hidden && keys.default === 0, JSON.stringify(keys));
  assert.match(drums.description, /gestimmte Trommel/);
  const id = await drumsTrack([60]);
  await app.eval((id) => T.st.run({ type: "setTrack", trackId: id, patch: { pitchSemitones: 7 } }), id);
  // drum kit: transposing would change the drum, so it does not apply – C4 stays a tom at C4
  const kit = wavLeft((await app.mcp("export_project", { format: "wav", name: "Kit transponiert" })).path);
  await app.mcp("set_sound", { trackId: id, params: { tasten: 1 } });
  const pitched = wavLeft((await app.mcp("export_project", { format: "wav", name: "Tonhöhe transponiert" })).path);
  const [c4, g4] = [261.63, 392.0];
  assert.ok(energyAt(kit, c4, 0) > 2 * energyAt(kit, g4, 0), `Schlagzeug: ${energyAt(kit, c4, 0)} vs ${energyAt(kit, g4, 0)}`);
  assert.ok(energyAt(pitched, g4, 0) > 2 * energyAt(pitched, c4, 0), `Tonhöhe +7: ${energyAt(pitched, g4, 0)} vs ${energyAt(pitched, c4, 0)}`);
});

test("Rhythm window offers only drum tracks in the drum kit", async () => {
  const id = await drumsTrack();
  const options = async () => {
    await app.eval(() => T.st.showPanel("rhythmus"));
    await app.waitFor(() => T.$(".rh-target option"), { what: "Rhythmus-Ziel" });
    return app.eval(() => T.$$(".rh-target option").map((o) => o.value));
  };
  assert.ok((await options()).includes(String(id)), "Schlagzeug: Ziel im Rhythmus-Fenster");
  await app.mcp("set_sound", { trackId: id, params: { tasten: 1 } });
  await app.waitFor((id) => !T.$$(".rh-target option").some((o) => o.value === String(id)), { what: "nach Tonhöhe kein Ziel" }, id);
  assert.deepEqual(await options(), ["neu"]);
});

test("no errors in the window", () => {
  assert.deepEqual(app.errors, []);
});

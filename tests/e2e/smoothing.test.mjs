// Smoothing notes from recordings on the desktop: pitch detection breaks a sung line into
// fragments (an octave slip, a breathy voice break, a scoop). The strength chosen in the gear
// menu or the analysis window decides what converting the recording keeps; afterwards the
// menu of selected notes and the menu of a note clip smooth them – one undo step each – and
// the agent has smooth_notes and the smooth argument of audio_to_notes.
import { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { startApp, makeTest, noteGeo, geoFns } from "./harness.mjs";
import { writeWav } from "./audiofiles.mjs";

let app;
const test = makeTest(() => app);
let wav;

/**
 * A sung line, two beats per note at 120 BPM – each part (MIDI, seconds, kind: 0 tone,
 * 1 noise at the same level, 2 silence): c' with an octave slip, e' with a breathy voice
 * break, a scoop d' → g', d' d' re-struck after a breath, c'. The same signal as in the
 * core's test (klangwelt crates/klang-app/src/convert.rs).
 */
function brokenRecording(sr) {
  const parts = [
    [60, 0.44, 0], [72, 0.13, 0], [60, 0.39, 0], [0, 0.04, 2],
    [64, 0.47, 0], [64, 0.05, 1], [64, 0.44, 0], [0, 0.04, 2],
    [62, 0.11, 0], [67, 0.85, 0], [0, 0.04, 2],
    [62, 0.44, 0], [0, 0.06, 2], [62, 0.44, 0], [0, 0.06, 2],
    [60, 0.9, 0], [0, 0.1, 2],
  ];
  const x = [];
  let phase = 0;
  let noise = 0x2545f491;
  let since = 0;
  for (const [midi, secs, kind] of parts) {
    const f = 440 * 2 ** ((midi - 69) / 12);
    for (let i = 0; i < Math.floor(secs * sr); i++) {
      const env = Math.min(1, since / 0.015);
      since += 1 / sr;
      if (kind === 0) {
        phase += (2 * Math.PI * f) / sr;
        x.push(env * (0.4 * Math.sin(phase) + 0.15 * Math.sin(2 * phase) + 0.06 * Math.sin(3 * phase)));
      } else if (kind === 1) {
        noise = (noise ^ (noise << 13)) >>> 0;
        noise = (noise ^ (noise >>> 17)) >>> 0;
        noise = (noise ^ (noise << 5)) >>> 0;
        x.push(0.3 * env * ((noise / 4294967295) * 2 - 1) * 1.7);
      } else {
        since = 0;
        x.push(0);
      }
    }
  }
  return x;
}

before(async () => {
  app = await startApp();
  wav = join(app.tmp, "Gesang mit Brüchen.wav");
  writeWav(wav, [brokenRecording(44_100)], 44_100);
});
after(async () => {
  await app?.close();
});
beforeEach(async () => {
  await app.reset();
  await app.eval(async () => {
    (await import("./smoothing.js")).setSmoothLevel("medium");
    T.st.viewport.value = { pxPerBeat: 60, scrollX: 0, scrollY: 0 };
    T.st.showPanel("spuren");
  });
});

const project = () => app.eval(() => T.st.snapshot.peek().project);
const undoLabel = () => app.eval(() => T.st.snapshot.peek().undoLabel);
const toast = () => app.eval(() => document.querySelector("kw-toast")?.textContent ?? "");
const level = () => app.eval(async () => (await import("./smoothing.js")).smoothLevel.peek());
const undo = () => app.eval(async () => { await (await import("./actions.js")).undo(); });
async function contextMenu(x, y) {
  await app.click(x, y, { button: "right" });
  await app.waitFor(() => !!document.querySelector(".ctx-menu"), { what: "context menu" });
}

async function importRecording() {
  const r = await app.eval((p) => window.__TAURI__.core.invoke("audio_import", { paths: [p], trackId: null, startBeats: 0 }), wav);
  await app.eval((s) => (T.st.snapshot.value = s), r.snapshot);
  await app.eval(() => T.sleep(200));
  return r.imported[0];
}
const melodyTrack = async () => (await project()).tracks.find((t) => t.name.startsWith("Melodie aus"));

test("converting a recording: the gear menu and the analysis window choose the strength – off keeps the fragments, medium the sung line", async () => {
  const rec = await importRecording();

  // gear menu: off
  await app.clickOn('[data-help="einstellungen"]');
  await app.waitFor(() => document.querySelectorAll(".set-menu.open [data-smooth]").length === 4, { what: "smoothing in the settings" });
  assert.deepEqual(await app.eval(() => T.$$(".set-menu.open [data-smooth]").map((b) => [b.textContent, b.getAttribute("aria-pressed")])),
    [["Aus", "false"], ["Leicht", "false"], ["Mittel", "true"], ["Stark", "false"]]);
  await app.clickOn('.set-menu.open [data-smooth="off"]');
  assert.equal(await level(), "off");

  // the button on the clip converts with it
  const btn = await app.waitFor((id) => T.$("kw-timeline").noteButtonRect(id), { what: "button on the clip" }, rec.clipId);
  await app.click(btn.x + btn.w / 2, btn.y + btn.h / 2);
  await app.waitFor(() => T.st.snapshot.peek().project.tracks.length === 2, { what: "melody track", timeout: 20000 });
  const raw = (await melodyTrack()).clips[0].source.notes.map((n) => n.pitch);
  assert.ok(raw.length >= 9 && raw.includes(72), `broken up, with the octave slip: ${raw}`);
  await undo();

  // analysis window: medium
  await app.eval(async (sel) => {
    T.st.selection.value = sel;
    await (await import("./actions.js")).analyzeSelected();
  }, { trackId: rec.trackId, clipId: rec.clipId });
  await app.waitFor(() => T.$$("kw-panel[tab=analyse] .smooth-choice [data-smooth]").length === 4, { what: "smoothing in the analysis window", timeout: 20000 });
  assert.equal(await app.eval(() => T.$('kw-panel[tab=analyse] .smooth-choice [data-smooth="off"]').getAttribute("aria-pressed")), "true");
  await app.clickOn('kw-panel[tab=analyse] .smooth-choice [data-smooth="medium"]');
  await app.waitFor(() => T.$('kw-panel[tab=analyse] .smooth-choice [data-smooth="medium"]').classList.contains("on"), { what: "medium marked" });
  assert.equal(await level(), "medium");
  await app.eval(() => T.st.showPanel("spuren"));

  // the clip's context menu converts with it
  const g = await noteGeo(app, rec.trackId);
  await contextMenu(g.cx + 1.5 * g.ppb - g.scrollX, g.rowY + 30);
  await app.clickOn(".ctx-menu [data-act=melodie]");
  await app.waitFor(() => T.st.snapshot.peek().project.tracks.length === 2, { what: "melody track", timeout: 20000 });
  const mel = await melodyTrack();
  assert.deepEqual(mel.clips[0].source.notes.map((n) => n.pitch), [60, 64, 67, 62, 62, 60], "the line as it was sung");
  assert.deepEqual(mel.clips[0].source.notes.slice(0, 3).map((n) => n.startBeats), [0, 2, 4]);
  assert.match(await toast(), /6 Noten \(auf Sechzehntel gerastert, \d+ Bruchstücke geglättet\)/);
  assert.equal(await undoLabel(), "In Melodie-Spur umwandeln");
});

test("menu of selected notes and of a note clip: Smooth – fragments merged, one undo step; nothing left says so", async () => {
  const notes0 = [
    { pitch: 60, startBeats: 0, lengthBeats: 0.9, velocity: 100 },
    { pitch: 72, startBeats: 0.9, lengthBeats: 0.18, velocity: 100 },
    { pitch: 60, startBeats: 1.08, lengthBeats: 0.92, velocity: 100 },
    { pitch: 63, startBeats: 2, lengthBeats: 0.12, velocity: 110 },
    { pitch: 64, startBeats: 2.12, lengthBeats: 0.88, velocity: 90 },
    { pitch: 67, startBeats: 3, lengthBeats: 1, velocity: 100 },
  ];
  const trackId = await app.eval(async (notes) => {
    await T.st.run({ type: "addTrack", track: { id: 0, name: "Gesungen", kind: "instrument" } });
    const t = T.st.snapshot.peek().project.tracks.at(-1);
    if (t.view !== "notes") await T.st.run({ type: "setTrack", trackId: t.id, patch: { view: "notes" } });
    await T.st.run({ type: "addClip", trackId: t.id, clip: { id: 0, name: "Noten", startBeats: 0, source: { type: "notes", lengthBeats: 4, notes } } });
    T.pr.pitchViews.update((m) => ({ ...m, [t.id]: { low: 55, span: 21 } }));
    await T.sleep(250);
    return t.id;
  }, notes0);
  const g = geoFns(await noteGeo(app, trackId));
  const notes = () => app.eval((id) => T.st.snapshot.peek().project.tracks.find((t) => t.id === id).clips[0].source.notes
    .map((n) => `${n.pitch}@${+n.startBeats.toFixed(4)}/${+n.lengthBeats.toFixed(4)} v${n.velocity}`), trackId);
  await app.eval((id, keys) => {
    const t = T.st.snapshot.peek().project.tracks.find((t) => t.id === id);
    T.pr.noteSel.value = { trackId: id, clipId: t.clips[0].id, keys };
    T.st.selection.value = { trackId: id, clipId: t.clips[0].id };
  }, trackId, notes0.map((n) => `${n.pitch}@${n.startBeats}`));

  await contextMenu(g.X(3.5), g.Y(67));
  assert.deepEqual(await app.eval(() => [...T.$$('.ctx-menu .ctx-row[data-act="glaetten"] .ctx-chip')].map((c) => c.textContent)), ["Leicht", "Mittel", "Stark"]);
  await app.clickOn('.ctx-menu [data-act="glaetten-medium"]');
  await app.waitFor((id) => T.st.snapshot.peek().project.tracks.find((t) => t.id === id).clips[0].source.notes.length === 3, { what: "smoothed" }, trackId);
  assert.deepEqual(await notes(), ["60@0/2 v100", "64@2/1 v110", "67@3/1 v100"], "slip and scoop gone; the scoop's attack stays");
  assert.equal(await undoLabel(), "Noten glätten (mittel)");
  assert.match(await toast(), /Geglättet \(Mittel\): 3 Bruchstücke zusammengelegt/);
  await undo();
  assert.equal((await notes()).length, 6, "undo brings the fragments back");

  // without a selection: the clip's menu
  await app.eval(() => (T.pr.noteSel.value = null));
  await contextMenu(g.X(3.5), g.Y(72));
  await app.clickOn('.ctx-menu [data-act="glaetten-clip-light"]');
  await app.waitFor((id) => T.st.snapshot.peek().project.tracks.find((t) => t.id === id).clips[0].source.notes.length === 3, { what: "clip smoothed" }, trackId);
  assert.deepEqual(await notes(), ["60@0/2 v100", "64@2/1 v110", "67@3/1 v100"], "light catches these clear fragments, too");
  assert.equal(await undoLabel(), "Noten glätten (leicht)");
  // nothing left even for strong: a message, no undo step
  await contextMenu(g.X(3.5), g.Y(72));
  await app.clickOn('.ctx-menu [data-act="glaetten-clip-strong"]');
  await app.waitFor(() => /nichts zu glätten/.test(document.querySelector("kw-toast")?.textContent ?? ""), { what: "nothing to smooth" });
  assert.equal(await undoLabel(), "Noten glätten (leicht)");
});

test("agent: audio_to_notes smooths unless smooth is off; smooth_notes smooths a clip – one undo step", async () => {
  const rec = await importRecording();
  const off = await app.mcp("audio_to_notes", { trackId: rec.trackId, target: "melodie", smooth: "off" });
  assert.equal(off.geglaettet, 0);
  assert.ok(off.noten >= 9, `kept every detected note: ${off.noten}`);
  await undo();
  const on = await app.mcp("audio_to_notes", { trackId: rec.trackId, target: "melodie" });
  assert.equal(on.noten, 6, "medium by default");
  assert.equal(on.geglaettet, off.noten - 6);
  await undo();
  await assert.rejects(app.mcp("audio_to_notes", { trackId: rec.trackId, target: "melodie", smooth: "very" }), /'off', 'light', 'medium' or 'strong'/);

  // the fragments as notes, then smooth_notes on the clip: without the recording behind them
  // the slip and the scoop go, the voice break (now a sixteenth rest on the grid) can't be
  // told from a real rest and stays
  const raw = await app.mcp("audio_to_notes", { trackId: rec.trackId, target: "melodie", smooth: "aus" });
  const clip = (await project()).tracks.find((t) => t.id === raw.trackId).clips[0];
  const n = clip.source.notes.length;
  const r = await app.mcp("smooth_notes", { trackId: raw.trackId, clipId: clip.id, strength: "medium" });
  assert.equal(r.geaendert, true);
  assert.ok(r.zusammengelegt >= 2, JSON.stringify(r));
  assert.equal(r.noten.length, n - r.zusammengelegt - r.entfernt, "indices of all notes that came from the clip");
  const pitches = await app.waitFor((id, k) => {
    const notes = T.st.snapshot.peek().project.tracks.find((t) => t.id === id).clips[0].source.notes;
    return notes.length === k && notes.map((x) => x.pitch);
  }, { what: "smoothed in the window" }, raw.trackId, r.noten.length);
  assert.ok(!pitches.includes(72), `the octave slip is gone: ${pitches}`);
  assert.equal(await undoLabel(), "Agent · Noten glätten (mittel)");
  const again = await app.mcp("smooth_notes", { trackId: raw.trackId, clipId: clip.id, strength: "medium" });
  assert.equal(again.geaendert, false, "nothing left at that strength");
  assert.equal(await undoLabel(), "Agent · Noten glätten (mittel)", "no empty undo step");
});

test("no errors in the window", () => {
  assert.deepEqual(app.errors, []);
});

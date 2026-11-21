// Several voices at once on the desktop: a three-voice chorale (harmonic tones of
// equal level) as an inserted recording and as the substitute microphone. The
// analysis window switches to several voices and finds three; converting makes
// one instrument track per voice in one undo step; recording in that mode shows
// the voices live; the agent analyzes and converts with mode "poly".
import { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp, makeTest, noteGeo } from "./harness.mjs";
import { writeWav } from "./audiofiles.mjs";

const SR = 44_100;
const BEAT = 0.6; // 100 BPM
/** (MIDI, beat, beats) per voice: soprano, alto, bass. */
const VOICES = [
  [[76, 0, 1], [74, 1, 1], [72, 2, 1], [74, 3, 1], [76, 4, 1], [76, 5, 1], [76, 6, 2]],
  [[67, 0, 2], [65, 2, 2], [64, 4, 2], [67, 6, 2]],
  [[48, 0, 2], [43, 2, 2], [36, 4, 2], [43, 6, 2]],
];

function chorale() {
  const out = new Array(Math.round((8 * BEAT + 0.4) * SR)).fill(0);
  for (const voice of VOICES) {
    for (const [midi, beat, beats] of voice) {
      const f = 440 * 2 ** ((midi - 69) / 12);
      const dur = beats * BEAT * 0.95;
      const a = Math.round(beat * BEAT * SR);
      for (let i = 0; i < dur * SR; i++) {
        const t = i / SR;
        const env = Math.min(1, t / 0.01) * Math.max(0, Math.min(1, (dur - t) / 0.03)) * Math.exp(-t * 0.8);
        let v = 0;
        for (let h = 1; h <= 8 && f * h < SR * 0.45; h++) v += Math.sin(2 * Math.PI * f * h * t) / h;
        out[a + i] += 0.07 * env * v;
      }
    }
  }
  return out;
}

let app;
let wav;
const test = makeTest(() => app);
before(async () => {
  wav = join(mkdtempSync(join(tmpdir(), "klangwelt-voices-")), "Satz.wav");
  writeWav(wav, [chorale()], SR);
  app = await startApp({ env: { KLANGWELT_FAKE_MIC: wav } });
});
after(async () => {
  await app?.close();
});
beforeEach(async () => {
  await app.reset();
  await app.eval(async () => {
    await T.st.run({ type: "setProject", patch: { tempoBpm: 100 } });
    const v = await import("./voices.js");
    v.setAnalysisMode("mono");
    v.setVoiceCount("auto");
    v.voicesAnalysis.value = null;
    T.st.analysis.value = null;
    T.st.viewport.value = { pxPerBeat: 50, scrollX: 0, scrollY: 0 };
    T.st.showPanel("spuren");
  });
});

const project = () => app.eval(() => T.st.snapshot.peek().project);
const undoLabel = () => app.eval(() => T.st.snapshot.peek().undoLabel);
const undo = () => app.eval(async () => { await (await import("./actions.js")).undo(); });

async function importChorale() {
  const r = await app.eval((p) => window.__TAURI__.core.invoke("audio_import", { paths: [p], trackId: null, startBeats: 0 }), wav);
  await app.eval((s) => (T.st.snapshot.value = s), r.snapshot);
  await app.eval(() => T.sleep(200));
  return r.imported[0];
}

test("analysis window: \"Several voices\" finds three voices in the chorale and converts them into one track each – one undo step", async () => {
  const rec = await importChorale();
  await app.eval(async (sel) => {
    T.st.selection.value = sel;
    await (await import("./actions.js")).analyzeSelected();
  }, { trackId: rec.trackId, clipId: rec.clipId });
  await app.waitFor(() => !!document.querySelector("kw-panel[tab=analyse] .mode-choice"), { what: "mode choice", timeout: 20000 });
  await app.clickOn('kw-panel[tab=analyse] .mode-choice [data-value="poly"]');
  await app.waitFor(() => !!document.querySelector("kw-panel[tab=analyse] .analysis.voices"), { what: "voices panel", timeout: 20000 });
  assert.deepEqual(await app.eval(() => T.$$("kw-panel[tab=analyse] .legend span").map((s) => s.textContent)), ["Stimme 1", "Stimme 2", "Stimme 3", "gefundene Tonhöhen"]);
  const v = await app.eval(async () => (await import("./voices.js")).voicesAnalysis.peek());
  assert.equal(v.voices, 3);
  assert.deepEqual(v.notes.filter((n) => n.voice === 2).map((n) => n.midi), [48, 43, 36, 43], JSON.stringify(v.notes));

  await app.clickOn("kw-panel[tab=analyse] .voices-convert");
  await app.waitFor(() => T.st.snapshot.peek().project.tracks.length === 4, { what: "voice tracks", timeout: 20000 });
  const p = await project();
  assert.deepEqual(p.tracks.map((t) => t.name), ["Satz", "Stimme 1 aus Satz", "Stimme 2 aus Satz", "Bass aus Satz"]);
  assert.equal(p.tracks[3].instrument.kind, "bass");
  assert.deepEqual(p.tracks[2].clips[0].source.notes.map((n) => n.pitch), [67, 65, 64, 67]);
  assert.equal(await undoLabel(), "In Stimmen-Spuren umwandeln");
  await undo();
  assert.equal((await project()).tracks.length, 1, "one undo step");
});

test("context menu of a recording: \"Convert to voice tracks\", in the single-line mode too", async () => {
  const rec = await importChorale();
  const g = await noteGeo(app, rec.trackId);
  await app.click(g.cx + 1.5 * g.ppb - g.scrollX, g.rowY + 30, { button: "right" });
  await app.waitFor(() => !!document.querySelector('.ctx-menu [data-act="stimmen"]'), { what: "menu entry" });
  await app.clickOn('.ctx-menu [data-act="stimmen"]');
  await app.waitFor(() => T.st.snapshot.peek().project.tracks.length === 4, { what: "voice tracks", timeout: 20000 });
  assert.match(await app.eval(() => document.querySelector("kw-toast")?.textContent ?? ""), /3 Spuren angelegt, eine je Stimme/);
});

test("recording with several voices: the live view shows the voices, the finished analysis follows", async () => {
  await app.eval(async () => (await import("./voices.js")).setAnalysisMode("poly"));
  await app.clickOn("kw-transport .btn.rec");
  await app.waitFor(() => !!document.querySelector(".analysis.live"), { what: "live view" });
  assert.match(await app.eval(() => T.$(".analysis.live .live-badge").textContent), /mehrstimmig/);
  await app.waitFor(async () => {
    const v = await window.__TAURI__.core.invoke("record_live_voices");
    return v && v.voices >= 2 && v.notes.length >= 6;
  }, { what: "voices live", timeout: 20000 });
  await app.clickOn("kw-transport .btn.rec");
  await app.waitFor(() => !T.st.status.peek().recording && !!document.querySelector("kw-panel[tab=analyse] .analysis.voices"), { what: "finished voices analysis", timeout: 20000 });
  assert.equal(await app.eval(() => window.__TAURI__.core.invoke("record_live_voices")), null);
});

test("agent: analyze_clip and audio_to_notes with mode \"poly\"", async () => {
  const rec = await importChorale();
  const a = await app.mcp("analyze_clip", { trackId: rec.trackId, clipId: rec.clipId, mode: "poly" });
  assert.equal(a.stimmen, 3);
  assert.equal(a.automatisch, true);
  assert.deepEqual(a.proStimme[2].noten.map((n) => n.name), ["C3", "G2", "C2", "G2"]);
  const two = await app.mcp("analyze_clip", { trackId: rec.trackId, clipId: rec.clipId, mode: "poly", voices: 2 });
  assert.equal(two.stimmen, 2);
  const c = await app.mcp("audio_to_notes", { trackId: rec.trackId, target: "melodie", mode: "poly" });
  assert.equal(c.stimmen, 3);
  assert.equal(c.trackIds.length, 3);
  await app.waitFor(() => T.st.snapshot.peek().project.tracks.length === 4, { what: "voice tracks in the window" });
  assert.equal(await undoLabel(), "Agent · In Stimmen-Spuren umwandeln");
  await assert.rejects(app.mcp("audio_to_notes", { trackId: rec.trackId, target: "melodie", mode: "poly", voices: 9 }), /voices.*1 bis 6/);
});

test("no errors in the window", () => {
  assert.deepEqual(app.errors, []);
});

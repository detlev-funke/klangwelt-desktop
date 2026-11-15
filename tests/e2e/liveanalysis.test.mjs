// Live analysis while recording on the desktop. The app records from a WAV
// instead of a microphone (KLANGWELT_FAKE_MIC – tests never listen to a real
// device): a C major melody, one plucked note every half second (120 BPM).
// While recording, the analysis window shows what sounds right now, the
// level, key and tempo; the core hands out only what is new; after stopping
// the finished analysis replaces the live view.
import { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp, makeTest, sleep } from "./harness.mjs";
import { plucked, writeWav } from "./audiofiles.mjs";

const MELODY = [60, 64, 67, 72, 67, 64, 65, 69, 67, 62, 59, 60];

let app;
const test = makeTest(() => app);
before(async () => {
  const wav = join(mkdtempSync(join(tmpdir(), "klangwelt-mic-")), "melody.wav");
  writeWav(wav, [plucked(MELODY, 0.5, 48_000)], 48_000);
  app = await startApp({ env: { KLANGWELT_FAKE_MIC: wav } });
});
after(async () => {
  await app?.close();
});

const invoke = (cmd, args) => app.eval((c, a) => window.__TAURI__.core.invoke(c, a), cmd, args);
const live = (since = { take: 0, curve: 0, notes: 0, onsets: 0 }) => invoke("record_live", { since });
/** Label → value of the facts in the analysis window. */
const facts = (sel) =>
  app.eval((s) => Object.fromEntries([...document.querySelectorAll(`${s} .prop`)].map((p) => [p.querySelector("label").textContent, p.querySelector(".value").textContent.trim()])), sel);

test("while recording, the analysis window shows the live analysis: note, level, key and tempo", async () => {
  await app.reset();
  assert.equal(await live(), null, "no recording, no live analysis");
  await app.clickOn("kw-transport .btn.rec");
  await app.waitFor(() => T.st.status.peek().liveAnalysis && !!document.querySelector(".analysis.live"), { what: "live view" });

  // tuner: a note of the melody
  const note = await app.waitFor(() => (/^[A-H]/.test(T.$(".live-note").textContent) ? T.$(".live-note").textContent : null), { timeout: 8000, what: "current note" });
  assert.match(note, /^(C|D|E|F|G|A|H)[3-5]$/, note);
  // key and tempo once enough has been played
  const f = await app.waitFor(
    (sel) => {
      const v = Object.fromEntries([...document.querySelectorAll(`${sel} .prop`)].map((p) => [p.querySelector("label").textContent, p.querySelector(".value").textContent.trim()]));
      return v.Tonart === "C-Dur" && Math.abs(parseFloat(v["Tempo-Schätzung"]) - 120) < 5 ? v : null;
    },
    { timeout: 20000, what: "key C major and tempo about 120 BPM" },
    ".analysis.live",
  );
  const bpm = parseFloat(f["Tempo-Schätzung"]);
  assert.ok(Math.abs(bpm - 120) < 5, `tempo ${bpm}`);
  assert.ok(Number(f.Noten) >= 6, `notes: ${f.Noten}`);
  assert.match(f.Eingangspegel, /^−\d+ dB$/, f.Eingangspegel);

  // the core: everything for a new cursor, then only what is new
  const a = await live();
  assert.equal(a.curveFrom, 0);
  assert.ok(a.curve.length > 200 && a.notes.length + a.pending.length >= 6 && a.onsets.length >= 4, `${a.curve.length} points, ${a.notes.length}+${a.pending.length} notes, ${a.onsets.length} onsets`);
  const scale = new Set([0, 2, 4, 5, 7, 9, 11]);
  const off = [...a.notes, ...a.pending].filter((n) => !scale.has(n.midi % 12));
  assert.ok(off.length <= 1, `notes outside C major: ${JSON.stringify(off)}`);
  await sleep(300);
  const b = await live({ take: a.take, curve: a.curve.length, notes: a.notes.length, onsets: a.onsets.length });
  assert.equal(b.curveFrom, a.curve.length);
  assert.ok(b.curve.length > 0 && b.curve.length < 100, `new points: ${b.curve.length}`);
  assert.ok(b.seconds > a.seconds);

  // stop: the finished analysis replaces the live view, the recording is a track
  await app.clickOn("kw-transport .btn.rec");
  await app.waitFor(() => !T.st.status.peek().recording && T.st.analysis.peek() && !document.querySelector(".analysis.live") && !!document.querySelector(".analysis"), { timeout: 15000, what: "finished analysis" });
  const done = await facts(".analysis");
  assert.equal(done.Tonart, "C-Dur");
  assert.ok(Number(done.Noten) >= 6, `notes: ${done.Noten}`);
  const tracks = await app.eval(() => T.st.snapshot.peek().project.tracks.map((t) => [t.kind, t.name]));
  assert.deepEqual(tracks, [["audio", "Aufnahme 1"]]);
  assert.equal(await live(), null);
  assert.equal(await app.eval(() => T.st.status.peek().liveAnalysis), false);
  assert.deepEqual(app.errors, []);
});

test("a second recording starts the live view afresh", async () => {
  if (await app.eval(() => T.st.status.peek().recording)) await app.clickOn("kw-transport .btn.rec");
  await app.waitFor(() => !T.st.status.peek().recording, { timeout: 15000, what: "no recording running" });
  await app.clickOn("kw-transport .btn.rec");
  await app.waitFor(() => !!document.querySelector(".analysis.live"), { what: "live view" });
  const first = await app.waitFor(() => window.__TAURI__.core.invoke("record_live", { since: { take: 0, curve: 0, notes: 0, onsets: 0 } }).then((v) => (v && v.seconds > 0.5 ? v : null)), { what: "running analysis" });
  assert.ok(first.take >= 2, `take ${first.take}`);
  assert.ok(first.seconds < 5, `starts at zero: ${first.seconds} s`);
  await app.clickOn("kw-transport .btn.rec");
  await app.waitFor(() => !T.st.status.peek().recording && !document.querySelector(".analysis.live"), { timeout: 15000, what: "stopped" });
  assert.deepEqual(app.errors, []);
});

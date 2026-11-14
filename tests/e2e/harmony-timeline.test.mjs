// Harmony in the timeline and the circle of fifths: chord progression of the piece with
// key and breaks (band in the ruler, can be toggled, appears when working in the
// Harmony window), the progression follows the playhead, new chords
// are inserted (everything after them moves back) or replace what follows.
import { before, after } from "node:test";
import assert from "node:assert/strict";
import { startApp, makeTest, sleep } from "./harness.mjs";

let app;
const test = makeTest(() => app);
before(async () => {
  app = await startApp();
  await app.eval(async () => {
    T.st.showPanel("harmonie");
    await T.waitFor(() => T.$$(".hc-cell").length === 36, 10000);
    T.hl = await import("./harmonyline.js");
  });
});
after(async () => {
  await app?.close();
});

const sketch = () => app.eval(() => T.$$(".hc-chips .hc-chip:not(.cand) b").map((b) => b.textContent));
const bpm = () => app.eval(() => T.st.snapshot.peek().project.tempoBpm);
const seekBeat = async (beat) => app.eval((s) => window.__TAURI__.core.invoke("seek", { seconds: s }), (beat * 60) / (await bpm()));
const melodyNote = () => app.eval(() => T.st.snapshot.peek().project.tracks.find((t) => t.name === "Melodie").clips[0].source.notes[0].startBeats);
const chordStarts = () => app.eval(() => {
  const t = T.st.snapshot.peek().project.tracks.find((t) => t.name === "Akkorde");
  return [...new Set(t.clips.flatMap((c) => c.source.notes.map((n) => c.startBeats + n.startBeats)))].sort((a, b) => a - b);
});

/** Piece: C – a – F# – G7 – C (one bar each) and a melody note on the last C. */
async function setup() {
  await app.reset();
  await app.mcp("write_chords", { chords: ["C", "a", "Fis", "G7", "C"], key: "C-Dur", beatsPerChord: 4 });
  await app.mcp("execute", { commands: [{ type: "addTrack", track: { id: 0, name: "Melodie", kind: "instrument",
    clips: [{ id: 0, name: "M", startBeats: 0, source: { type: "notes", lengthBeats: 20, notes: [{ pitch: 84, startBeats: 16, lengthBeats: 2, velocity: 60 }] } }] } }] });
  await app.eval(() => {
    const sel = T.$("kw-panel[tab='harmonie'] .hc-select");
    sel.value = "0:d";
    sel.dispatchEvent(new Event("change"));
  });
  await app.waitFor(() => T.hl.harmonyLine.peek()?.chords.length >= 5 && T.hl.harmonyLine.peek().key.name === "C-Dur", { what: "Akkordfolge erkannt", timeout: 8000 });
}

test("chord progression with mood and break; band in the timeline toggleable, explanation on hover", async () => {
  await setup();
  const line = await app.eval(() => T.hl.harmonyLine.peek().chords.map((c) => [c.name, c.mood, c.bruch]));
  const names = line.map((c) => c[0]);
  assert.deepEqual(names.slice(0, 5), ["C", "a", "Fis", "G7", "C"], JSON.stringify(line));
  assert.equal(line[2][2], "tonartfremd", "Fis in C-Dur bricht");
  assert.equal(line[3][1], "spannend");
  assert.equal(line[4][1], "loesend");
  assert.ok(line.filter((c) => c[2]).length === 1, "nur ein Bruch");
  // Band on
  await app.mouse("mouseMoved", 5, 5);
  await app.waitFor(() => !T.hl.harmonyFocus.peek(), { what: "kein Fokus", timeout: 3000 });
  assert.equal(await app.eval(() => T.$(".harmony-toggle").classList.contains("on")), false);
  await app.clickOn(".harmony-toggle");
  assert.equal(await app.eval(() => T.hl.harmonyLaneOn.peek() && localStorage.getItem("klangwelt.harmonie.zeitleiste")), "an");
  assert.equal(await app.eval(() => T.$(".harmony-toggle").classList.contains("on")), true);
  // Explanation in the band above the F#
  const [x, y] = await app.eval(() => {
    const v = T.st.viewport.peek();
    const c = T.$("kw-timeline canvas").getBoundingClientRect();
    return [c.x + 8 * v.pxPerBeat - v.scrollX + 10, c.y + 24];
  });
  await app.mouse("mouseMoved", x, y);
  await sleep(150);
  const tip = await app.eval(() => T.$("kw-timeline canvas").title);
  assert.match(tip, /^Fis ·/, tip);
  assert.match(tip, /Harmonischer Bruch: tonartfremd/, tip);
  // Break drawn in red in the ruler
  const red = await app.eval((x) => {
    const cv = T.$("kw-timeline canvas");
    const r = cv.getBoundingClientRect();
    const k = cv.width / r.width;
    const d = cv.getContext("2d").getImageData(Math.round((x - 10 - r.x) * k), Math.round(22 * k), 1, 1).data;
    return [d[0], d[1], d[2]];
  }, x);
  assert.ok(red[0] > 200 && red[1] < 120, `rote Kante: ${red}`);
  await app.clickOn(".harmony-toggle");
  assert.equal(await app.eval(() => T.hl.harmonyLaneOn.peek()), false);
});

test("working in the harmony window shows the band, leaving hides it again", async () => {
  const c = await app.center("kw-panel[tab='harmonie'] .hc-circle");
  await app.mouse("mouseMoved", c.x, c.y);
  await app.waitFor(() => T.hl.harmonyFocus.peek(), { what: "Fokus im Harmonie-Fenster" });
  await app.mouse("mouseMoved", 300, 300);
  await app.waitFor(() => !T.hl.harmonyFocus.peek(), { what: "Fokus weg", timeout: 3000 });
});

test("the course follows the playback position – it stays when setting the cursor and when switching off", async () => {
  await seekBeat(13); // in the G7
  await app.waitFor(() => T.$$(".hc-chips .hc-chip b").map((b) => b.textContent).at(-1) === "G7", { what: "Verlauf endet mit G7" });
  assert.deepEqual(await sketch(), ["C", "a", "Fis", "G7"]);
  await seekBeat(5); // in the a
  await app.waitFor(() => T.$$(".hc-chips .hc-chip b").map((b) => b.textContent).at(-1) === "a", { what: "Verlauf endet mit a" });
  assert.deepEqual(await sketch(), ["C", "a"]);
  // switched off: stays put
  await app.eval(() => T.$(".hc-follow input").click());
  await seekBeat(13);
  await sleep(400);
  assert.deepEqual(await sketch(), ["C", "a"]);
  await app.eval(() => T.$(".hc-follow input").click());
  await app.waitFor(() => T.$$(".hc-chips .hc-chip b").map((b) => b.textContent).at(-1) === "G7", { what: "wieder G7" });
});

test("insert makes room (everything after it moves back), replace overwrites", async () => {
  await setup();
  await seekBeat(13); // continue writing after G7
  await app.waitFor(() => T.$$(".hc-chips .hc-chip b").map((b) => b.textContent).at(-1) === "G7", { what: "G7 am Cursor" });
  await app.waitFor(() => T.$$(".hc-path .btn.blue").length > 0, { what: "Wege zum Schluss" });
  const append = async () => {
    await app.eval(() => T.$$(".hc-path .btn.blue")[0].click());
    return app.waitFor(() => T.$$(".hc-chips .hc-chip:not(.fixed):not(.cand)").length || null, { what: "neue Akkorde im Verlauf" });
  };
  let fresh = await append();
  assert.equal(await app.eval(() => T.$(".hc-mode .seg-btn.on").dataset.mode), "einfuegen", "Standard: Einfügen");
  const before = await chordStarts();
  await app.eval(() => T.$(".hc-actions .btn.primary").click());
  await app.waitFor((n) => T.st.snapshot.peek().project.tracks.find((t) => t.name === "Melodie").clips[0].source.notes[0].startBeats === 16 + 4 * n, { what: "Melodie rückt nach hinten" }, fresh);
  assert.equal(await melodyNote(), 16 + 4 * fresh);
  const after = await chordStarts();
  assert.equal(after.length, before.length + fresh, "Akkorde eingefügt, keiner ersetzt");
  assert.ok(after.includes(16 + 4 * fresh), "das letzte C ist mitgerückt");
  assert.match(await app.eval(() => T.st.snapshot.peek().undoLabel), /einfügen/);
  // back and replace: melody stays, the C at 16 is overwritten
  await app.eval(() => T.st.act(window.__TAURI__.core.invoke("undo")));
  await app.waitFor(() => T.st.snapshot.peek().project.tracks.find((t) => t.name === "Melodie").clips[0].source.notes[0].startBeats === 16, { what: "zurück" });
  await seekBeat(13);
  await app.waitFor(() => T.$$(".hc-chips .hc-chip b").map((b) => b.textContent).at(-1) === "G7", { what: "wieder G7 am Cursor" });
  await app.eval(() => {
    for (const c of T.$$(".hc-chips .hc-chip:not(.fixed)")) c.remove();
  });
  fresh = await append();
  await app.clickOn(".hc-mode .seg-btn[data-mode=ersetzen]");
  await app.eval(() => T.$(".hc-actions .btn.primary").click());
  await app.waitFor(() => /schreiben/.test(T.st.snapshot.peek().undoLabel ?? ""), { what: "geschrieben" });
  assert.equal(await melodyNote(), 16, "Melodie bleibt stehen");
  assert.equal((await chordStarts()).length, before.length - 1 + fresh, "das letzte C wurde ersetzt");
});

test("agent: mood and breaks in analyze_harmony, write_chords with mode einfuegen", async () => {
  await setup();
  const a = await app.mcp("analyze_harmony", { key: "C-Dur" });
  const fis = a.akkorde.find((c) => c.name === "Fis");
  assert.equal(fis.bruch, "out of key"); // agent-facing, untranslated key
  assert.ok(a.akkorde.every((c) => typeof c.stimmung === "string"));
  await app.mcp("write_chords", { chords: ["d", "G7"], key: "C-Dur", beatsPerChord: 4, startBeats: 16, mode: "einfuegen" });
  assert.equal(await melodyNote(), 24, "Melodie um zwei Takte nach hinten");
});

test("no errors in the window", () => {
  assert.deepEqual(app.errors, []);
});

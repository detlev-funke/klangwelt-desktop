// Note entry on the desktop: double-click in the piano roll adds a note, keyboard
// entry mode (switch next to the piano) adds notes with the letter keys – Shift keeps
// the position (chords), Ctrl keeps its shortcuts – and with clicks on the piano; the
// shortcut line stays right below the last track. Playback that ends at the end of the
// piece leaves the mark there, so typing appends.
import { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startApp, makeTest, noteGeo, geoFns, MOD, sleep } from "./harness.mjs";

let app;
const test = makeTest(() => app);
before(async () => {
  app = await startApp();
});
after(async () => {
  await app?.close();
});

let trackId;
let g; // { X, Y, rulerY }

/**
 * Track "Test" in the piano roll with one clip from beat 4, one bar long, holding 72@3.
 * 80 px per beat (grid ¼), visible pitches 55–75 (keyboard entry: C4 = A).
 */
beforeEach(async () => {
  await app.reset();
  trackId = await app.eval(async () => {
    await T.st.run({ type: "addTrack", track: { id: 0, name: "Test", kind: "instrument" } });
    const t = T.st.snapshot.peek().project.tracks.at(-1);
    if (t.view !== "notes") await T.st.run({ type: "setTrack", trackId: t.id, patch: { view: "notes" } });
    const notes = [{ pitch: 72, startBeats: 3, lengthBeats: 0.5, velocity: 100 }];
    await T.st.run({ type: "addClip", trackId: t.id, clip: { id: 0, name: "Noten", startBeats: 4, source: { type: "notes", lengthBeats: 4, notes } } });
    T.pr.pitchViews.update((m) => ({ ...m, [t.id]: { low: 55, span: 21 } }));
    T.st.viewport.value = { pxPerBeat: 80, scrollX: 0, scrollY: 0 };
    T.st.showPanel("spuren");
    await T.sleep(250);
    return t.id;
  });
  g = geoFns(await noteGeo(app, trackId));
});

async function dblclick(x, y) {
  await app.mouse("mouseMoved", x, y);
  for (const clickCount of [1, 2]) {
    await app.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount });
    await app.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount });
  }
  await sleep(250);
}

const notes = (id = trackId) => app.eval((id) => T.st.snapshot.peek().project.tracks.find((t) => t.id === id).clips
  .flatMap((c) => c.source.notes.map((n) => `${n.pitch}@${c.startBeats + n.startBeats}`)).sort(), id);
const entryNow = () => app.eval(async () => (await import("./noteinput.js")).entry.peek());
const idle = () => app.eval(async () => { await (await import("./noteinput.js")).entryIdle(); await T.sleep(100); });
const undo = () => app.eval(async () => { await (await import("./actions.js")).undo(); });
const sel = () => app.eval(() => (T.pr.noteSel.peek()?.keys ?? []).slice().sort());

async function switchOn() {
  await app.clickOn(`.track-row[data-track-id="${trackId}"] .entry-switch`);
  await app.waitFor(async (id) => (await import("./noteinput.js")).entry.peek()?.trackId === id, { what: "keyboard entry on" }, trackId);
}

test("double-click on an empty lane of the piano roll adds a note there – one undo step", async () => {
  await dblclick(g.X(6.3), g.Y(64));
  await app.waitFor(() => T.st.snapshot.peek().project.tracks.at(-1).clips[0].source.notes.length === 2, { what: "new note" });
  assert.deepEqual(await notes(), ["64@6.25", "72@7"], "start on the grid (¼) under the pointer");
  const len = await app.eval((id) => T.st.snapshot.peek().project.tracks.find((t) => t.id === id).clips[0].source.notes.find((n) => n.pitch === 64).lengthBeats, trackId);
  assert.equal(len, 1, "length of the last set note (default one beat)");
  assert.equal(await app.eval(() => T.st.snapshot.peek().undoLabel), "Note E4 setzen");
  assert.deepEqual(await sel(), ["64@2.25"], "the new note is selected");
  await dblclick(g.X(6.5), g.Y(64)); // on the note: nothing new
  assert.deepEqual(await notes(), ["64@6.25", "72@7"]);
  await undo();
  assert.deepEqual(await notes(), ["72@7"]);
});

test("double-click in a track without a note clip creates a clip with the note", async () => {
  const id = await app.eval(async () => {
    await T.st.run({ type: "addTrack", track: { id: 0, name: "Leer", kind: "instrument" } });
    const t = T.st.snapshot.peek().project.tracks.at(-1);
    if (t.view !== "notes") await T.st.run({ type: "setTrack", trackId: t.id, patch: { view: "notes" } });
    T.pr.pitchViews.update((m) => ({ ...m, [t.id]: { low: 55, span: 21 } }));
    await T.sleep(200);
    return t.id;
  });
  const gg = geoFns(await noteGeo(app, id));
  await dblclick(gg.X(5.6), gg.Y(67));
  await app.waitFor((id) => T.st.snapshot.peek().project.tracks.find((t) => t.id === id).clips.length === 1, { what: "new clip" }, id);
  const made = await app.eval((id) => T.st.snapshot.peek().project.tracks.find((t) => t.id === id).clips.map((c) => ({ start: c.startBeats, len: c.source.lengthBeats, notes: c.source.notes.map((n) => `${n.pitch}@${n.startBeats}`) })), id);
  assert.deepEqual(made, [{ start: 4, len: 4, notes: ["67@1.5"] }]);
});

test("keyboard entry: letters add notes one grid step further, Shift stays (chord), Ctrl keeps its shortcuts, one undo step each", async () => {
  await app.eval(() => T.st.act(window.__TAURI__.core.invoke("set_loop_range", { range: [4, 8] })));
  await switchOn();
  assert.deepEqual(await entryNow(), { trackId, beat: 4 }, "starts at the selected time range");
  await app.key("a");
  await app.key("s");
  await app.key("d", { mods: MOD.shift });
  await app.key("g", { mods: MOD.shift });
  await app.key("j");
  await idle();
  assert.deepEqual(await notes(), ["60@4", "62@4.25", "64@4.5", "67@4.5", "71@4.5", "72@7"]);
  assert.deepEqual(await entryNow(), { trackId, beat: 4.75 });
  assert.deepEqual(await sel(), ["64@0.5", "67@0.5", "71@0.5"], "the chord is selected");
  assert.equal(await app.eval(() => T.st.snapshot.peek().undoLabel), "Note H4 setzen");
  await undo();
  assert.deepEqual(await notes(), ["60@4", "62@4.25", "64@4.5", "67@4.5", "72@7"], "one undo step per note");
  // Ctrl+Z stays undo while typing
  await app.key("z", { mods: MOD.ctrl });
  await app.waitFor(() => !T.st.snapshot.peek().project.tracks.at(-1).clips[0].source.notes.some((n) => n.pitch === 67), { what: "Ctrl+Z undoes" });
  assert.deepEqual(await notes(), ["60@4", "62@4.25", "64@4.5", "72@7"]);
  // Ctrl + a note key is no note: Ctrl+Y (the G♯ key) redoes, the mark stays
  await app.key("y", { mods: MOD.ctrl });
  await app.waitFor(() => T.st.snapshot.peek().project.tracks.at(-1).clips[0].source.notes.some((n) => n.pitch === 67), { what: "Ctrl+Y redoes" });
  await idle();
  assert.deepEqual(await notes(), ["60@4", "62@4.25", "64@4.5", "67@4.5", "72@7"], "no G♯ from Ctrl+Y");
  assert.deepEqual(await entryNow(), { trackId, beat: 4.75 });
});

test("keyboard entry: a click on the piano adds that note, Backspace steps back, L and R do nothing until Esc", async () => {
  await app.eval(() => T.st.act(window.__TAURI__.core.invoke("set_loop_range", { range: [4, 8] })));
  await switchOn();
  const geo = await noteGeo(app, trackId);
  const keys = await app.eval((id) => {
    const r = document.querySelector(`.track-row[data-track-id="${id}"] canvas.keys`).getBoundingClientRect();
    return { x: r.x, y: r.y };
  }, trackId);
  const notesTop = await app.eval(() => T.pr.NOTES_TOP);
  await app.click(keys.x + 6, keys.y + geo.lanes[65] - notesTop + geo.laneH / 2);
  await idle();
  assert.deepEqual(await notes(), ["65@4", "72@7"]);
  assert.equal((await entryNow()).beat, 4.25);

  const loopBefore = await app.eval(() => T.st.snapshot.peek().engine.loopOn);
  await app.key("l"); // L = D of the next octave
  await app.key("r"); // not a note key: nothing (no recording)
  await idle();
  assert.equal(await app.eval(() => T.st.snapshot.peek().engine.loopOn), loopBefore, "L doesn't toggle loop");
  assert.equal(await app.eval(() => T.st.status.peek().recording), false, "R doesn't record");
  assert.deepEqual(await notes(), ["65@4", "72@7", "74@4.25"]);
  await app.key("Backspace");
  await idle();
  assert.deepEqual(await notes(), ["65@4", "72@7"], "Backspace deletes the note before the mark");
  assert.equal((await entryNow()).beat, 4.25);

  await app.key("Escape");
  assert.equal(await entryNow(), null, "Esc ends keyboard entry");
  assert.equal(await app.eval(() => !!document.querySelector(".entry-switch.on")), false);
});

test("playback stops right at the end of the piece: the mark follows and typing appends there; Play from the end starts at the beginning", async () => {
  // the piece: 72 over beat 7–7.5 (clip 4–8) – it ends at 7.5
  await switchOn();
  assert.equal((await entryNow()).beat, 0, "starts at the playhead");
  const bpm = await app.eval(() => T.st.snapshot.peek().project.tempoBpm);
  const beatNow = () => app.eval((bpm) => (T.st.status.peek().positionSecs * bpm) / 60, bpm);
  await app.eval((bpm) => window.__TAURI__.core.invoke("seek", { seconds: (6 * 60) / bpm }), bpm);
  await app.key(" ");
  await app.waitFor(() => T.st.status.peek().playing, { what: "playing", timeout: 2000 });
  await app.waitFor(() => !T.st.status.peek().playing, { what: "stopped at the end", timeout: 4000 });
  assert.ok(Math.abs((await beatNow()) - 7.5) < 0.001, `the playhead stays at the end: ${await beatNow()}`);
  assert.deepEqual(await entryNow(), { trackId, beat: 7.5 }, "the mark follows to the end");
  await app.key("d");
  await app.key("f");
  await idle();
  assert.deepEqual(await notes(), ["64@7.5", "65@7.75", "72@7"], "the typed notes append to the piece");
  assert.equal(await app.eval(() => T.st.snapshot.peek().engine.endBeats), 8, "the piece got longer");
  // Play from the old end: plays what was typed and stops at the new end
  await app.key(" ");
  await app.waitFor((bpm) => !T.st.status.peek().playing && Math.abs((T.st.status.peek().positionSecs * bpm) / 60 - 8) < 0.001, { what: "stopped at the new end", timeout: 4000 }, bpm);
  assert.deepEqual(await entryNow(), { trackId, beat: 8 });
  // Play at the end starts at the beginning; pausing in the middle leaves the mark where it is
  await app.key(" ");
  await app.waitFor((bpm) => T.st.status.peek().playing && (T.st.status.peek().positionSecs * bpm) / 60 > 0.5, { what: "playing from the front", timeout: 3000 }, bpm);
  assert.ok((await beatNow()) < 4, "from the front");
  await app.key(" ");
  await app.waitFor(() => !T.st.status.peek().playing, { what: "paused" });
  assert.deepEqual(await entryNow(), { trackId, beat: 8 }, "a pause doesn't move the mark");
});

test("the shortcut line stays right below the last track; while typing it lists the mode's keys", async () => {
  const where = () => app.eval(() => {
    const c = document.querySelector("kw-timeline canvas").getBoundingClientRect();
    const h = document.querySelector("kw-timeline .keys-hint");
    const r = h.getBoundingClientRect();
    const tracks = T.st.snapshot.peek().project.tracks;
    return { top: r.top, height: r.height, lastBottom: c.top + T.st.RULER_H + T.pr.contentHeight(tracks) - T.st.viewport.peek().scrollY, text: h.textContent };
  });
  let w = await where();
  assert.ok(w.height > 0 && w.top >= w.lastBottom && w.top - w.lastBottom < 16, JSON.stringify(w));
  assert.match(w.text, /Leertaste Wiedergabe/);
  await switchOn();
  w = await where();
  assert.match(w.text, /^Tastatureingabe: /);
  await app.key("Escape");
});

test("no errors in the window", () => {
  assert.deepEqual(app.errors, []);
});

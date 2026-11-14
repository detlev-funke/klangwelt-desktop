// Notes in the timeline: select, frame, move (with bar grid),
// Alt+click places notes – also next to the clip (the clip grows), length, delete
// (Delete or right-click → menu).
import { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startApp, makeTest, noteGeo, geoFns, MOD } from "./harness.mjs";

let app;
const test = makeTest(() => app);
before(async () => {
  app = await startApp();
});
after(async () => {
  await app?.close();
});

let trackId;
let g; // { X, Y }

/**
 * Track "Test" in note view with one clip from bar 2 (beat 4), 1 bar long:
 * 60@0, 64@1, 67@2 (0.9 beats each). View: 80 px per beat, track at the top.
 */
beforeEach(async () => {
  await app.reset();
  trackId = await app.eval(async () => {
    await T.st.run({ type: "addTrack", track: { id: 0, name: "Test", kind: "instrument" } });
    const t = T.st.snapshot.peek().project.tracks.at(-1);
    if (t.view !== "notes") await T.st.run({ type: "setTrack", trackId: t.id, patch: { view: "notes" } });
    const notes = [[60, 0], [64, 1], [67, 2]].map(([pitch, s]) => ({ pitch, startBeats: s, lengthBeats: 0.9, velocity: 100 }));
    await T.st.run({ type: "addClip", trackId: t.id, clip: { id: 0, name: "Noten", startBeats: 4, source: { type: "notes", lengthBeats: 4, notes } } });
    T.st.viewport.value = { pxPerBeat: 80, scrollX: 0, scrollY: 0 };
    T.st.showPanel("spuren");
    await T.sleep(250);
    return t.id;
  });
  g = geoFns(await noteGeo(app, trackId));
});

const clip = () => app.eval((id) => {
  const c = T.st.snapshot.peek().project.tracks.find((t) => t.id === id).clips[0];
  return { start: c.startBeats, len: c.source.lengthBeats, notes: c.source.notes.map((n) => `${n.pitch}@${n.startBeats}`).sort() };
}, trackId);
const sel = () => app.eval(() => (T.pr.noteSel.peek()?.keys ?? []).slice().sort());
const undoLabel = () => app.eval(() => T.st.snapshot.peek().undoLabel);

test("click on an empty lane no longer places a note", async () => {
  await app.click(g.X(4 + 0.5), g.Y(62));
  assert.deepEqual((await clip()).notes, ["60@0", "64@1", "67@2"]);
  assert.deepEqual(await sel(), []);
});

test("click selects a note, Shift/Ctrl+click adds and removes", async () => {
  await app.click(g.X(4.3), g.Y(60));
  assert.deepEqual(await sel(), ["60@0"]);
  await app.click(g.X(5.3), g.Y(64), { mods: MOD.ctrl });
  assert.deepEqual(await sel(), ["60@0", "64@1"]);
  await app.click(g.X(6.3), g.Y(67), { mods: MOD.shift });
  assert.deepEqual(await sel(), ["60@0", "64@1", "67@2"]);
  await app.click(g.X(4.3), g.Y(60), { mods: MOD.ctrl });
  assert.deepEqual(await sel(), ["64@1", "67@2"]);
});

test("selection box selects the notes inside, Ctrl adds", async () => {
  await app.drag([g.X(4.1), g.Y(65)], [g.X(5.95), g.Y(58)]);
  assert.deepEqual(await sel(), ["60@0", "64@1"]);
  await app.drag([g.X(6.1), g.Y(68)], [g.X(6.95), g.Y(66)], { mods: MOD.ctrl });
  assert.deepEqual(await sel(), ["60@0", "64@1", "67@2"]);
  // frame without a key replaces the selection
  await app.drag([g.X(6.1), g.Y(68)], [g.X(6.95), g.Y(66)]);
  assert.deepEqual(await sel(), ["67@2"]);
});

test("moving selected notes: all together, with position display", async () => {
  await app.drag([g.X(4.1), g.Y(65)], [g.X(5.95), g.Y(58)]); // 60@0, 64@1
  const up = await app.eval(() => T.pr.highOnTop.peek());
  const laneH = (await noteGeo(app, trackId)).laneH;
  const info = await app.drag([g.X(5.4), g.Y(64)], [g.X(6.4), g.Y(64) + (up ? -2 : 2) * laneH], {
    during: () => app.eval(() => T.$("kw-timeline").dataset.dragInfo ?? null),
  });
  assert.match(info ?? "", /^Takt 2\.3\.1 +\+1 Schlag · \+2 HT$/, `Anzeige beim Ziehen: ${info}`);
  assert.deepEqual((await clip()).notes, ["62@1", "66@2", "67@2"]);
  assert.deepEqual(await sel(), ["62@1", "66@2"]);
  assert.equal(await app.eval(() => T.$("kw-timeline").dataset.dragInfo ?? null), null, "Anzeige verschwindet");
});

test("Alt+drag places a note in the clip – it ends at the pointer", async () => {
  await app.drag([g.X(4 + 3.05), g.Y(62)], [g.X(4 + 3.5), g.Y(62)], { mods: MOD.alt });
  const c = await clip();
  assert.ok(c.notes.includes("62@3"), JSON.stringify(c.notes));
  const len = await app.eval((id) => T.st.snapshot.peek().project.tracks.find((t) => t.id === id).clips[0].source.notes.find((n) => n.pitch === 62).lengthBeats, trackId);
  assert.equal(len, 0.5, "Ende am Zeiger (Raster ¼)");
});

test("Alt+click without dragging: note with the last used length", async () => {
  await app.click(g.X(4 + 3.05), g.Y(62), { mods: MOD.alt });
  assert.ok((await clip()).notes.includes("62@3"));
});

test("Alt+click after the clip: note goes in, the clip grows to the right", async () => {
  await app.click(g.X(9.05), g.Y(65), { mods: MOD.alt }); // clip ends at beat 8
  const c = await clip();
  assert.equal(c.start, 4);
  assert.equal(c.len, 8, "auf ganze Takte erweitert");
  assert.ok(c.notes.includes("65@5"), JSON.stringify(c.notes));
  // one undo step takes everything back
  await app.eval(() => T.st.act(window.__TAURI__.core.invoke("undo")));
  assert.deepEqual(await clip(), { start: 4, len: 4, notes: ["60@0", "64@1", "67@2"] });
});

test("Alt+click before the clip: the clip grows to the left, the notes stay in place", async () => {
  await app.click(g.X(2.05), g.Y(62), { mods: MOD.alt });
  const c = await clip();
  assert.equal(c.start, 0, "Clip beginnt einen Takt früher");
  assert.equal(c.len, 8);
  // old notes move by 4 beats within the clip – in the project they stay put
  assert.deepEqual(c.notes, ["60@4", "62@2", "64@5", "67@6"]);
  assert.match(await undoLabel(), /Clip nach links erweitert/);
  await app.eval(() => T.st.act(window.__TAURI__.core.invoke("undo")));
  assert.deepEqual(await clip(), { start: 4, len: 4, notes: ["60@0", "64@1", "67@2"] });
});

test("moving notes past the clip start extends the clip", async () => {
  await app.click(g.X(4.3), g.Y(60));
  await app.drag([g.X(4.3), g.Y(60)], [g.X(3.3), g.Y(60)]);
  const c = await clip();
  assert.equal(c.start, 0);
  assert.deepEqual(c.notes, ["60@3", "64@5", "67@6"]);
});

test("Alt+click in a track without a clip creates a clip", async () => {
  const id = await app.eval(async () => {
    await T.st.run({ type: "addTrack", track: { id: 0, name: "Leer", kind: "instrument" } });
    const t = T.st.snapshot.peek().project.tracks.at(-1);
    if (t.view !== "notes") await T.st.run({ type: "setTrack", trackId: t.id, patch: { view: "notes" } });
    return t.id;
  });
  const gg = geoFns(await noteGeo(app, id));
  const pitch = Number(Object.keys((await noteGeo(app, id)).lanes)[10]);
  await app.click(gg.X(5.1), gg.Y(pitch), { mods: MOD.alt });
  const c = await app.eval((id) => T.st.snapshot.peek().project.tracks.find((t) => t.id === id).clips.map((c) => ({ start: c.startBeats, notes: c.source.notes.map((n) => n.startBeats) })), id);
  assert.equal(c.length, 1);
  assert.equal(c[0].start, 4, "Clip am Taktanfang");
  assert.equal(c[0].notes[0], 1);
});

test("dragging the right edge changes the length", async () => {
  await app.drag([g.X(4.86), g.Y(60)], [g.X(5.95), g.Y(60)]);
  const len = await app.eval((id) => T.st.snapshot.peek().project.tracks.find((t) => t.id === id).clips[0].source.notes.find((n) => n.pitch === 60).lengthBeats, trackId);
  assert.ok(Math.abs(len - 2) < 0.26, `Länge ${len}`);
});

test("Delete deletes the selection, arrow keys transpose, right-click opens the menu with “Delete”", async () => {
  await app.click(g.X(5.3), g.Y(64));
  await app.key("ArrowUp");
  assert.ok((await clip()).notes.includes("65@1"));
  await app.key("ArrowDown", { mods: MOD.shift });
  assert.ok((await clip()).notes.includes("53@1"));
  await app.key("Delete");
  assert.deepEqual((await clip()).notes, ["60@0", "67@2"]);
  await app.click(g.X(6.3), g.Y(67), { button: "right" });
  await app.clickOn(".ctx-menu [data-act=noten-loeschen]");
  assert.deepEqual((await clip()).notes, ["60@0"]);
});

test("moving a clip shows the bar division and position", async () => {
  const band = (await noteGeo(app, trackId)).rowY + 8; // header row of the clip
  const info = await app.drag([g.X(4.5), band], [g.X(8.5), band], { during: () => app.eval(() => T.$("kw-timeline").dataset.dragInfo ?? null) });
  assert.match(info ?? "", /^Takt 3\.1\.1 +\+1 Takt$/, `Anzeige: ${info}`);
  assert.equal((await clip()).start, 8);
});

test("no errors in the window", () => {
  assert.deepEqual(app.errors, []);
});

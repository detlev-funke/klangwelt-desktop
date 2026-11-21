// Note lengths on the desktop: the length of new notes chosen next to the piano (Auto,
// 1/1 … 1/32, dotted, triplet; digit keys while typing), the piano appending notes at the
// end of the piece, and the menu of selected notes – "Length" and "Longer / shorter" set
// the lengths, quantizing notes that already lie on the grid says so and adds no undo step.
// With touch emulation a box drawn with a finger stays selected while holding an empty spot.
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
let geo;

/** Track "Test" in the piano roll: a clip from `clipStart`, one bar long, with `notes`; 80 px per beat, pitches 55–75. */
async function setup({ clipStart = 4, notes = [{ pitch: 72, startBeats: 3, lengthBeats: 0.5, velocity: 100 }] } = {}) {
  await app.reset();
  trackId = await app.eval(async (clipStart, notes) => {
    await T.st.run({ type: "addTrack", track: { id: 0, name: "Test", kind: "instrument" } });
    const t = T.st.snapshot.peek().project.tracks.at(-1);
    if (t.view !== "notes") await T.st.run({ type: "setTrack", trackId: t.id, patch: { view: "notes" } });
    await T.st.run({ type: "addClip", trackId: t.id, clip: { id: 0, name: "Noten", startBeats: clipStart, source: { type: "notes", lengthBeats: 4, notes } } });
    T.pr.pitchViews.update((m) => ({ ...m, [t.id]: { low: 55, span: 21 } }));
    (await import("./noteinput.js")).noteValue.value = { d: 0, mod: "" };
    T.st.viewport.value = { pxPerBeat: 80, scrollX: 0, scrollY: 0 };
    T.st.showPanel("spuren");
    await T.sleep(250);
    return t.id;
  }, clipStart, notes);
  geo = await noteGeo(app, trackId);
  g = geoFns(geo);
}
beforeEach(() => setup());

const notes = (id = trackId) => app.eval((id) => T.st.snapshot.peek().project.tracks.find((t) => t.id === id).clips
  .flatMap((c) => c.source.notes.map((n) => `${n.pitch}@${+(c.startBeats + n.startBeats).toFixed(4)}/${+n.lengthBeats.toFixed(4)}`)).sort(), id);
const idle = () => app.eval(async () => { await (await import("./noteinput.js")).entryIdle(); await T.sleep(150); });
const value = () => app.eval(async () => (await import("./noteinput.js")).valueLabel());
const sel = () => app.eval(() => (T.pr.noteSel.peek()?.keys ?? []).slice().sort());
const undoLabel = () => app.eval(() => T.st.snapshot.peek().undoLabel);
const toast = () => app.eval(() => document.querySelector("kw-toast")?.textContent ?? "");
const select = (keys) => app.eval((id, keys) => {
  const t = T.st.snapshot.peek().project.tracks.find((t) => t.id === id);
  T.pr.noteSel.value = { trackId: id, clipId: t.clips[0].id, keys };
  T.st.selection.value = { trackId: id, clipId: t.clips[0].id };
}, trackId, keys);
/** A key by its position (code) – digits and punctuation, which the harness's key() doesn't know. */
async function press(key, code, vk) {
  const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: 0 };
  await app.send("Input.dispatchKeyEvent", { type: "keyDown", ...base, text: key });
  await app.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  await sleep(150);
}
async function dblclick(x, y) {
  await app.mouse("mouseMoved", x, y);
  for (const clickCount of [1, 2]) {
    await app.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount });
    await app.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount });
  }
  await sleep(250);
}
async function contextMenu(x, y) {
  await app.click(x, y, { button: "right" });
  await app.waitFor(() => !!document.querySelector(".ctx-menu"), { what: "context menu" });
}
/** Window point of a piano key. */
async function key(pitch) {
  const r = await app.eval((id) => {
    const b = document.querySelector(`.track-row[data-track-id="${id}"] canvas.keys`).getBoundingClientRect();
    return { x: b.x, y: b.y, top: T.pr.NOTES_TOP };
  }, trackId);
  return [r.x + 8, r.y + geo.lanes[pitch] - r.top + geo.laneH / 2];
}

test("next to the piano: 1/8, dotted and triplet for new notes – double-click and Alt+click take them; Auto is as before", async () => {
  const row = `.track-row[data-track-id="${trackId}"]`;
  assert.deepEqual(await app.eval((row) => [...document.querySelectorAll(`${row} .note-values button`)].map((b) => b.textContent), row),
    ["Auto", "1/1", "1/2", "1/4", "1/8", "1/16", "1/32", "·", "3"]);
  await dblclick(g.X(4.5), g.Y(60));
  await idle();
  assert.ok((await notes()).includes("60@4.5/1"), "Auto: one beat");
  await app.clickOn(`${row} .note-values [data-value="8"]`);
  await dblclick(g.X(5.5), g.Y(62));
  await idle();
  assert.ok((await notes()).includes("62@5.5/0.5"), JSON.stringify(await notes()));
  await app.clickOn(`${row} .note-values [data-mod="dot"]`);
  assert.equal(await value(), "1/8.");
  await app.click(g.X(6.1), g.Y(64), { mods: MOD.alt });
  await idle();
  assert.ok((await notes()).includes("64@6/0.75"), JSON.stringify(await notes()));
  await app.clickOn(`${row} .note-values [data-mod="tri"]`);
  await dblclick(g.X(6.5), g.Y(66));
  await idle();
  assert.ok((await notes()).some((n) => /^66@6\.5\/0\.333/.test(n)), JSON.stringify(await notes()));
  await app.clickOn(`${row} .note-values [data-value="0"]`);
  assert.equal(await value(), "Auto");
});

test("keyboard entry: digit keys choose the length, \".\" dotted, \",\" triplet, 0 Auto – the mark moves on by the note's length", async () => {
  await app.eval(() => T.st.act(window.__TAURI__.core.invoke("set_loop_range", { range: [4, 8] })));
  await app.clickOn(`.track-row[data-track-id="${trackId}"] .entry-switch`);
  await app.waitFor(async () => !!(await import("./noteinput.js")).entry.peek(), { what: "keyboard entry on" });
  const entryBeat = () => app.eval(async () => (await import("./noteinput.js")).entry.peek().beat);
  await press("4", "Digit4", 52);
  assert.equal(await value(), "1/8");
  await app.key("a");
  await idle();
  assert.equal(await entryBeat(), 4.5);
  await press(".", "Period", 190);
  await app.key("s");
  await idle();
  assert.equal(await entryBeat(), 5.25);
  await press(",", "Comma", 188);
  assert.equal(await value(), "1/8³");
  await press("0", "Digit0", 48);
  await app.key("d");
  await idle();
  assert.deepEqual(await notes(), ["60@4/0.5", "62@4.5/0.75", "64@5.25/0.25", "72@7/0.5"]);
  await app.key("Escape");
});

test("the piano at the end of the piece appends its note, the playhead moves behind it; elsewhere a key only sounds", async () => {
  await app.clickOn(`.track-row[data-track-id="${trackId}"] .note-values [data-value="4"]`);
  await app.click(...(await key(60)));
  await idle();
  assert.deepEqual(await notes(), ["72@7/0.5"], "playhead at the start: nothing added");
  await app.eval(async () => (await import("./actions.js")).seekBeats(7.5));
  await app.waitFor(async () => (await import("./noteinput.js")).atPieceEnd(), { what: "playhead at the end" });
  await app.click(...(await key(60)));
  await idle();
  await app.click(...(await key(62)));
  await app.click(...(await key(65)), { mods: MOD.shift });
  await idle();
  assert.deepEqual(await notes(), ["60@7.5/1", "62@8.5/1", "65@8.5/1", "72@7/0.5"]);
  const beat = await app.eval(() => (T.st.status.peek().positionSecs * T.st.snapshot.peek().project.tempoBpm) / 60);
  assert.ok(Math.abs(beat - 9.5) < 1e-3, `playhead behind the notes: ${beat}`);
  assert.equal(await undoLabel(), "Note F4 setzen");
});

test("menu of selected notes: \"Length\" and \"Longer / shorter\" change the lengths – starts stay, one undo step each", async () => {
  await setup({ notes: [
    { pitch: 60, startBeats: 0, lengthBeats: 1, velocity: 100 },
    { pitch: 64, startBeats: 1, lengthBeats: 0.25, velocity: 100 },
    { pitch: 67, startBeats: 3, lengthBeats: 0.5, velocity: 100 },
  ] });
  await select(["60@0", "64@1"]);
  await contextMenu(g.X(4.5), g.Y(60));
  await app.clickOn('.ctx-menu [data-act="laenge-8"]');
  await app.waitFor(async (id) => T.st.snapshot.peek().project.tracks.find((t) => t.id === id).clips[0].source.notes[0].lengthBeats === 0.5, { what: "eighths" }, trackId);
  assert.deepEqual(await notes(), ["60@4/0.5", "64@5/0.5", "67@7/0.5"]);
  assert.equal(await undoLabel(), "Notenlänge 1/8");
  assert.match(await toast(), /2 Noten jetzt 1\/8 lang/);
  await contextMenu(g.X(4.2), g.Y(60));
  await app.clickOn('.ctx-menu [data-act="laenge-mal-1.5"]');
  await app.waitFor(async (id) => T.st.snapshot.peek().project.tracks.find((t) => t.id === id).clips[0].source.notes[0].lengthBeats === 0.75, { what: "dotted" }, trackId);
  assert.deepEqual(await notes(), ["60@4/0.75", "64@5/0.75", "67@7/0.5"]);
  assert.deepEqual(await sel(), ["60@0", "64@1"], "the selection stays");
  await app.eval(async () => { await (await import("./actions.js")).undo(); });
  assert.deepEqual(await notes(), ["60@4/0.5", "64@5/0.5", "67@7/0.5"]);
});

test("quantize: notes already on the grid – a message and no undo step; the core reports changed: false", async () => {
  await setup({ notes: [{ pitch: 60, startBeats: 0, lengthBeats: 1, velocity: 100 }, { pitch: 62, startBeats: 1.1, lengthBeats: 0.3, velocity: 100 }] });
  await select(["60@0"]);
  const before = await undoLabel();
  await contextMenu(g.X(4.5), g.Y(60));
  await app.clickOn('.ctx-menu [data-act="raster-8-laenge"]');
  await app.waitFor(() => /nichts zu ändern/.test(document.querySelector("kw-toast")?.textContent ?? ""), { what: "message" });
  assert.equal(await undoLabel(), before, "no undo step");
  const r = await app.eval(async (id) => {
    const t = T.st.snapshot.peek().project.tracks.find((t) => t.id === id);
    const a = await window.__TAURI__.core.invoke("quantize_notes", { trackId: id, clipId: t.clips[0].id, indices: [0], grid: 0.5, lengths: false });
    const b = await window.__TAURI__.core.invoke("quantize_notes", { trackId: id, clipId: t.clips[0].id, indices: [1], grid: 0.5, lengths: false });
    return [a.changed, b.changed, b.snapshot.project.tracks.find((t) => t.id === id).clips[0].source.notes.map((n) => n.startBeats)];
  }, trackId);
  assert.deepEqual(r, [false, true, [0, 1]]);
});

test("touch: a box drawn with a finger stays selected while holding an empty spot – the menu is for those notes", async () => {
  await setup({ clipStart: 0, notes: [
    { pitch: 60, startBeats: 0.1, lengthBeats: 0.4, velocity: 100 },
    { pitch: 62, startBeats: 1.3, lengthBeats: 0.4, velocity: 100 },
  ] });
  await app.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  try {
    const touch = (type, points) => app.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], id) => ({ x, y, id, radiusX: 3, radiusY: 3, force: 1 })) });
    const [x0, y0, x1, y1] = [g.X(2.4), g.Y(58), g.X(0.05), g.Y(64)];
    await touch("touchStart", [[x0, y0]]);
    for (let i = 1; i <= 8; i++) {
      await touch("touchMove", [[x0 + ((x1 - x0) * i) / 8, y0 + ((y1 - y0) * i) / 8]]);
      await sleep(16);
    }
    await touch("touchEnd", []);
    await sleep(200);
    assert.deepEqual(await sel(), ["60@0.1", "62@1.3"], "selected by the box");
    await touch("touchStart", [[g.X(2.6), g.Y(66)]]);
    await sleep(750);
    await touch("touchEnd", []);
    await app.waitFor(() => !!document.querySelector('.ctx-menu [data-act="laenge"]'), { what: "menu of the selected notes" });
    assert.deepEqual(await sel(), ["60@0.1", "62@1.3"], "holding keeps the selection");
    await app.key("Escape");
  } finally {
    await app.send("Emulation.setTouchEmulationEnabled", { enabled: false, maxTouchPoints: 1 });
  }
});

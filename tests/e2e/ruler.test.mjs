// Ruler: dragging moves the view, click sets the position,
// Shift/Ctrl+drag marks a time range (edges can be dragged, Shift+click clears it).
import { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startApp, makeTest, MOD } from "./harness.mjs";

let app;
const test = makeTest(() => app);
let geo;
before(async () => {
  app = await startApp();
});
after(async () => {
  await app?.close();
});
beforeEach(async () => {
  await app.reset();
  geo = await app.eval(async () => {
    T.st.viewport.value = { pxPerBeat: 60, scrollX: 0, scrollY: 0 };
    T.st.showPanel("spuren");
    await T.sleep(150);
    const c = T.$("kw-timeline canvas").getBoundingClientRect();
    return { x: c.x, y: c.y + T.st.RULER_H / 2 };
  });
});

const X = (beat, scrollX = 0) => geo.x + beat * 60 - scrollX;
const range = () => app.eval(() => T.st.snapshot.peek().engine.loopRange);
const scrollX = () => app.eval(() => T.st.viewport.peek().scrollX);

test("dragging in the ruler moves the view – the position stays", async () => {
  await app.drag([geo.x + 500, geo.y], [geo.x + 300, geo.y]);
  assert.equal(await scrollX(), 200);
  assert.equal(await app.eval(() => T.st.status.peek().positionSecs), 0, "Ziehen setzt keine Position");
  await app.drag([geo.x + 300, geo.y], [geo.x + 450, geo.y]);
  assert.equal(await scrollX(), 50);
  await app.drag([geo.x + 300, geo.y], [geo.x + 700, geo.y]);
  assert.equal(await scrollX(), 0, "nicht vor den Anfang");
});

test("click in the ruler sets the playback position", async () => {
  await app.click(X(6), geo.y);
  const beat = await app.waitFor(() => {
    const b = (T.st.status.peek().positionSecs * T.st.snapshot.peek().project.tempoBpm) / 60;
    return b > 0 ? b : 0;
  }, { what: "Position" });
  assert.ok(Math.abs(beat - 6) < 0.05, `Schlag ${beat}`);
});

test("Shift+drag marks a range (snapped to beats)", async () => {
  await app.drag([X(2.2), geo.y], [X(5.8), geo.y], { mods: MOD.shift });
  assert.deepEqual(await range(), [2, 6]);
  assert.equal(await scrollX(), 0, "Ansicht bleibt");
});

test("Ctrl+drag marks likewise, also from right to left", async () => {
  await app.drag([X(9.1), geo.y], [X(3.9), geo.y], { mods: MOD.ctrl });
  assert.deepEqual(await range(), [4, 9]);
});

test("edges of the range can be dragged afterwards", async () => {
  await app.eval(() => T.st.act(window.__TAURI__.core.invoke("set_loop_range", { range: [4, 8] })));
  await app.drag([X(8), geo.y], [X(10), geo.y]);
  assert.deepEqual(await range(), [4, 10]);
  await app.drag([X(4), geo.y], [X(2), geo.y]);
  assert.deepEqual(await range(), [2, 10]);
  assert.equal(await scrollX(), 0, "Kante ziehen verschiebt nicht die Ansicht");
});

test("Shift+click clears the range", async () => {
  await app.eval(() => T.st.act(window.__TAURI__.core.invoke("set_loop_range", { range: [4, 8] })));
  await app.click(X(12), geo.y, { mods: MOD.shift });
  assert.equal(await range(), null);
});

test("when zoomed out, the range snaps to whole bars", async () => {
  await app.eval(async () => {
    T.st.viewport.value = { pxPerBeat: 12, scrollX: 0, scrollY: 0 };
    await T.sleep(100);
  });
  await app.drag([geo.x + 5 * 12, geo.y], [geo.x + 15 * 12, geo.y], { mods: MOD.shift });
  assert.deepEqual(await range(), [4, 16]);
});

test("no errors in the window", () => {
  assert.deepEqual(app.errors, []);
});

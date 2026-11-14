// Noten in der Zeitleiste: auswählen, Rahmen, verschieben (mit Takteinteilung),
// Alt+Klick setzt Noten – auch neben dem Clip (der Clip wächst), Länge, Löschen
// (Entf oder Rechtsklick → Menü).
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
 * Spur „Test“ in Notenansicht mit einem Clip ab Takt 2 (Schlag 4), 1 Takt lang:
 * 60@0, 64@1, 67@2 (je 0,9 Schläge). Ansicht: 80 px je Schlag, Spur oben.
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

test("Klick auf freie Bahn setzt keine Note mehr", async () => {
  await app.click(g.X(4 + 0.5), g.Y(62));
  assert.deepEqual((await clip()).notes, ["60@0", "64@1", "67@2"]);
  assert.deepEqual(await sel(), []);
});

test("Klick wählt eine Note, Umschalt/Strg+Klick nimmt dazu und wieder heraus", async () => {
  await app.click(g.X(4.3), g.Y(60));
  assert.deepEqual(await sel(), ["60@0"]);
  await app.click(g.X(5.3), g.Y(64), { mods: MOD.ctrl });
  assert.deepEqual(await sel(), ["60@0", "64@1"]);
  await app.click(g.X(6.3), g.Y(67), { mods: MOD.shift });
  assert.deepEqual(await sel(), ["60@0", "64@1", "67@2"]);
  await app.click(g.X(4.3), g.Y(60), { mods: MOD.ctrl });
  assert.deepEqual(await sel(), ["64@1", "67@2"]);
});

test("Auswahlrahmen wählt die Noten darin, Strg nimmt dazu", async () => {
  await app.drag([g.X(4.1), g.Y(65)], [g.X(5.95), g.Y(58)]);
  assert.deepEqual(await sel(), ["60@0", "64@1"]);
  await app.drag([g.X(6.1), g.Y(68)], [g.X(6.95), g.Y(66)], { mods: MOD.ctrl });
  assert.deepEqual(await sel(), ["60@0", "64@1", "67@2"]);
  // Rahmen ohne Taste ersetzt die Auswahl
  await app.drag([g.X(6.1), g.Y(68)], [g.X(6.95), g.Y(66)]);
  assert.deepEqual(await sel(), ["67@2"]);
});

test("Gewählte Noten verschieben: alle zusammen, mit Positionsanzeige", async () => {
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

test("Alt+Ziehen setzt eine Note im Clip – sie endet am Zeiger", async () => {
  await app.drag([g.X(4 + 3.05), g.Y(62)], [g.X(4 + 3.5), g.Y(62)], { mods: MOD.alt });
  const c = await clip();
  assert.ok(c.notes.includes("62@3"), JSON.stringify(c.notes));
  const len = await app.eval((id) => T.st.snapshot.peek().project.tracks.find((t) => t.id === id).clips[0].source.notes.find((n) => n.pitch === 62).lengthBeats, trackId);
  assert.equal(len, 0.5, "Ende am Zeiger (Raster ¼)");
});

test("Alt+Klick ohne Ziehen: Note mit der zuletzt gesetzten Länge", async () => {
  await app.click(g.X(4 + 3.05), g.Y(62), { mods: MOD.alt });
  assert.ok((await clip()).notes.includes("62@3"));
});

test("Alt+Klick hinter dem Clip: Note kommt hinein, der Clip wächst nach rechts", async () => {
  await app.click(g.X(9.05), g.Y(65), { mods: MOD.alt }); // Clip endet bei Schlag 8
  const c = await clip();
  assert.equal(c.start, 4);
  assert.equal(c.len, 8, "auf ganze Takte erweitert");
  assert.ok(c.notes.includes("65@5"), JSON.stringify(c.notes));
  // ein Undo-Schritt nimmt alles zurück
  await app.eval(() => T.st.act(window.__TAURI__.core.invoke("undo")));
  assert.deepEqual(await clip(), { start: 4, len: 4, notes: ["60@0", "64@1", "67@2"] });
});

test("Alt+Klick vor dem Clip: der Clip wächst nach links, die Noten bleiben an ihrem Platz", async () => {
  await app.click(g.X(2.05), g.Y(62), { mods: MOD.alt });
  const c = await clip();
  assert.equal(c.start, 0, "Clip beginnt einen Takt früher");
  assert.equal(c.len, 8);
  // alte Noten rücken im Clip um 4 Schläge – im Projekt bleiben sie stehen
  assert.deepEqual(c.notes, ["60@4", "62@2", "64@5", "67@6"]);
  assert.match(await undoLabel(), /Clip nach links erweitert/);
  await app.eval(() => T.st.act(window.__TAURI__.core.invoke("undo")));
  assert.deepEqual(await clip(), { start: 4, len: 4, notes: ["60@0", "64@1", "67@2"] });
});

test("Noten über den Clipanfang hinaus verschieben erweitert den Clip", async () => {
  await app.click(g.X(4.3), g.Y(60));
  await app.drag([g.X(4.3), g.Y(60)], [g.X(3.3), g.Y(60)]);
  const c = await clip();
  assert.equal(c.start, 0);
  assert.deepEqual(c.notes, ["60@3", "64@5", "67@6"]);
});

test("Alt+Klick in einer Spur ohne Clip legt einen Clip an", async () => {
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

test("Rechte Kante ziehen ändert die Länge", async () => {
  await app.drag([g.X(4.86), g.Y(60)], [g.X(5.95), g.Y(60)]);
  const len = await app.eval((id) => T.st.snapshot.peek().project.tracks.find((t) => t.id === id).clips[0].source.notes.find((n) => n.pitch === 60).lengthBeats, trackId);
  assert.ok(Math.abs(len - 2) < 0.26, `Länge ${len}`);
});

test("Entf löscht die Auswahl, Pfeiltasten transponieren, Rechtsklick öffnet das Menü mit „Löschen“", async () => {
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

test("Clip verschieben zeigt Takteinteilung und Position", async () => {
  const band = (await noteGeo(app, trackId)).rowY + 8; // Kopfzeile des Clips
  const info = await app.drag([g.X(4.5), band], [g.X(8.5), band], { during: () => app.eval(() => T.$("kw-timeline").dataset.dragInfo ?? null) });
  assert.match(info ?? "", /^Takt 3\.1\.1 +\+1 Takt$/, `Anzeige: ${info}`);
  assert.equal((await clip()).start, 8);
});

test("keine Fehler im Fenster", () => {
  assert.deepEqual(app.errors, []);
});

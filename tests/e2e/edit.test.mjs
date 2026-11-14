// Bearbeiten über Spuren: markierten Zeitbereich mit Entf aus allen Spuren
// löschen (alles danach rückt auf), markierte Noten mit ↑/↓ transponieren,
// Kontextmenü „Am Takt ausrichten“ – je ein Rückgängig-Schritt.
import { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { startApp, makeTest, noteGeo, geoFns, MOD } from "./harness.mjs";
import { writeWav } from "./audiofiles.mjs";

let app;
const test = makeTest(() => app);
before(async () => {
  app = await startApp();
});
after(async () => {
  await app?.close();
});

beforeEach(async () => {
  await app.reset();
  await app.eval(() => {
    T.st.viewport.value = { pxPerBeat: 80, scrollX: 0, scrollY: 0 };
    T.st.showPanel("spuren");
  });
});

const notes = (spec) => spec.map(([pitch, s, l]) => ({ pitch, startBeats: s, lengthBeats: l, velocity: 100 }));

/** Instrumentspur mit Clips: [{ start, len, notes: [[Ton, Start, Länge]] }]; liefert die Spur-ID. */
async function track(name, clips, view = "compact") {
  return app.eval(async (name, clips, view) => {
    await T.st.run({ type: "addTrack", track: { id: 0, name, kind: "instrument" } });
    const t = T.st.snapshot.peek().project.tracks.at(-1);
    await T.st.run({ type: "setTrack", trackId: t.id, patch: { view } });
    for (const c of clips) {
      await T.st.run({ type: "addClip", trackId: t.id, clip: { id: 0, name: "N", startBeats: c.start, source: { type: "notes", lengthBeats: c.len, notes: c.notes } } });
    }
    await T.sleep(200);
    return t.id;
  }, name, clips, view);
}

/** Clips einer Spur: [Start, Länge, ["Ton@Start/Länge", …]]. */
const clipsOf = (id) => app.eval((id) => T.st.snapshot.peek().project.tracks.find((t) => t.id === id).clips
  .slice().sort((a, b) => a.startBeats - b.startBeats)
  .map((c) => [c.startBeats, c.source.type === "notes" ? c.source.lengthBeats : c.source.durationSecs,
    c.source.type === "notes" ? c.source.notes.map((n) => `${n.pitch}@${n.startBeats}/${n.lengthBeats}`) : c.source.assetId]), id);
const undoLabel = () => app.eval(() => T.st.snapshot.peek().undoLabel);
const loopRange = () => app.eval(() => T.st.snapshot.peek().engine.loopRange);
const undo = () => app.eval(() => T.st.act(window.__TAURI__.core.invoke("undo")));

/** Zeitbereich im Lineal mit Umschalt+Ziehen markieren. */
async function markRange(a, b) {
  const g = geoFns(await noteGeo(app, await app.eval(() => T.st.snapshot.peek().project.tracks[0].id)));
  await app.drag([g.X(a) + 1, g.rulerY], [g.X(b) + 1, g.rulerY], { mods: MOD.shift });
  await app.waitFor(() => !!T.st.snapshot.peek().engine.loopRange, { what: "markierter Bereich" });
}

// ------------------------------------------------------------------ Zeitbereich

async function twoTracks() {
  const a = await track("A", [{ start: 0, len: 8, notes: notes([[60, 0, 1], [62, 2.5, 1], [64, 3.5, 2], [65, 5, 1], [67, 6, 1]]) }]);
  const b = await track("B", [{ start: 3, len: 1, notes: notes([[50, 0, 1]]) }, { start: 8, len: 4, notes: notes([[52, 1, 1]]) }]);
  return { a, b };
}

test("Entf löscht den markierten Zeitbereich aus allen Spuren – alles danach rückt auf, ein Rückgängig-Schritt", async () => {
  const { a, b } = await twoTracks();
  const before = [await clipsOf(a), await clipsOf(b)];
  // vorher gewählter Clip: das spätere Markieren hat Vorrang
  const gb = await noteGeo(app, b);
  await app.click(gb.cx + 8.5 * gb.ppb - gb.scrollX, gb.rowY + 12);
  await app.waitFor(() => T.st.selection.peek()?.clipId != null, { what: "Clip gewählt" });
  await markRange(2, 5);
  assert.deepEqual(await loopRange(), [2, 5]);
  await app.key("Delete");
  await app.waitFor(() => T.st.snapshot.peek().undoLabel?.startsWith("Zeitbereich löschen"), { what: "Bereich gelöscht" });
  // A: Clip 0–8 → 0–5; 62 (im Bereich) weg, 64 ragt hinaus (Rest 0,5 ab Schlag 2), 65/67 rücken um 3 vor
  assert.deepEqual(await clipsOf(a), [[0, 5, ["60@0/1", "64@2/0.5", "65@2/1", "67@3/1"]]]);
  // B: Clip im Bereich ist weg, Clip dahinter rückt von 8 auf 5
  assert.deepEqual(await clipsOf(b), [[5, 4, ["52@1/1"]]]);
  assert.equal(await undoLabel(), "Zeitbereich löschen (Takt 1.3 – 2.2)");
  assert.equal(await loopRange(), null, "Markierung ist aufgehoben");
  assert.match(await app.eval(() => T.st.message.peek()?.text ?? ""), /gelöscht – alles danach ist aufgerückt/);
  await undo();
  assert.deepEqual([await clipsOf(a), await clipsOf(b)], before);
});

test("Wird nach dem Markieren ein Clip gewählt, löscht Entf den Clip – der Bereich bleibt", async () => {
  const { a, b } = await twoTracks();
  await markRange(2, 5);
  const g = await noteGeo(app, b);
  // Clip ab Schlag 8 in Spur B anklicken (Kopfzeile)
  await app.click(g.cx + 8.5 * g.ppb - g.scrollX, g.rowY + 12);
  await app.waitFor(() => T.st.selection.peek()?.clipId != null, { what: "Clip gewählt" });
  await app.key("Delete");
  assert.deepEqual((await clipsOf(b)).map((c) => c[0]), [3], "nur der Clip ist weg");
  assert.equal((await clipsOf(a))[0][1], 8, "Spur A unverändert");
  assert.deepEqual(await loopRange(), [2, 5]);
});

test("Rechtsklick in den markierten Bereich: Menü „Zeitbereich löschen“", async () => {
  const { a } = await twoTracks();
  await markRange(4, 8);
  const g = await noteGeo(app, a);
  await app.click(g.cx + 4.5 * g.ppb - g.scrollX, g.rowY + 40, { button: "right" });
  const heading = await app.waitFor(() => T.$(".ctx-menu .menu-title")?.textContent, { what: "Kontextmenü" });
  assert.equal(heading, "Markiert: Takt 2");
  await app.clickOn(".ctx-menu [data-act=bereich-loeschen]");
  await app.waitFor(() => !T.$(".ctx-menu") && T.st.snapshot.peek().undoLabel?.startsWith("Zeitbereich löschen"), { what: "gelöscht" });
  assert.deepEqual(await clipsOf(a), [[0, 4, ["60@0/1", "62@2.5/1", "64@3.5/0.5"]]]);
});

test("Audio-Clips über den Bereich werden geschnitten (neue Audiodatei), Rückgängig holt das Original", async () => {
  const file = join(app.tmp, "ton.wav");
  const sr = 8000;
  writeWav(file, [Array.from({ length: sr * 2 }, (_, i) => 0.4 * Math.sin((2 * Math.PI * 220 * i) / sr))], sr);
  // 2 s bei 120 BPM (Originaltempo) = 4 Schläge, ab Schlag 2
  const r = await app.eval((p) => window.__TAURI__.core.invoke("audio_import", { paths: [p], trackId: null, startBeats: 2 }), file);
  await app.eval((s) => (T.st.snapshot.value = s), r.snapshot);
  const id = r.imported[0].trackId;
  const original = await clipsOf(id);
  assert.deepEqual(original.map((c) => [c[0], c[1]]), [[2, 2]]);
  await app.eval(() => T.st.act(window.__TAURI__.core.invoke("set_loop_range", { range: [3, 4] })));
  await app.key("Delete"); // nichts gewählt: Entf gilt dem Bereich
  await app.waitFor(() => T.st.snapshot.peek().undoLabel?.startsWith("Zeitbereich löschen"), { what: "Bereich gelöscht" });
  const [cut] = await clipsOf(id);
  assert.equal(cut[0], 2, "Clip bleibt an seinem Anfang");
  assert.ok(Math.abs(cut[1] - 1.5) < 0.01, `0,5 s fehlen: ${cut[1]}`);
  assert.notEqual(cut[2], original[0][2], "neue Audiodatei");
  const wave = await app.eval((asset) => window.__TAURI__.core.invoke("get_waveform", { assetId: asset, buckets: 16 }), cut[2]);
  assert.ok(wave.some((v) => Math.abs(v) > 0.3), "Ton noch da");
  await undo();
  assert.deepEqual(await clipsOf(id), original);
});

test("Agent: delete_range löscht ebenso", async () => {
  const { a, b } = await twoTracks();
  const r = await app.mcp("delete_range", { startBeats: 2, endBeats: 5 });
  assert.equal(r.ok, true);
  await app.waitFor(() => T.st.snapshot.peek().undoLabel?.startsWith("Zeitbereich löschen"), { what: "Änderung in der Oberfläche" });
  assert.deepEqual((await clipsOf(b)).map((c) => c[0]), [5]);
  assert.equal((await clipsOf(a))[0][1], 5);
});

// ------------------------------------------------------------------ Pfeiltasten

test("↑/↓ verschieben markierte Noten um Halbtöne (Umschalt: Oktave), je Druck ein Rückgängig-Schritt", async () => {
  const id = await track("T", [{ start: 4, len: 4, notes: notes([[60, 0, 0.9], [64, 1, 0.9], [67, 2, 0.9]]) }], "notes");
  const g = geoFns(await noteGeo(app, id));
  await app.click(g.X(4.3), g.Y(60));
  await app.click(g.X(5.3), g.Y(64), { mods: MOD.ctrl });
  await app.key("ArrowUp");
  assert.deepEqual((await clipsOf(id))[0][2], ["61@0/0.9", "65@1/0.9", "67@2/0.9"]);
  assert.equal(await undoLabel(), "Noten transponieren (+1 HT)");
  await app.key("ArrowDown", { mods: MOD.shift });
  assert.deepEqual((await clipsOf(id))[0][2], ["49@0/0.9", "53@1/0.9", "67@2/0.9"]);
  assert.equal(await undoLabel(), "Noten eine Oktave tiefer");
  assert.deepEqual(await app.eval(() => T.pr.noteSel.peek().keys.slice().sort()), ["49@0", "53@1"], "Auswahl wandert mit");
  await undo();
  assert.deepEqual((await clipsOf(id))[0][2], ["61@0/0.9", "65@1/0.9", "67@2/0.9"]);
  await undo();
  assert.deepEqual((await clipsOf(id))[0][2], ["60@0/0.9", "64@1/0.9", "67@2/0.9"]);
});

test("↑/↓ greifen nicht, solange ein Eingabefeld den Fokus hat", async () => {
  const id = await track("T", [{ start: 0, len: 4, notes: notes([[60, 0, 1]]) }], "notes");
  const g = geoFns(await noteGeo(app, id));
  await app.click(g.X(0.3), g.Y(60));
  assert.deepEqual(await app.eval(() => T.pr.noteSel.peek()?.keys), ["60@0"]);
  await app.eval(() => T.$(".track-row input.text").focus());
  // Taste ohne vorheriges Wegnehmen des Fokus (app.key nimmt ihn weg)
  for (const type of ["rawKeyDown", "keyUp"]) {
    await app.send("Input.dispatchKeyEvent", { type, key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38 });
  }
  await app.eval(() => T.sleep(150));
  assert.deepEqual((await clipsOf(id))[0][2], ["60@0/1"], "Note bleibt");
  await app.eval(() => document.activeElement.blur());
  await app.key("ArrowUp");
  assert.deepEqual((await clipsOf(id))[0][2], ["61@0/1"]);
});

// ------------------------------------------------------------------ Am Takt ausrichten

async function offGrid() {
  const id = await track("Q", [{ start: 4, len: 4, notes: notes([[60, 0.1, 0.8], [64, 1.15, 0.3], [67, 1.6, 1.1]]) }], "notes");
  return { id, g: geoFns(await noteGeo(app, id)) };
}

test("Kontextmenü „Am Takt ausrichten“: Raster 1/8 setzt die Anfänge, die Auswahl bleibt", async () => {
  const { id, g } = await offGrid();
  await app.drag([g.X(4.05), g.Y(68)], [g.X(6.9), g.Y(59)]); // alle drei im Rahmen
  assert.equal(await app.eval(() => T.pr.noteSel.peek()?.keys.length), 3);
  await app.click(g.X(5.25), g.Y(64), { button: "right" });
  const heading = await app.waitFor(() => T.$(".ctx-menu .menu-title")?.textContent, { what: "Kontextmenü" });
  assert.equal(heading, "3 Noten markiert");
  assert.deepEqual(await app.eval(() => T.$$(".ctx-menu [data-act=ausrichten] .ctx-chip").map((b) => b.textContent)), ["1/4", "1/8", "1/16", "Raster"]);
  await app.clickOn(".ctx-menu [data-act=raster-8]");
  await app.waitFor(() => T.st.snapshot.peek().undoLabel?.startsWith("Noten am Raster"), { what: "ausgerichtet" });
  assert.deepEqual((await clipsOf(id))[0][2], ["60@0/0.8", "64@1/0.3", "67@1.5/1.1"]);
  assert.equal(await undoLabel(), "Noten am Raster ausrichten (1/8, Anfänge)");
  assert.deepEqual(await app.eval(() => T.pr.noteSel.peek().keys.slice().sort()), ["60@0", "64@1", "67@1.5"]);
  assert.equal(await app.eval(() => !!T.$(".ctx-menu")), false, "Menü zu");
  await undo();
  assert.deepEqual((await clipsOf(id))[0][2], ["60@0.1/0.8", "64@1.15/0.3", "67@1.6/1.1"]);
});

test("„Anfang und Länge“ mit 1/4 richtet auch die Enden aus; Rechtsklick auf eine freie Note wählt nur sie", async () => {
  const { id, g } = await offGrid();
  await app.click(g.X(5.7), g.Y(67), { button: "right" });
  await app.waitFor(() => T.$(".ctx-menu .menu-title")?.textContent === "1 Note markiert", { what: "Menü für eine Note" });
  assert.deepEqual(await app.eval(() => T.pr.noteSel.peek().keys), ["67@1.6"]);
  await app.clickOn(".ctx-menu [data-act=raster-4-laenge]");
  await app.waitFor(() => T.st.snapshot.peek().undoLabel?.includes("Anfang und Länge"), { what: "ausgerichtet" });
  // 67: Projekt 5,6 → 6 (relativ 2), Ende 6,7 → 7 → Länge 1; die anderen bleiben
  assert.deepEqual((await clipsOf(id))[0][2], ["60@0.1/0.8", "64@1.15/0.3", "67@2/1"]);
});

test("Kontextmenü: Transponieren und Löschen", async () => {
  const { id, g } = await offGrid();
  await app.click(g.X(4.5), g.Y(60), { button: "right" });
  await app.clickOn(".ctx-menu [data-act='transponieren+1']");
  assert.ok((await clipsOf(id))[0][2].includes("61@0.1/0.8"));
  await app.click(g.X(4.5), g.Y(61), { button: "right" });
  await app.clickOn(".ctx-menu [data-act=noten-loeschen]");
  assert.deepEqual((await clipsOf(id))[0][2], ["64@1.15/0.3", "67@1.6/1.1"]);
});

test("Agent: quantize_notes richtet am Raster aus", async () => {
  const { id } = await offGrid();
  const clipId = await app.eval((id) => T.st.snapshot.peek().project.tracks.find((t) => t.id === id).clips[0].id, id);
  const r = await app.mcp("quantize_notes", { trackId: id, clipId, grid: 0.25, lengths: false });
  assert.equal(r.ausgerichtet, 3);
  await app.waitFor(() => T.st.snapshot.peek().undoLabel?.includes("Raster"), { what: "Änderung" });
  assert.deepEqual((await clipsOf(id))[0][2], ["60@0/0.8", "64@1.25/0.3", "67@1.5/1.1"]);
});

test("keine Fehler im Fenster", () => {
  assert.deepEqual(app.errors, []);
});

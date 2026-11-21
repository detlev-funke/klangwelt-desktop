// Project: create and delete tracks, demo, save/open/new, unsaved marker, track header,
// File menu, "Choose file…" in the Open dialog (system file dialog, stubbed).
import { before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync, writeFileSync } from "node:fs";
import { startApp, makeTest } from "./harness.mjs";
import { makeTempDir } from "../../klangwelt/tests/tempdirs.mjs";

let app;
const test = makeTest(() => app);
// The native file dialog can't be driven through CDP: the app answers it with this
// file instead (KLANGWELT_FAKE_FILE_PICK) – outside the project folder, in the test's temp folder
const tmp = makeTempDir("klangwelt-e2e-");
const picked = join(tmp, "Gewählt.klangwelt");
before(async () => {
  app = await startApp({ tmp, env: { KLANGWELT_FAKE_FILE_PICK: picked } });
});
after(async () => {
  await app?.close();
});

const tracks = () => app.eval(() => T.st.snapshot.peek().project.tracks.map((t) => `${t.kind}:${t.name}`));

test("empty project shows the hint with buttons", async () => {
  await app.reset();
  const hint = await app.eval(() => {
    const h = T.$(".empty-hint");
    return h && getComputedStyle(h).display !== "none" ? [...h.querySelectorAll(".btn")].map((b) => b.textContent) : null;
  });
  assert.deepEqual(hint, ["Intro", "Demo laden", "Mit Song starten ▾", "Mit Beat starten ▾", "Instrumentspur", "Aufnehmen"]);
});

test("create an instrument track via the hint, an audio track via the track header", async () => {
  await app.reset();
  await app.clickOn(".empty-hint .btn", { text: "Instrumentspur" });
  await app.waitFor(() => T.st.snapshot.peek().project.tracks.length === 1, { what: "Spur" });
  await app.clickOn("kw-tracks .btn", { text: "Audio" });
  await app.waitFor(() => T.st.snapshot.peek().project.tracks.length === 2, { what: "zweite Spur" });
  assert.deepEqual(await tracks(), ["instrument:Instrument 1", "audio:Audio 1"]);
});

test("mute/solo and delete a track", async () => {
  const id = await app.eval(() => T.st.snapshot.peek().project.tracks[0].id);
  await app.clickOn(".toggle.m");
  await app.waitFor((id) => T.st.snapshot.peek().project.tracks.find((t) => t.id === id).mute, { what: "stumm" }, id);
  await app.clickOn(".toggle.s");
  await app.waitFor((id) => T.st.snapshot.peek().project.tracks.find((t) => t.id === id).solo, { what: "solo" }, id);
  await app.clickOn(".btn.ghost.small[title='Spur löschen']");
  await app.waitFor(() => T.st.snapshot.peek().project.tracks.length === 1, { what: "gelöscht" });
});

test("load demo", async () => {
  await app.reset();
  await app.clickOn(".empty-hint .btn", { text: "Demo laden" });
  await app.waitFor(() => T.st.snapshot.peek().project.tracks.length >= 2, { what: "Demo-Spuren" });
  assert.equal(await app.eval(() => T.st.snapshot.peek().project.tempoBpm), 110);
});

test("save, new, open – with a marker for unsaved changes", async () => {
  await app.reset();
  await app.eval(() => T.st.run({ type: "addTrack", track: { id: 0, name: "Gespeichert", kind: "instrument" } }));
  assert.match(await app.eval(() => T.$(".proj-name").textContent), / •$/, "ungespeichert");
  const file = join(app.tmp, "test.klangwelt");
  await app.eval((f) => T.st.act(window.__TAURI__.core.invoke("project_save", { path: f })), file);
  assert.ok(existsSync(file), "Datei geschrieben");
  assert.doesNotMatch(await app.eval(() => T.$(".proj-name").textContent), /•/, "gespeichert");
  await app.eval(() => T.st.act(window.__TAURI__.core.invoke("project_new")));
  assert.deepEqual(await tracks(), []);
  await app.eval((f) => T.st.act(window.__TAURI__.core.invoke("project_open", { path: f })), file);
  assert.deepEqual(await tracks(), ["instrument:Gespeichert"]);
  assert.equal(await app.eval(() => T.$(".proj-name").textContent), "test");
});

/** Labels of the open File menu (without the shortcut on the right). */
const fileMenu = async () => {
  await app.clickOn("kw-transport .file-btn");
  await app.waitFor(() => T.$(".file-menu.open"), { what: "Datei-Menü" });
  const items = await app.eval(() => T.$$(".file-menu.open .menu-item").map((b) => b.firstChild.textContent));
  // a press outside closes the menu
  await app.eval(() => document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
  await app.waitFor(() => !T.$(".file-menu.open"), { what: "Menü zu" });
  return items;
};

/** Opens File → Open… and clicks "Choose file…" there. */
async function chooseFile() {
  await app.clickOn("kw-transport .file-btn");
  await app.clickOn(".file-menu.open .menu-item", { text: "Öffnen …" });
  await app.waitFor(() => T.$(".modal .proj-pick"), { what: "Öffnen-Dialog mit Dateiauswahl" });
  assert.equal(await app.eval(() => T.$(".modal-title").textContent), "Projekt öffnen");
  assert.equal(await app.eval(() => T.$(".modal .proj-pick").textContent), "Datei auswählen …");
  await app.clickOn(".modal .proj-pick");
}

test("File menu: no demo, upload or download entries (the demo is in the empty project)", async () => {
  assert.deepEqual(await fileMenu(), ["Neues Projekt", "Öffnen …", "Speichern", "Speichern unter …", "Exportieren …"]);
  // Save as on the desktop: no download button (that's the browser's way out)
  await app.key("s", { mods: 2 | 8 });
  await app.waitFor(() => T.$(".modal-title")?.textContent === "Projekt speichern", { what: "Speichern-unter-Dialog" });
  assert.deepEqual(await app.eval(() => T.$$(".modal-actions .btn").map((b) => b.textContent)), ["Speichern", "Abbrechen"]);
  await app.key("Escape");
  await app.waitFor(() => !T.$(".modal"), { what: "Dialog zu" });
});

test("Open dialog: \"Choose file…\" opens a .klangwelt file from anywhere – after asking about unsaved changes", async () => {
  await app.reset();
  await app.eval(() => T.st.run({ type: "addTrack", track: { id: 0, name: "Aus der Datei", kind: "instrument" } }));
  await app.eval((f) => T.st.act(window.__TAURI__.core.invoke("project_save", { path: f })), picked);
  assert.ok(existsSync(picked), "Datei geschrieben");
  await app.eval(() => T.st.act(window.__TAURI__.core.invoke("project_new")));
  await app.eval(() => T.st.run({ type: "addTrack", track: { id: 0, name: "Ungespeichert", kind: "instrument" } }));
  await chooseFile();
  // the Open dialog is gone, the question about the unsaved project comes first
  await app.waitFor(() => T.$(".modal-title")?.textContent === "Ungespeicherte Änderungen", { what: "Frage nach Ungespeichertem" });
  assert.equal(await app.eval(() => T.$$(".modal").length), 1, "Öffnen-Dialog geschlossen");
  await app.clickOn(".modal-actions .btn", { text: "Nicht speichern" });
  await app.waitFor(() => T.st.snapshot.peek().project.tracks[0]?.name === "Aus der Datei", { what: "gewählte Datei geöffnet" });
  const s = await app.eval(() => ({ file: T.st.snapshot.peek().file, dirty: T.st.snapshot.peek().dirty, name: T.$(".proj-name").textContent, modal: !!T.$(".modal") }));
  assert.deepEqual(s, { file: picked, dirty: false, name: "Gewählt", modal: false });
  assert.deepEqual(await tracks(), ["instrument:Aus der Datei"]);
});

test("Open dialog: a damaged file from \"Choose file…\" shows the error, the open project stays", async () => {
  // (continues with the project opened above – saved, so nothing to ask about)
  writeFileSync(picked, "kein ZIP – kaputt");
  await app.eval(() => (T.st.message.value = null));
  await chooseFile();
  const msg = await app.waitFor(() => (T.st.message.peek()?.kind === "error" ? T.st.message.peek().text : null), { what: "Fehlermeldung" });
  assert.ok(msg.includes("Gewählt.klangwelt"), msg);
  assert.equal(await app.eval(() => !!T.$(".modal")), false, "kein Dialog mehr offen");
  assert.deepEqual(await tracks(), ["instrument:Aus der Datei"]);
});

test("Ctrl+Z and Ctrl+Y", async () => {
  await app.reset();
  await app.eval(() => T.st.run({ type: "addTrack", track: { id: 0, name: "Eins", kind: "instrument" } }));
  await app.key("z", { mods: 2 });
  await app.waitFor(() => T.st.snapshot.peek().project.tracks.length === 0, { what: "rückgängig" });
  await app.key("y", { mods: 2 });
  await app.waitFor(() => T.st.snapshot.peek().project.tracks.length === 1, { what: "wiederholt" });
});

// Bug this test found: for an unselected track, the redraw on press replaced
// the icon under the mouse – the first click was lost.
test("toggle the note view in the track header – already with the first click on an unselected track", async () => {
  await app.eval(() => (T.st.selection.value = null));
  const before = await app.eval(() => T.st.snapshot.peek().project.tracks[0].view);
  await app.clickOn("kw-tracks .toggle.v");
  await app.waitFor((b) => T.st.snapshot.peek().project.tracks[0].view !== b, { what: "Ansicht gewechselt" }, before);
  await app.clickOn("kw-tracks .toggle.v");
  await app.waitFor((b) => T.st.snapshot.peek().project.tracks[0].view === b, { what: "Ansicht zurück" }, before);
});

test("no errors in the window", () => {
  assert.deepEqual(app.errors, []);
});

// Projekt: Spuren anlegen und löschen, Demo, Speichern/Öffnen/Neu, ungespeichert-Markierung, Spurkopf.
import { before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { startApp, makeTest } from "./harness.mjs";

let app;
const test = makeTest(() => app);
before(async () => {
  app = await startApp();
});
after(async () => {
  await app?.close();
});

const tracks = () => app.eval(() => T.st.snapshot.peek().project.tracks.map((t) => `${t.kind}:${t.name}`));

test("Leeres Projekt zeigt den Hinweis mit Knöpfen", async () => {
  await app.reset();
  const hint = await app.eval(() => {
    const h = T.$(".empty-hint");
    return h && getComputedStyle(h).display !== "none" ? [...h.querySelectorAll(".btn")].map((b) => b.textContent) : null;
  });
  assert.deepEqual(hint, ["Intro", "Demo laden", "Mit Song starten ▾", "Mit Beat starten ▾", "Instrumentspur", "Aufnehmen"]);
});

test("Instrumentspur über den Hinweis anlegen, Audiospur über den Spurkopf", async () => {
  await app.reset();
  await app.clickOn(".empty-hint .btn", { text: "Instrumentspur" });
  await app.waitFor(() => T.st.snapshot.peek().project.tracks.length === 1, { what: "Spur" });
  await app.clickOn("kw-tracks .btn", { text: "Audio" });
  await app.waitFor(() => T.st.snapshot.peek().project.tracks.length === 2, { what: "zweite Spur" });
  assert.deepEqual(await tracks(), ["instrument:Instrument 1", "audio:Audio 1"]);
});

test("Spur stumm/solo schalten und löschen", async () => {
  const id = await app.eval(() => T.st.snapshot.peek().project.tracks[0].id);
  await app.clickOn(".toggle.m");
  await app.waitFor((id) => T.st.snapshot.peek().project.tracks.find((t) => t.id === id).mute, { what: "stumm" }, id);
  await app.clickOn(".toggle.s");
  await app.waitFor((id) => T.st.snapshot.peek().project.tracks.find((t) => t.id === id).solo, { what: "solo" }, id);
  await app.clickOn(".btn.ghost.small[title='Spur löschen']");
  await app.waitFor(() => T.st.snapshot.peek().project.tracks.length === 1, { what: "gelöscht" });
});

test("Demo laden", async () => {
  await app.reset();
  await app.clickOn(".empty-hint .btn", { text: "Demo laden" });
  await app.waitFor(() => T.st.snapshot.peek().project.tracks.length >= 2, { what: "Demo-Spuren" });
  assert.equal(await app.eval(() => T.st.snapshot.peek().project.tempoBpm), 110);
});

test("Speichern, Neu, Öffnen – mit Markierung für ungespeicherte Änderungen", async () => {
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

test("Strg+Z und Strg+Y", async () => {
  await app.reset();
  await app.eval(() => T.st.run({ type: "addTrack", track: { id: 0, name: "Eins", kind: "instrument" } }));
  await app.key("z", { mods: 2 });
  await app.waitFor(() => T.st.snapshot.peek().project.tracks.length === 0, { what: "rückgängig" });
  await app.key("y", { mods: 2 });
  await app.waitFor(() => T.st.snapshot.peek().project.tracks.length === 1, { what: "wiederholt" });
});

// Fehler, den dieser Test gefunden hat: Bei einer nicht gewählten Spur ersetzte das
// Neuzeichnen beim Drücken das Symbol unter der Maus – der erste Klick ging verloren.
test("Notenansicht im Spurkopf umschalten – schon mit dem ersten Klick auf eine nicht gewählte Spur", async () => {
  await app.eval(() => (T.st.selection.value = null));
  const before = await app.eval(() => T.st.snapshot.peek().project.tracks[0].view);
  await app.clickOn("kw-tracks .toggle.v");
  await app.waitFor((b) => T.st.snapshot.peek().project.tracks[0].view !== b, { what: "Ansicht gewechselt" }, before);
  await app.clickOn("kw-tracks .toggle.v");
  await app.waitFor((b) => T.st.snapshot.peek().project.tracks[0].view === b, { what: "Ansicht zurück" }, before);
});

test("keine Fehler im Fenster", () => {
  assert.deepEqual(app.errors, []);
});

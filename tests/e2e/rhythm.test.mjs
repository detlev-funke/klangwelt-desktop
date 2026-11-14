// Rhythmus-Fenster: Genre-Muster als Schnelleinstieg, Schritt-Raster als
// Eingabehilfe. Entwurf → „In Spur schreiben“ (neue Schlagzeug-Spur mit dem
// Klang des Genres), danach bearbeitet das Raster den Clip (ein Klick = ein
// Rückgängig-Schritt); ein ausgewählter Schlagzeug-Clip wird gelesen, Muster
// ersetzen ihn, Takte und Swing ändern ihn; Anhören mit laufender Spalte;
// neue Trommeln; „Mit Beat starten“ im leeren Projekt; dasselbe per Agent.
import { before, after } from "node:test";
import assert from "node:assert/strict";
import { startApp, makeTest, sleep } from "./harness.mjs";

let app;
const test = makeTest(() => app);
before(async () => {
  app = await startApp();
});
after(async () => {
  await app?.close();
});

const proj = () => app.eval(() => T.st.snapshot.peek().project);
const track = (id) => app.eval((id) => T.st.snapshot.peek().project.tracks.find((t) => t.id === id), id);
async function openPanel() {
  await app.eval(() => T.st.showPanel("rhythmus"));
  await app.waitFor(() => T.$$(".rh-step").length >= 16 * 6, { what: "Raster" });
}
const genre = (name) => app.clickOn(".rh-genre", { text: name });
const pattern = (name) => app.clickOn(`.rh-pattern[data-name="${name}"]`);
/** gesetzte Schritte je Zeile (sichtbare Seite) */
const shown = () => app.eval(() => {
  const out = {};
  for (const c of T.$$(".rh-step.on")) (out[c.dataset.row] ??= []).push(Number(c.dataset.step));
  return out;
});
const step = (row, s) => app.clickOn(`.rh-step[data-row="${row}"][data-step="${s}"]`);

test("Genres und Muster: Klick lädt das Muster ins Raster, Tempo lässt sich übernehmen", async () => {
  await app.reset();
  await openPanel();
  const genres = await app.eval(() => T.$$(".rh-genre").map((b) => b.textContent));
  assert.equal(genres.length, 14);
  assert.ok(genres.includes("House") && genres.includes("Latin / Afro-Cuban"));
  assert.equal(await app.eval(() => T.$(".rh-badge").textContent), "Entwurf");
  await genre("House");
  assert.deepEqual(await app.eval(() => T.$$(".rh-pattern").map((b) => b.dataset.name)), ["Classic House", "Deep House", "French House"]);
  await pattern("Classic House");
  assert.deepEqual(await shown(), { kick: [0, 4, 8, 12], clap: [4, 12], hho: [2, 6, 10, 14] });
  assert.equal(await app.eval(() => T.$(".rh-pattern.on")?.dataset.name), "Classic House");
  assert.match(await app.eval(() => T.$(".rh-about").textContent), /Classic House:/);
  // Tempo der Vorlage übernehmen
  assert.match(await app.eval(() => T.$(".rh-tempo-btn").textContent), /Tempo 124 übernehmen/);
  await app.clickOn(".rh-tempo-btn");
  await app.waitFor(() => T.st.snapshot.peek().project.tempoBpm === 124, { what: "Tempo 124" });
  assert.equal(await app.eval(() => T.$(".rh-tempo-btn").hidden), true);
  // Schritt im Entwurf: Markierung des Musters verschwindet
  await step("rim", 3);
  assert.deepEqual((await shown()).rim, [3]);
  assert.equal(await app.eval(() => T.$(".rh-pattern.on")), null);
  await step("rim", 3);
  assert.equal(await app.eval(() => T.$(".rh-pattern.on")?.dataset.name), "Classic House");
});

test("In Spur schreiben: neue Schlagzeug-Spur mit Genre-Klang, danach bearbeitet das Raster den Clip", async () => {
  await app.reset();
  await openPanel();
  await genre("Trap");
  await pattern("Trap");
  await app.clickOn(".rh-write");
  const sel = await app.waitFor(() => T.st.selection.peek()?.clipId ?? null, { what: "neuer Clip ausgewählt" });
  const p = await proj();
  assert.equal(p.tracks.length, 1);
  const t = p.tracks[0];
  assert.equal(t.instrument.kind, "drums");
  assert.equal(t.instrument.preset, "Trap", "Klang des Genres");
  const clip = t.clips[0];
  assert.equal(clip.id, sel);
  assert.equal(clip.name, "Trap");
  assert.equal(clip.source.lengthBeats, 4);
  assert.equal(clip.source.notes.filter((n) => n.pitch === 39).length, 1, "ein Clap auf der 3");
  await app.waitFor(() => T.$(".rh-badge").textContent === "Clip", { what: "Raster gebunden" });
  assert.equal(await app.eval(() => T.$(".rh-write").hidden), true);
  // Schritt setzen = Note im Clip, ein Rückgängig-Schritt
  const n0 = clip.source.notes.length;
  await step("cow", 6).catch(async () => {
    await app.clickOn(".rh-more");
    await step("cow", 6);
  });
  await app.waitFor((id, n0) => T.st.snapshot.peek().project.tracks.find((t) => t.id === id).clips[0].source.notes.length === n0 + 1, { what: "Cowbell im Clip" }, t.id, n0);
  const cow = (await track(t.id)).clips[0].source.notes.find((n) => n.pitch === 56);
  assert.equal(cow.startBeats, 1.5);
  assert.match(await app.eval(() => T.st.snapshot.peek().undoLabel), /Cowbell auf 7/);
  await app.eval(() => T.st.act(window.__TAURI__.core.invoke("undo")));
  await app.waitFor((id, n0) => T.st.snapshot.peek().project.tracks.find((t) => t.id === id).clips[0].source.notes.length === n0, { what: "zurück" }, t.id, n0);
  await app.waitFor(() => !T.$('.rh-step[data-row="cow"][data-step="6"]')?.classList.contains("on"), { what: "Raster folgt dem Rückgängig" });
});

test("Ausgewählter Schlagzeug-Clip: gelesen, Muster ersetzt ihn, Takte und Swing ändern ihn", async () => {
  await app.reset();
  const { trackId } = await app.mcp("create_instrument_track", { kind: "drums" });
  const clipId = (await track(trackId)).clips[0].id;
  await openPanel();
  await app.eval((s) => (T.st.selection.value = s), { trackId, clipId });
  await app.waitFor(() => T.$(".rh-badge").textContent === "Clip", { what: "gebunden" });
  // das 4-taktige Beispielmuster: vier Seiten
  await app.waitFor(() => T.$$(".rh-pages .seg-btn").length === 4 && !T.$(".rh-pages").hidden, { what: "vier Takte" });
  assert.ok(Object.keys(await shown()).includes("kick"));
  await app.clickOn('.rh-pages .seg-btn[data-page="2"]');
  assert.ok(await app.eval(() => T.$$(".rh-step").every((c) => Number(c.dataset.step) >= 32 && Number(c.dataset.step) < 48)), "Takt 3 sichtbar");
  // Muster ersetzt den Clip (vier Takte bleiben)
  await genre("Techno");
  await pattern("Techno");
  await app.waitFor((t, c) => T.st.snapshot.peek().project.tracks.find((x) => x.id === t).clips.find((x) => x.id === c).name === "Techno", { what: "Clip ist Techno" }, trackId, clipId);
  let clip = (await track(trackId)).clips.find((c) => c.id === clipId);
  assert.equal(clip.source.lengthBeats, 16);
  assert.equal(clip.source.notes.filter((n) => n.pitch === 36).length, 20, "5 Kicks × 4 Takte");
  await app.waitFor(() => T.$(".rh-pattern.on")?.dataset.name === "Techno", { what: "Muster erkannt" });
  // ein Takt
  await app.clickOn('.rh-bars .seg-btn[data-bars="1"]');
  await app.waitFor((t, c) => T.st.snapshot.peek().project.tracks.find((x) => x.id === t).clips.find((x) => x.id === c).source.lengthBeats === 4, { what: "ein Takt" }, trackId, clipId);
  assert.equal(await app.eval(() => T.$(".rh-pages").hidden), true);
  // Swing: die Hi-Hat auf Schritt 10 (ungerade Sechzehntel) rückt nach hinten, die Kicks bleiben
  await app.eval(() => {
    const r = T.$(".rh-swing");
    r.dispatchEvent(new PointerEvent("pointerdown"));
    r.value = "50";
    r.dispatchEvent(new Event("input"));
    r.dispatchEvent(new Event("change"));
  });
  await app.waitFor((t, c) => T.st.snapshot.peek().project.tracks.find((x) => x.id === t).clips.find((x) => x.id === c).source.notes.some((n) => n.pitch === 42 && n.startBeats > 2.3 && n.startBeats < 2.4), { what: "geswingt" }, trackId, clipId);
  clip = (await track(trackId)).clips.find((c) => c.id === clipId);
  assert.deepEqual(clip.source.notes.filter((n) => n.pitch === 36).map((n) => n.startBeats), [0, 1, 2, 3, 3.5]);
  await app.waitFor(() => T.$(".rh-swing-val").textContent === "50 %", { what: "Swing gelesen" });
  // das Raster zeigt den geswingten Clip unverändert als Techno
  assert.deepEqual((await shown()).kick, [0, 4, 8, 12, 14]);
});

test("Weitere Trommeln: ausgeblendet, bis sie gebraucht oder aufgeklappt werden", async () => {
  await app.reset();
  await openPanel();
  // „weitere Trommeln“ ist gemerkt – zu Beginn zuklappen
  if (await app.eval(() => T.$(".rh-more").textContent.startsWith("weniger"))) await app.clickOn(".rh-more");
  await genre("Grundlagen");
  await pattern("Boots ’n’ Cats");
  const rows = () => app.eval(() => T.$$(".rh-row").map((r) => r.dataset.row));
  assert.deepEqual(await rows(), ["kick", "snare", "clap", "rim", "hhc", "hho"]);
  await genre("Rock / Pop");
  await pattern("Rock");
  assert.ok((await rows()).includes("crash"), "Crash erscheint mit dem Muster");
  await genre("Latin / Afro-Cuban");
  await pattern("Songo");
  assert.ok((await rows()).includes("cow") && !(await rows()).includes("crash"));
  await app.clickOn(".rh-more");
  assert.deepEqual(await rows(), ["kick", "snare", "clap", "rim", "hhc", "hho", "crash", "ride", "cow", "tomh", "tomm", "toml", "shk"]);
  await app.clickOn(".rh-more");
  assert.equal((await rows()).length, 7);
});

test("Anhören: spielt im Projekttempo, die Spalte läuft mit, Stopp beendet", async () => {
  await app.reset();
  await openPanel();
  await genre("House");
  await pattern("Classic House");
  // Vorhören abfangen (ohne Audio): Argumente festhalten, 1,2 s Dauer melden
  await app.eval(() => {
    window.__rh = [];
    const core = window.__TAURI__.core;
    window.__TAURI__.core = { ...core, invoke: (cmd, args, opts) => {
      if (cmd === "rhythm_preview") {
        window.__rh.push(args);
        return Promise.resolve(1.2);
      }
      if (cmd === "preview_stop") return Promise.resolve(null);
      return core.invoke(cmd, args, opts);
    } };
  });
  try {
    await app.clickOn(".rh-play");
    const args = await app.eval(() => window.__rh[0]);
    assert.equal(args.grid.steps, 16);
    assert.deepEqual(args.grid.rows.kick, [0, 4, 8, 12]);
    assert.equal(args.sound, "House", "ohne Spur mit dem Klang des Genres");
    await app.waitFor(() => T.$(".rh-step.now"), { what: "laufende Spalte" });
    assert.match(await app.eval(() => T.$(".rh-play").textContent), /Stopp/);
    await app.clickOn(".rh-play");
    assert.equal(await app.eval(() => T.$(".rh-step.now")), null);
    assert.match(await app.eval(() => T.$(".rh-play").textContent), /Anhören/);
  } finally {
    await app.eval(() => location.reload());
    const { injectHelpers } = await import("./harness.mjs");
    await injectHelpers(app);
  }
});

test("Leeres Projekt: „Mit Beat starten ▾“ legt eine Vorlage als Schlagzeug-Spur an", async () => {
  await app.reset();
  await app.waitFor(() => T.$(".empty-hint .beat-start")?.checkVisibility(), { what: "Knopf im leeren Projekt" });
  await app.clickOn(".empty-hint .beat-start");
  await app.waitFor(() => T.$$(".beat-menu .beat-row").length === 14, { what: "14 Genres" });
  assert.deepEqual(await app.eval(() => T.$$('.beat-menu .beat-row[data-genre="House"] .beat-chip').map((b) => b.dataset.name)), ["Classic House", "Deep House", "French House"]);
  await app.clickOn('.beat-menu .beat-row[data-genre="House"] .beat-chip[data-name="Deep House"]');
  const sel = await app.waitFor(() => T.st.selection.peek()?.clipId ?? null, { what: "Clip ausgewählt" });
  const p = await proj();
  assert.equal(p.tempoBpm, 122, "Tempo der Vorlage");
  assert.equal(p.tracks.length, 1);
  assert.equal(p.tracks[0].instrument.preset, "House", "Klang des Genres");
  const clip = p.tracks[0].clips[0];
  assert.equal(clip.id, sel);
  assert.equal(clip.name, "Deep House");
  assert.equal(clip.source.lengthBeats, 16, "vier Takte");
  await app.waitFor(() => T.$(".rh-badge")?.textContent === "Clip" && T.$(".rh").checkVisibility(), { what: "Rhythmus-Fenster zeigt den Clip" });
  assert.equal(await app.eval(() => T.$(".beat-menu")?.classList.contains("open") ?? false), false, "Menü zu");
  // ein Rückgängig-Schritt: wieder leer, Tempo zurück
  await app.eval(() => T.st.act(window.__TAURI__.core.invoke("undo")));
  await app.waitFor(() => T.st.snapshot.peek().project.tracks.length === 0 && T.st.snapshot.peek().project.tempoBpm === 120, { what: "wieder leer" });
});

test("Neue Trommeln: Rim, Crash, Ride, Cowbell, Shaker in der Notenrolle", async () => {
  const list = await app.mcp("list_instruments", {});
  const drums = list.instrumente.find((s) => s.kind === "drums");
  const keys = Object.fromEntries(drums.keys.map((k) => [k.midi, k.name]));
  assert.deepEqual([keys[37], keys[49], keys[51], keys[56], keys[70]], ["Rim", "Crash", "Ride", "Cowbell", "Shaker"]);
});

test("Agent: Muster auflisten, schreiben, lesen", async () => {
  await app.reset();
  const list = await app.mcp("list_drum_patterns", { genre: "house" });
  assert.equal(list.genres.length, 1);
  assert.equal(list.genres[0].muster[0].zeilen.kick, "x...x...x...x...");
  assert.ok(list.trommeln.some((t) => t.key === "cow" && t.taste === 56));
  const w = await app.mcp("write_drum_pattern", { genre: "House", pattern: "Deep House", setTempo: true });
  assert.equal(w.takte, 4);
  assert.equal((await proj()).tempoBpm, 122);
  const t = await track(w.trackId);
  assert.equal(t.instrument.preset, "House");
  assert.equal(t.clips[0].source.lengthBeats, 16);
  const r = await app.mcp("read_drum_pattern", { trackId: w.trackId, clipId: w.clipId });
  assert.equal(r.takte, 4);
  assert.equal(r.zeilen.kick, "x...x...x...x...".repeat(4));
  assert.equal(r.nichtImRaster, 0);
  // eigene Zeilen in dieselbe Spur: neuer Clip hinter dem letzten
  const own = await app.mcp("write_drum_pattern", { trackId: w.trackId, rows: { kick: "x.......x.......", snare: [5, 13] }, bars: 1, swing: 30 });
  assert.equal(own.startBeats, 16);
  const t2 = await track(w.trackId);
  assert.equal(t2.clips.length, 2);
  assert.equal((await app.mcp("read_drum_pattern", { trackId: w.trackId, clipId: own.clipId })).swing, 0, "keine ungeraden Schritte – kein Swing messbar");
  // Fehler mit Hinweis
  await assert.rejects(app.mcp("write_drum_pattern", { genre: "Polka" }), /Kein Genre „Polka“/);
  await assert.rejects(app.mcp("write_drum_pattern", { rows: { gong: "x" } }), /Unbekannte Trommel „gong“/);
  await assert.rejects(app.mcp("write_drum_pattern", {}), /genre\/pattern oder rows/);
  await assert.rejects(app.mcp("read_drum_pattern", { trackId: w.trackId, clipId: 999 }), /nicht gefunden/);
  await sleep(10);
});

test("keine Fehler im Fenster", () => {
  assert.deepEqual(app.errors, []);
});

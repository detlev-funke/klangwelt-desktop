// Klang-Bibliothek („Meine Klänge“ im Klang-Fenster): aktuelle Einstellung
// unter einem Namen sichern, laden (ein Rückgängig-Schritt), gleicher Name
// ersetzt, Vorschlag aus dem Charakter-Startpunkt, umbenennen, löschen mit
// zweitem Klick, Klänge anderer Instrumente, Neustart, dasselbe per Agent.
import { before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startApp, makeTest, sleep } from "./harness.mjs";

let app;
const test = makeTest(() => app);
before(async () => {
  app = await startApp();
});
after(async () => {
  await app?.close();
});

const file = () => join(app.tmp, "bibliothek", "Klänge", "klaenge.json");
const stored = () => JSON.parse(readFileSync(file(), "utf8")).sounds;
const inst = (id) => app.eval((id) => T.st.snapshot.peek().project.tracks.find((t) => t.id === id).instrument, id);
async function open(kind) {
  const r = await app.mcp("create_instrument_track", { kind });
  await app.eval((id) => {
    T.st.selection.value = { trackId: id, clipId: null };
    T.st.showPanel("klang");
  }, r.trackId);
  await app.waitFor(() => T.$$(".snd-field").length === 3 && T.$(".snd-lib-save"), { what: "Klang-Fenster" });
  // Vorhören beim Loslassen aus – die Tests sollen leise sein
  await app.eval(() => T.$(".snd-play .seg-btn[data-mode=aus]").click());
  // „Meine Klänge“ ist anfangs eingeklappt
  await app.eval(() => {
    if (!T.$(".snd-lib-box").open) T.$(".snd-lib-box > summary").click();
  });
  return r.trackId;
}
const mark = (field, name) => app.clickOn(`.snd-field[data-field=${field}] .snd-mark`, { text: name });
const items = () => app.eval(() => T.$$(".snd-lib-list .snd-lib-item").map((el) => ({ name: el.dataset.name, on: el.classList.contains("on"), text: el.textContent })));
const item = (name) => `.snd-lib-list .snd-lib-item[data-name="${name}"]`;

/** In ein Textfeld tippen (echte Tastatur), optional mit Enter abschließen. */
async function typeInto(selector, text, { enter = false } = {}) {
  await app.clickOn(selector);
  await app.eval((s) => T.$(s)?.select(), selector);
  await app.send("Input.insertText", { text });
  if (enter) {
    const k = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await app.send("Input.dispatchKeyEvent", { type: "keyDown", ...k, text: "\r" });
    await app.send("Input.dispatchKeyEvent", { type: "keyUp", ...k });
  }
  await sleep(150);
}

test("Meine Klänge ist anfangs eingeklappt, zeigt Anzahl und eingestellten Klang", async () => {
  await app.reset();
  const { trackId } = await app.mcp("create_instrument_track", { kind: "drums" });
  await app.eval((id) => {
    T.st.selection.value = { trackId: id, clipId: null };
    T.st.showPanel("klang");
  }, trackId);
  await app.waitFor(() => T.$(".snd-lib-box"), { what: "Klang-Fenster" });
  assert.equal(await app.eval(() => T.$(".snd-lib-box").open), false, "eingeklappt");
  assert.equal(await app.eval(() => T.$(".snd-lib-name").checkVisibility()), false, "Inhalt verborgen");
  assert.equal(await app.eval(() => T.$(".snd-lib-badge").textContent), "0");
  // der Agent sichert die aktuelle Einstellung: eingeklappt sichtbar als Anzahl und Name
  await app.mcp("save_sound", { trackId, name: "Grundbeat" });
  await app.waitFor(() => T.$(".snd-lib-badge").textContent === "1 · Grundbeat", { what: "Kurzinfo" });
  await app.clickOn(".snd-lib-box > summary");
  assert.equal(await app.eval(() => T.$(".snd-lib-box").open), true);
  assert.equal(await app.eval(() => JSON.parse(localStorage.getItem("klangwelt.klang.ansicht")).klaenge), true, "gemerkt");
  await app.mcp("delete_saved_sound", { sound: "Grundbeat" });
  await app.waitFor(() => T.$(".snd-lib-badge").textContent === "0", { what: "wieder leer" });
});

test("Sichern, verändern, laden – Laden ist ein Rückgängig-Schritt", async () => {
  await app.reset();
  const id = await open("drums");
  assert.match(await app.eval(() => T.$(".snd-lib-empty").textContent), /Noch keine eigenen Klänge für Schlagzeug/);
  await mark("charakter", "Trap");
  await mark("klangfarbe", "Staub");
  await app.waitFor((id) => T.st.snapshot.peek().project.tracks.find((t) => t.id === id).instrument.params.rauheit > 0.7, { what: "Staub" }, id);
  const saved = await inst(id);
  await typeInto(".snd-lib-name", "Mein Trap", { enter: true });
  await app.waitFor((s) => T.$(s)?.classList.contains("on"), { what: "gesichert und hervorgehoben" }, item("Mein Trap"));
  assert.equal(await app.eval(() => T.$(".snd-lib-name").value), "", "Feld geleert");
  // in der Datei: vollständiges Instrument
  assert.ok(existsSync(file()), file());
  const [s] = stored();
  assert.equal(s.name, "Mein Trap");
  assert.equal(s.instrument.kind, "drums");
  assert.equal(s.instrument.preset, "Trap");
  assert.equal(s.instrument.params.rauheit, saved.params.rauheit);
  assert.match((await items())[0].text, /Trap · dunkel, körnig · schmal, nah/);
  // verändern: nicht mehr hervorgehoben
  await mark("charakter", "House");
  await app.waitFor((s) => !T.$(s).classList.contains("on"), { what: "nicht mehr hervorgehoben" }, item("Mein Trap"));
  // laden
  await app.clickOn(`${item("Mein Trap")} .snd-lib-load`);
  await app.waitFor((s) => T.$(s).classList.contains("on"), { what: "geladen" }, item("Mein Trap"));
  const loaded = await inst(id);
  assert.equal(loaded.preset, "Trap");
  assert.deepEqual(loaded.params, s.instrument.params);
  assert.match(await app.eval(() => T.st.snapshot.peek().undoLabel ?? ""), /„Mein Trap“ laden/);
  // ein Rückgängig-Schritt zurück zu House
  await app.eval(() => T.st.act(window.__TAURI__.core.invoke("undo")));
  await app.waitFor((id) => T.st.snapshot.peek().project.tracks.find((t) => t.id === id).instrument.preset === "House", { what: "zurück zu House" }, id);
});

test("Gleicher Name ersetzt; ohne Namen der Vorschlag aus dem Startpunkt", async () => {
  await app.reset();
  const id = await open("drums");
  await mark("charakter", "Rock");
  await app.waitFor(() => T.$(".snd-lib-name").placeholder === "Rock", { what: "Vorschlag Rock" });
  assert.match(await app.eval(() => T.$(".snd-lib-save").textContent), /Sichern/);
  await app.clickOn(".snd-lib-save");
  await app.waitFor((s) => T.$(s)?.classList.contains("on"), { what: "Rock gesichert" }, item("Rock"));
  // nächster Vorschlag ist frei
  await app.waitFor(() => T.$(".snd-lib-name").placeholder === "Rock 2", { what: "Vorschlag Rock 2" });
  // gleicher Name (andere Schreibweise) → Ersetzen
  await mark("raum", "Kirche");
  await app.waitFor((id) => T.st.snapshot.peek().project.tracks.find((t) => t.id === id).instrument.params.raum === 0.9, { what: "Kirche" }, id);
  await typeInto(".snd-lib-name", "rock");
  assert.match(await app.eval(() => T.$(".snd-lib-save").textContent), /Ersetzen/);
  const before = stored().length;
  await app.clickOn(".snd-lib-save");
  await app.waitFor((s) => T.$(s)?.classList.contains("on"), { what: "ersetzt und hervorgehoben" }, item("Rock"));
  const rock = stored().filter((s) => s.name === "Rock");
  assert.equal(stored().length, before, "kein zweiter Eintrag");
  assert.equal(rock.length, 1);
  assert.equal(rock[0].instrument.params.raum, 0.9);
});

test("Umbenennen und Löschen (zweiter Klick)", async () => {
  await app.reset();
  await open("drums");
  await app.waitFor((s) => T.$(s), { what: "Rock in der Liste" }, item("Rock"));
  await app.clickOn(`${item("Rock")} .snd-lib-ren`);
  await app.waitFor(() => T.$(".snd-lib-item .snd-lib-rename"), { what: "Eingabefeld" });
  await typeInto(".snd-lib-item .snd-lib-rename", "Stadion", { enter: true });
  await app.waitFor((s) => T.$(s), { what: "umbenannt" }, item("Stadion"));
  assert.ok(stored().some((s) => s.name === "Stadion") && !stored().some((s) => s.name === "Rock"));
  // erster Klick fragt nur
  const n = stored().length;
  await app.clickOn(`${item("Stadion")} .snd-lib-del`);
  assert.match(await app.eval((s) => T.$(s).textContent, `${item("Stadion")} .snd-lib-del`), /Löschen\?/);
  assert.equal(stored().length, n, "noch nicht gelöscht");
  await app.clickOn(`${item("Stadion")} .snd-lib-del`);
  await app.waitFor((s) => !T.$(s), { what: "gelöscht" }, item("Stadion"));
  assert.equal(stored().length, n - 1);
});

test("Klang eines anderen Instruments: wechselt das Instrument der Spur", async () => {
  await app.reset();
  const synth = await open("synth");
  await app.clickOn(".snd-vchip", { text: "Glocke" });
  await app.waitFor((id) => T.st.snapshot.peek().project.tracks.find((t) => t.id === id).instrument.curves.laut[1][1] === 1, { what: "Glocke" }, synth);
  await typeInto(".snd-lib-name", "Glas-Glocke", { enter: true });
  await app.waitFor((s) => T.$(s)?.classList.contains("on"), { what: "Synth gesichert" }, item("Glas-Glocke"));
  assert.match((await items()).find((i) => i.name === "Glas-Glocke").text, /Verlauf Glocke/);
  const glocke = await inst(synth);
  // Schlagzeugspur: der Synth-Klang steht unter „Andere Instrumente“
  const drums = await open("drums");
  assert.equal((await items()).some((i) => i.name === "Glas-Glocke"), false);
  assert.match(await app.eval(() => T.$(".snd-lib-others > summary").textContent), /Andere Instrumente \(1\)/);
  await app.clickOn(".snd-lib-others > summary");
  await app.clickOn(`.snd-lib-others .snd-lib-item[data-name="Glas-Glocke"] .snd-lib-load`);
  await app.waitFor((id) => T.st.snapshot.peek().project.tracks.find((t) => t.id === id).instrument.kind === "synth", { what: "Spur ist jetzt Synth" }, drums);
  const now = await inst(drums);
  assert.deepEqual(now.curves, glocke.curves);
  assert.deepEqual(now.params, glocke.params);
  // das Fenster zeigt jetzt den Synth, der Klang ist hervorgehoben
  await app.waitFor((s) => T.$(s)?.classList.contains("on"), { what: "hervorgehoben im Synth-Fenster" }, item("Glas-Glocke"));
});

test("Agent: sichern, auflisten, laden, umbenennen, löschen – die Liste folgt", async () => {
  await app.reset();
  const id = await open("bass");
  await app.mcp("set_sound_field", { trackId: id, field: "charakter", preset: "Acid" });
  const r = await app.mcp("save_sound", { trackId: id, name: "Agent-Acid" });
  assert.equal(r.ersetzt, false);
  assert.match(r.beschreibung, /^Acid/);
  // die Oberfläche zeigt ihn ohne eigenes Zutun
  await app.waitFor((s) => T.$(s)?.classList.contains("on"), { what: "Agent-Klang in der Liste" }, item("Agent-Acid"));
  const list = await app.mcp("list_saved_sounds", { kind: "bass" });
  assert.deepEqual(list.klaenge.map((k) => k.name), ["Agent-Acid"]);
  assert.ok(list.datei.endsWith("klaenge.json"));
  assert.ok((await app.mcp("list_saved_sounds", {})).klaenge.length > 1, "ohne kind alle");
  await app.mcp("set_sound_field", { trackId: id, field: "charakter", preset: "Sub-Bass" });
  const loaded = await app.mcp("load_saved_sound", { trackId: id, sound: "agent-acid" });
  assert.equal(loaded.geladen, "Agent-Acid");
  assert.ok(loaded.anzeige.length > 0, "Messwerte");
  assert.equal((await inst(id)).preset, "Acid");
  await app.mcp("rename_saved_sound", { sound: "Agent-Acid", name: "Säure" });
  await app.waitFor((s) => T.$(s), { what: "umbenannt in der Liste" }, item("Säure"));
  await app.mcp("delete_saved_sound", { sound: "Säure" });
  await app.waitFor((s) => !T.$(s), { what: "gelöscht in der Liste" }, item("Säure"));
  await assert.rejects(app.mcp("load_saved_sound", { trackId: id, sound: "Säure" }), /Kein Klang „Säure“/);
  await assert.rejects(app.mcp("save_sound", { trackId: id, name: "  " }), /braucht einen Namen/);
});

test("Nach einem Neustart sind die Klänge noch da", async () => {
  const before = stored().map((s) => s.name).sort();
  assert.ok(before.length >= 2);
  const errors = app.errors;
  await app.stop();
  app = await startApp({ tmp: app.tmp });
  app.errors.push(...errors);
  await open("drums");
  await app.waitFor((s) => T.$(s), { what: "Mein Trap nach dem Neustart" }, item("Mein Trap"));
  const synth = await app.mcp("list_saved_sounds", {});
  assert.deepEqual(synth.klaenge.map((k) => k.name).sort(), before);
});

test("keine Fehler im Fenster", () => {
  assert.deepEqual(app.errors, []);
});

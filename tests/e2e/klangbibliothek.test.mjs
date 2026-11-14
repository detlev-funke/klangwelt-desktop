// Sound library ("My sounds" in the Sound window): save the current setting
// under a name, load it (one undo step), same name
// replaces, suggestion from the character starting point, rename, delete with
// a second click, sounds of other instruments, restart, the same via the agent.
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
  // Preview on release off – the tests should be quiet
  await app.eval(() => T.$(".snd-play .seg-btn[data-mode=aus]").click());
  // "My sounds" is initially collapsed
  await app.eval(() => {
    if (!T.$(".snd-lib-box").open) T.$(".snd-lib-box > summary").click();
  });
  return r.trackId;
}
const mark = (field, name) => app.clickOn(`.snd-field[data-field=${field}] .snd-mark`, { text: name });
const items = () => app.eval(() => T.$$(".snd-lib-list .snd-lib-item").map((el) => ({ name: el.dataset.name, on: el.classList.contains("on"), text: el.textContent })));
const item = (name) => `.snd-lib-list .snd-lib-item[data-name="${name}"]`;

/** Types into a text field (real keyboard), optionally finishing with Enter. */
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

test("My sounds is collapsed at first, shows count and current sound", async () => {
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
  // the agent saves the current setting: collapsed, visible as count and name
  await app.mcp("save_sound", { trackId, name: "Grundbeat" });
  await app.waitFor(() => T.$(".snd-lib-badge").textContent === "1 · Grundbeat", { what: "Kurzinfo" });
  await app.clickOn(".snd-lib-box > summary");
  assert.equal(await app.eval(() => T.$(".snd-lib-box").open), true);
  assert.equal(await app.eval(() => JSON.parse(localStorage.getItem("klangwelt.klang.ansicht")).klaenge), true, "gemerkt");
  await app.mcp("delete_saved_sound", { sound: "Grundbeat" });
  await app.waitFor(() => T.$(".snd-lib-badge").textContent === "0", { what: "wieder leer" });
});

test("save, change, load – loading is one undo step", async () => {
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
  // in the file: complete instrument
  assert.ok(existsSync(file()), file());
  const [s] = stored();
  assert.equal(s.name, "Mein Trap");
  assert.equal(s.instrument.kind, "drums");
  assert.equal(s.instrument.preset, "Trap");
  assert.equal(s.instrument.params.rauheit, saved.params.rauheit);
  assert.match((await items())[0].text, /Trap · dunkel, körnig · schmal, nah/);
  // change it: no longer highlighted
  await mark("charakter", "House");
  await app.waitFor((s) => !T.$(s).classList.contains("on"), { what: "nicht mehr hervorgehoben" }, item("Mein Trap"));
  // load
  await app.clickOn(`${item("Mein Trap")} .snd-lib-load`);
  await app.waitFor((s) => T.$(s).classList.contains("on"), { what: "geladen" }, item("Mein Trap"));
  const loaded = await inst(id);
  assert.equal(loaded.preset, "Trap");
  assert.deepEqual(loaded.params, s.instrument.params);
  assert.match(await app.eval(() => T.st.snapshot.peek().undoLabel ?? ""), /„Mein Trap“ laden/);
  // one undo step back to House
  await app.eval(() => T.st.act(window.__TAURI__.core.invoke("undo")));
  await app.waitFor((id) => T.st.snapshot.peek().project.tracks.find((t) => t.id === id).instrument.preset === "House", { what: "zurück zu House" }, id);
});

test("same name replaces; without a name the suggestion from the starting point", async () => {
  await app.reset();
  const id = await open("drums");
  await mark("charakter", "Rock");
  await app.waitFor(() => T.$(".snd-lib-name").placeholder === "Rock", { what: "Vorschlag Rock" });
  assert.match(await app.eval(() => T.$(".snd-lib-save").textContent), /Sichern/);
  await app.clickOn(".snd-lib-save");
  await app.waitFor((s) => T.$(s)?.classList.contains("on"), { what: "Rock gesichert" }, item("Rock"));
  // next suggestion is free
  await app.waitFor(() => T.$(".snd-lib-name").placeholder === "Rock 2", { what: "Vorschlag Rock 2" });
  // same name (different spelling) → replace
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

test("rename and delete (second click)", async () => {
  await app.reset();
  await open("drums");
  await app.waitFor((s) => T.$(s), { what: "Rock in der Liste" }, item("Rock"));
  await app.clickOn(`${item("Rock")} .snd-lib-ren`);
  await app.waitFor(() => T.$(".snd-lib-item .snd-lib-rename"), { what: "Eingabefeld" });
  await typeInto(".snd-lib-item .snd-lib-rename", "Stadion", { enter: true });
  await app.waitFor((s) => T.$(s), { what: "umbenannt" }, item("Stadion"));
  assert.ok(stored().some((s) => s.name === "Stadion") && !stored().some((s) => s.name === "Rock"));
  // first click only asks
  const n = stored().length;
  await app.clickOn(`${item("Stadion")} .snd-lib-del`);
  assert.match(await app.eval((s) => T.$(s).textContent, `${item("Stadion")} .snd-lib-del`), /Löschen\?/);
  assert.equal(stored().length, n, "noch nicht gelöscht");
  await app.clickOn(`${item("Stadion")} .snd-lib-del`);
  await app.waitFor((s) => !T.$(s), { what: "gelöscht" }, item("Stadion"));
  assert.equal(stored().length, n - 1);
});

test("sound of another instrument: switches the track's instrument", async () => {
  await app.reset();
  const synth = await open("synth");
  await app.clickOn(".snd-vchip", { text: "Glocke" });
  await app.waitFor((id) => T.st.snapshot.peek().project.tracks.find((t) => t.id === id).instrument.curves.laut[1][1] === 1, { what: "Glocke" }, synth);
  await typeInto(".snd-lib-name", "Glas-Glocke", { enter: true });
  await app.waitFor((s) => T.$(s)?.classList.contains("on"), { what: "Synth gesichert" }, item("Glas-Glocke"));
  assert.match((await items()).find((i) => i.name === "Glas-Glocke").text, /Verlauf Glocke/);
  const glocke = await inst(synth);
  // drum track: the synth sound is under "Other instruments"
  const drums = await open("drums");
  assert.equal((await items()).some((i) => i.name === "Glas-Glocke"), false);
  assert.match(await app.eval(() => T.$(".snd-lib-others > summary").textContent), /Andere Instrumente \(1\)/);
  await app.clickOn(".snd-lib-others > summary");
  await app.clickOn(`.snd-lib-others .snd-lib-item[data-name="Glas-Glocke"] .snd-lib-load`);
  await app.waitFor((id) => T.st.snapshot.peek().project.tracks.find((t) => t.id === id).instrument.kind === "synth", { what: "Spur ist jetzt Synth" }, drums);
  const now = await inst(drums);
  assert.deepEqual(now.curves, glocke.curves);
  assert.deepEqual(now.params, glocke.params);
  // the window now shows the synth, the sound is highlighted
  await app.waitFor((s) => T.$(s)?.classList.contains("on"), { what: "hervorgehoben im Synth-Fenster" }, item("Glas-Glocke"));
});

test("agent: save, list, load, rename, delete – the list follows", async () => {
  await app.reset();
  const id = await open("bass");
  await app.mcp("set_sound_field", { trackId: id, field: "charakter", preset: "Acid" });
  const r = await app.mcp("save_sound", { trackId: id, name: "Agent-Acid" });
  assert.equal(r.ersetzt, false);
  assert.match(r.beschreibung, /^Acid/);
  // the UI shows it without any action of its own
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

test("after a restart the sounds are still there", async () => {
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

test("no errors in the window", () => {
  assert.deepEqual(app.errors, []);
});

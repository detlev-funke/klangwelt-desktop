// "History" window: every edit step as a table with time, label, where and the
// project's key figures; a click on a row jumps to that state, Ctrl+Z / Ctrl+Y
// walk the same line; checkpoints and variants; editing after going back keeps
// the later steps as a branch; the history is saved in the .klangwelt file and
// comes back when it is opened (also in a freshly started app).
import { before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { startApp, makeTest, MOD } from "./harness.mjs";

let app;
const test = makeTest(() => app);
before(async () => {
  app = await startApp();
});
after(async () => {
  await app?.close();
});

const invoke = (cmd, args) => app.eval((c, a) => T.st.act(window.__TAURI__.core.invoke(c, a)), cmd, args);
const rows = () => app.eval(() => T.$$(".hist-row").map((r) => ({
  cells: [...r.children].map((c) => c.textContent.trim()),
  current: r.classList.contains("current"),
  future: r.classList.contains("future"),
})));
const labels = () => app.eval(() => T.$$(".hist-row .hist-label").map((l) => l.textContent));
const names = () => app.eval(() => T.st.snapshot.peek().project.tracks.map((t) => t.name));
const variants = () => app.eval(() => T.$$(".hist-var").map((b) => ({ name: b.childNodes[1].textContent, on: b.classList.contains("on") })));
const current = (n) => app.waitFor((i) => T.$(`.hist-row:nth-child(${i})`)?.classList.contains("current"), { what: `Zeile ${n} aktuell` }, n);

async function fresh() {
  await app.reset();
  await app.eval(() => T.st.showPanel("historie"));
  await app.waitFor(() => T.$$(".hist-row").length === 1 && T.$(".hist-row").textContent.includes("Neues Projekt"), { what: "leere Historie" });
}

/** Lead track, a clip with eight notes, tempo 90. */
async function someSteps() {
  await app.eval(async () => {
    await T.st.run({ type: "addTrack", track: { id: 0, name: "Lead", kind: "instrument" } });
    const t = T.st.snapshot.peek().project.tracks.at(-1);
    const notes = [60, 64, 67, 72, 69, 65, 62, 60].map((p, i) => ({ pitch: p, startBeats: i, lengthBeats: 1, velocity: 90 }));
    await T.st.run({ type: "addClip", trackId: t.id, clip: { id: 0, name: "Thema", startBeats: 8, source: { type: "notes", lengthBeats: 8, notes } } });
    await T.st.run({ type: "setProject", patch: { tempoBpm: 90 } });
  });
  await app.waitFor(() => T.$$(".hist-row").length === 4, { what: "vier Zeilen" });
}

test("the window is in the Windows menu and shows every step with its key figures", async () => {
  await fresh();
  await app.clickOn(".win-btn");
  assert.ok(await app.eval(() => T.$$(".win-menu .menu-item em").some((e) => e.textContent === "Historie")), "Fenster-Menü");
  await app.key("Escape");
  await app.clickOn(".win-btn");
  await someSteps();
  assert.deepEqual(await labels(), ["Neues Projekt", "Spur hinzufügen", "Clip hinzufügen", "Tempo ändern"]);
  const clip = (await rows())[2].cells;
  assert.match(clip[1], /^\d\d:\d\d:\d\d$/);
  assert.equal(clip[3], "Lead · Takt 3–4 · +8 Noten");
  assert.deepEqual(clip.slice(4), ["8+8", "4", "0:08", "1", "1", "120", "C-Dur"]);
  assert.equal((await rows())[3].cells[3], "120 → 90 BPM");
  assert.deepEqual((await rows()).map((r) => r.current), [false, false, false, true]);
  // the toolbar's undo goes along the table
  await app.clickOn("kw-transport .undo-btn");
  await current(3);
  assert.equal(await app.eval(() => T.st.snapshot.peek().project.tempoBpm), 120);
  await app.shot("historie-desktop");
  assert.deepEqual(app.errors, []);
});

test("click on a row goes back, Ctrl+Y / Ctrl+Z step along, a later row redoes up to it", async () => {
  await fresh();
  await someSteps();
  await app.clickOn(".hist-row:nth-child(2)");
  await current(2);
  assert.deepEqual(await names(), ["Lead"]);
  assert.deepEqual((await rows()).map((r) => r.future), [false, false, true, true]);
  await app.key("y", { mods: MOD.ctrl });
  await current(3);
  await app.key("z", { mods: MOD.ctrl });
  await current(2);
  await app.clickOn(".hist-row:nth-child(4)");
  await current(4);
  assert.equal(await app.eval(() => T.st.snapshot.peek().project.tempoBpm), 90);
});

test("editing after going back: the later steps stay and come back as a variant", async () => {
  await fresh();
  await someSteps();
  await app.clickOn(".hist-row:nth-child(2)");
  await current(2);
  await app.eval(() => T.st.run({ type: "addTrack", track: { id: 0, name: "Bass", kind: "instrument" } }));
  await app.waitFor(() => T.$$(".hist-row").length === 3 && !!T.$(".hist-fork.abandoned"), { what: "beiseitegelegte Schritte" });
  assert.equal(await app.eval(() => T.$(".hist-fork.abandoned").textContent.trim()), "2 Schritte");
  await app.clickOn(".hist-fork.abandoned");
  await app.waitFor(() => T.$$(".hist-var").length === 2, { what: "Variante" });
  assert.deepEqual(await variants(), [{ name: "Hauptversion", on: false }, { name: "Variante 2", on: true }]);
  assert.deepEqual(await names(), ["Lead"]);
  assert.equal(await app.eval(() => T.st.snapshot.peek().project.tempoBpm), 90);
  await app.clickOn(".hist-var", { text: "Hauptversion" });
  await app.waitFor(() => T.st.snapshot.peek().project.tracks.map((t) => t.name).join() === "Lead,Bass", { what: "Hauptversion" });
});

test("checkpoint and variant from a row; both are saved in the file and come back after a restart", async () => {
  await fresh();
  await someSteps();
  await app.clickOn(".hist-checkpoint");
  await app.waitFor(() => T.$(".hist-row.current .hist-flag")?.textContent.trim() === "Checkpoint 1", { what: "Checkpoint" });
  // variant from row 2 via the dialog
  await app.eval(() => T.$(".hist-row:nth-child(2) .hist-branch-here").click());
  await app.waitFor(() => !!T.$(".modal .hist-name"), { what: "Dialog" });
  await app.eval(() => (T.$(".modal .hist-name").value = "Ohne Melodie"));
  await app.clickOn(".modal .btn.primary");
  await app.waitFor(() => T.$$(".hist-var").length === 2, { what: "Variante" });
  await app.eval(() => T.st.run({ type: "setTrack", trackId: T.st.snapshot.peek().project.tracks[0].id, patch: { gainDb: -6 } }));
  await app.waitFor(() => T.$$(".hist-row").length === 3, { what: "Schritt in der Variante" });
  assert.equal((await labels())[2], "Lautstärke ändern");
  const file = join(app.tmp, "historie.klangwelt");
  await invoke("project_save", { path: file });
  assert.ok(existsSync(file));
  const before = await rows();
  // a fresh app (same folder) opens the file with its history
  const tmp = app.tmp;
  await app.stop();
  app = await startApp({ tmp });
  await invoke("project_open", { path: file });
  await app.eval(() => T.st.showPanel("historie"));
  await app.waitFor(() => T.$$(".hist-var").length === 2, { what: "Varianten nach dem Neustart" });
  assert.deepEqual(await variants(), [{ name: "Hauptversion", on: false }, { name: "Ohne Melodie", on: true }]);
  assert.deepEqual((await rows()).map((r) => r.cells.slice(2)), before.map((r) => r.cells.slice(2)));
  await app.clickOn(".hist-var", { text: "Hauptversion" });
  await app.waitFor(() => T.$(".hist-row.current .hist-flag")?.textContent.trim() === "Checkpoint 1", { what: "Checkpoint nach dem Neustart" });
  await app.key("z", { mods: MOD.ctrl });
  await app.waitFor(() => T.st.snapshot.peek().project.tempoBpm === 120, { what: "Rückgängig nach dem Neustart" });
  assert.deepEqual(app.errors, []);
});

test("the history comes back after a restart even after view changes and the first save naming the project", async () => {
  await fresh();
  await someSteps();
  // no undo steps: compact view and a row height (the history used to be refused after these)
  await app.eval(async () => {
    const id = T.st.snapshot.peek().project.tracks[0].id;
    await T.st.run({ type: "setTrack", trackId: id, patch: { view: "compact" } });
    await T.st.run({ type: "setTrack", trackId: id, patch: { compactHeight: 110 } });
  });
  await app.clickOn(".hist-checkpoint");
  const file = join(app.tmp, "Ansicht.klangwelt");
  await invoke("project_save", { path: file });
  // after saving, a checkpoint alone is an unsaved change
  await app.eval(() => window.__TAURI__.core.invoke("history_checkpoint", { name: "Nach dem Speichern" }));
  assert.equal(await app.eval(async () => (await window.__TAURI__.core.invoke("get_state")).dirty), true, "the checkpoint is unsaved");
  await invoke("project_save", { path: file });
  const before = await rows();
  const tmp = app.tmp;
  await app.stop();
  app = await startApp({ tmp });
  await invoke("project_open", { path: file });
  await app.eval(() => T.st.showPanel("historie"));
  await app.waitFor(() => T.$$(".hist-row .hist-flag").length === 2, { what: "both checkpoints after the restart" });
  assert.deepEqual(await app.eval(() => T.$$(".hist-row .hist-flag").map((f) => f.textContent.trim())), ["Checkpoint 1", "Nach dem Speichern"]);
  // (the step column without the flags: the window didn't show the second one before)
  assert.deepEqual((await rows()).map((r) => r.cells.slice(3)), before.map((r) => r.cells.slice(3)));
  assert.equal(await app.eval(() => T.st.snapshot.peek().project.name), "Ansicht", "named after its file");
  assert.equal(await app.eval(() => T.st.snapshot.peek().dirty), false);
  assert.deepEqual(app.errors, []);
});

test("combine variants: changed bars per track, a conflict to decide, listen, a new variant", async () => {
  await fresh();
  // lead with one note per bar and a checkpoint; the main version changes bars 5–6,
  // the variant "Refrain" bars 6–8 and adds a pad
  await app.eval(async () => {
    const call = (c, a) => window.__TAURI__.core.invoke(c, a);
    const notes = (pitches) => pitches.map((p, i) => ({ pitch: p, startBeats: i * 4, lengthBeats: 1, velocity: 90 }));
    await T.st.run({ type: "addTrack", track: { id: 0, name: "Lead", kind: "instrument" } });
    const t = T.st.snapshot.peek().project.tracks[0];
    await T.st.run({ type: "addClip", trackId: t.id, clip: { id: 0, name: "Thema", startBeats: 0, source: { type: "notes", lengthBeats: 32, notes: notes([60, 60, 60, 60, 60, 60, 60, 60]) } } });
    const base = (await call("history_checkpoint", { name: "Rohfassung" })).current;
    const clip = () => T.st.snapshot.peek().project.tracks[0].clips[0].id;
    await T.st.run({ type: "setClipNotes", trackId: t.id, clipId: clip(), notes: notes([60, 60, 60, 60, 62, 62, 60, 60]) });
    await T.st.act(call("history_variant_new", { name: "Refrain", node: base }));
    await T.st.run({ type: "setClipNotes", trackId: t.id, clipId: clip(), notes: notes([60, 60, 60, 60, 60, 67, 67, 67]) });
    await T.st.run({ type: "addTrack", track: { id: 0, name: "Pad", kind: "instrument", clips: [{ id: 0, name: "P", startBeats: 16, source: { type: "notes", lengthBeats: 16, notes: [{ pitch: 48, startBeats: 0, lengthBeats: 8, velocity: 80 }] } }] } });
  });
  await app.waitFor(() => T.$$(".hist-var").length === 2 && !T.$(".hist-combine").disabled, { what: "zwei Varianten" });
  await app.clickOn(".hist-combine");
  await app.waitFor(() => T.$$(".mg-row[data-track]").length === 2, { what: "Kombinieren" });
  const cellTexts = () => app.eval(() => T.$$(".mg-row[data-track] .mg-cell .mg-cell-text").map((c) => c.textContent));
  assert.deepEqual(await cellTexts(), ["Hauptversion", "Entscheiden", "Refrain", "Refrain"]);
  assert.equal(await app.eval(() => T.$(".mg-apply").disabled), true, "the conflict is open");
  // decide it in the menu of the field
  await app.clickOn('.mg-row[data-track="1"] .mg-cell[data-start="20"]');
  await app.waitFor(() => !!T.$(".mg-pop"), { what: "Auswahl" });
  await app.clickOn(".mg-pop .mg-opt", { text: "Hauptversion" });
  assert.deepEqual(await cellTexts(), ["Hauptversion", "Hauptversion", "Refrain", "Refrain"]);
  assert.equal(await app.eval(() => T.$(".mg-apply").disabled), false);
  // listen (muted test instance): plays and stops again
  await app.clickOn(".mg-play");
  await app.waitFor(() => T.st.status.peek().playing, { what: "Probehören" });
  await app.clickOn(".mg-play");
  await app.waitFor(() => !T.st.status.peek().playing, { what: "Stopp" });
  await app.shot("historie-kombinieren-desktop");
  await app.clickOn(".mg-apply");
  await app.waitFor(() => T.$$(".hist-var").length === 3 && !!T.$(".hist-table"), { what: "neue Variante" });
  assert.deepEqual(await variants(), [{ name: "Hauptversion", on: false }, { name: "Refrain", on: false }, { name: "Refrain + Hauptversion", on: true }]);
  assert.equal((await labels()).at(-1), "Kombiniert: Hauptversion");
  const p = await app.eval(() => T.st.snapshot.peek().project);
  assert.deepEqual(p.tracks.map((t) => t.name), ["Lead", "Pad"]);
  assert.deepEqual(p.tracks[0].clips[0].source.notes.map((n) => n.pitch), [60, 60, 60, 60, 62, 62, 67, 67]);
  // one undo step back to the refrain's state
  await app.key("z", { mods: MOD.ctrl });
  await app.waitFor(() => T.st.snapshot.peek().project.tracks[0].clips[0].source.notes[4].pitch === 60, { what: "Rückgängig" });
  assert.deepEqual(app.errors, []);
});

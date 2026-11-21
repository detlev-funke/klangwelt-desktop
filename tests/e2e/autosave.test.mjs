// Autosave and switching the language without losing the project
// (klangwelt/ui/src/autosave.ts, klangwelt/crates/klang-app/src/autosave.rs) in the
// desktop app: the core keeps running through the WebView's reload, projects with a
// file are saved into it, projects without one into a recovery copy next to the
// settings (in the test's own folder). Intervals are set in seconds through the module,
// so nothing waits for minutes; the harness switches autosave off for every other test.
import { after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync, statSync } from "node:fs";
import { startApp, makeTest, injectHelpers, sleep } from "./harness.mjs";

let app;
const test = makeTest(() => app);
after(async () => {
  await app?.close();
});

const invoke = (cmd, args) => app.eval((c, a) => T.st.act(window.__TAURI__.core.invoke(c, a)), cmd, args);
/** File, "unsaved", undo and track names of the open project. */
const state = () =>
  app.eval(() => {
    const s = T.st.snapshot.peek();
    return { file: s.file, dirty: s.dirty, canUndo: s.canUndo, tracks: s.project.tracks.map((t) => t.name) };
  });
const addTrack = (name) => app.eval((n) => T.st.run({ type: "addTrack", track: { id: 0, name: n, kind: "instrument" } }), name);
const setAutosave = (s) => app.eval(async (s) => (await import("./autosave.js")).setAutosaveSeconds(s), s);
const recovery = () => join(app.tmp, "bibliothek", "Wiederherstellung.klangwelt");
const mtime = (f) => statSync(f).mtimeMs;

/** The tracks in a project file – opened, then the project from before is opened again. */
const tracksInFile = (file) =>
  app.eval(async (f) => {
    const back = T.st.snapshot.peek().file;
    const opened = await window.__TAURI__.core.invoke("project_open", { path: f });
    const names = opened.project.tracks.map((t) => t.name);
    if (back) await T.st.act(window.__TAURI__.core.invoke("project_open", { path: back }));
    return names;
  }, file);

async function chooseLanguage(code) {
  await app.clickOn('[data-help="einstellungen"]');
  await app.clickOn(".set-menu.open .lang-entry");
  await app.waitFor(() => T.$$(".set-menu.open [data-lang]").length === 7, { what: "language menu" });
  await app.clickOn(`.set-menu.open [data-lang="${code}"]`);
  // the UI reloads; the core keeps running
  await app.waitFor(() => !window.T, { timeout: 15000, what: "reload" });
  await injectHelpers(app);
}

test("switching the language keeps the open project – unsaved changes and undo included", async () => {
  app = await startApp();
  await addTrack("Skizze");
  assert.deepEqual(await state(), { file: null, dirty: true, canUndo: true, tracks: ["Skizze"] });
  await chooseLanguage("en");
  assert.equal(await app.eval(async () => (await import("./i18n.js")).language()), "en");
  assert.deepEqual(await state(), { file: null, dirty: true, canUndo: true, tracks: ["Skizze"] });
  assert.equal(await app.eval(() => T.$(".proj-name").textContent), "New project •");
  assert.equal(await app.eval(() => sessionStorage.getItem("klangwelt.resume")), null, "the note for the reload is used up");
  // no "restored" notice: it's the same project, not one from a crash
  assert.doesNotMatch(await app.eval(() => T.st.message.peek()?.text ?? ""), /restored/i);
  assert.deepEqual(app.errors, []);
});

test("switching the language with autosave on saves a project with a file into it first", async () => {
  await setAutosave(600);
  await invoke("project_new");
  await addTrack("Datei");
  const file = join(app.tmp, "Sprache.klangwelt");
  await invoke("project_save", { path: file });
  await addTrack("Ungespeichert");
  await chooseLanguage("de");
  assert.deepEqual(await state(), { file, dirty: false, canUndo: true, tracks: ["Datei", "Ungespeichert"] });
  assert.deepEqual(await tracksInFile(file), ["Datei", "Ungespeichert"]);
  assert.deepEqual(app.errors, []);
});

test("the settings menu sets the interval; a project with a file is saved in the background only when it changed", async () => {
  await app.clickOn('[data-help="einstellungen"]');
  await app.waitFor(() => T.$$(".set-menu.open [data-autosave]").length === 5, { what: "autosave choices" });
  assert.deepEqual(await app.eval(() => T.$$(".set-menu.open [data-autosave]").map((b) => b.textContent)), ["Aus", "1 Min.", "2 Min.", "5 Min.", "10 Min."]);
  await app.clickOn('.set-menu.open [data-autosave="120"]');
  assert.equal(await app.eval(() => localStorage.getItem("klangwelt.autosave")), "120");

  await setAutosave(1);
  await invoke("project_new");
  await addTrack("Eins");
  const file = join(app.tmp, "Hintergrund.klangwelt");
  await invoke("project_save", { path: file });
  const saved = mtime(file);
  await sleep(2500);
  assert.equal(mtime(file), saved, "unchanged: not written again");
  await addTrack("Zwei");
  await app.waitFor(() => !T.st.snapshot.peek().dirty, { timeout: 6000, what: "saved by the autosave" });
  assert.ok(mtime(file) > saved, "the file was written");
  assert.equal(await app.eval(() => T.$(".proj-name").textContent), "Hintergrund");
  assert.deepEqual(await tracksInFile(file), ["Eins", "Zwei"]);
  assert.ok(!existsSync(`${file}.teil`) && !existsSync(file.replace(/klangwelt$/, "klangwelt.teil")), "no temporary file left");
  assert.equal(existsSync(recovery()), false, "no recovery copy for a project with a file");

  // off: nothing in the background
  await setAutosave(0);
  await addTrack("Drei");
  const before = mtime(file);
  await sleep(2500);
  assert.equal((await state()).dirty, true);
  assert.equal(mtime(file), before);
  assert.deepEqual(app.errors, []);
});

test("closing with autosave on: a project with a file is saved without asking", async () => {
  await setAutosave(600);
  await invoke("project_new");
  await addTrack("Vorher");
  const file = join(app.tmp, "Schließen.klangwelt");
  await invoke("project_save", { path: file });
  await addTrack("Nachher");
  // close the window – the real quit is intercepted
  await app.eval(async () => {
    const { backend } = await import("./bridge.js");
    window.__closeCalls = 0;
    backend.appClose = async () => {
      window.__closeCalls++;
    };
    await window.__TAURI__.event.emit("close-requested", { dirty: true, busy: null });
  });
  await app.waitFor(() => window.__closeCalls === 1, { what: "closes without a question" });
  assert.equal(await app.eval(() => !!T.$(".modal-back")), false, "no dialog");
  assert.equal((await state()).dirty, false);
  assert.deepEqual(await tracksInFile(file), ["Vorher", "Nachher"]);
  assert.deepEqual(app.errors, []);
});

test("a project without a name goes into a recovery copy and comes back after a crash; closing on purpose removes it", async () => {
  await setAutosave(1);
  await invoke("project_new");
  await addTrack("Absturz");
  const deadline = Date.now() + 8000;
  while (!existsSync(recovery()) && Date.now() < deadline) await sleep(100);
  assert.ok(existsSync(recovery()), `recovery copy at ${recovery()}`);
  assert.deepEqual(await state(), { file: null, dirty: true, canUndo: true, tracks: ["Absturz"] }, "still unsaved");
  // killed like a crash, started again with the same folder
  await app.stop();
  app = await startApp({ tmp: app.tmp });
  await app.waitFor(() => T.st.snapshot.peek().project.tracks.length, { what: "project back" });
  const back = await state();
  assert.deepEqual({ ...back, canUndo: undefined }, { file: null, dirty: true, canUndo: undefined, tracks: ["Absturz"] });
  assert.match(await app.eval(() => T.st.message.peek()?.text ?? ""), /ungespeicherte Projekt der letzten Sitzung wurde wiederhergestellt/);
  // closing on purpose ("Don't save" ends in app_close): no copy for the next start
  assert.ok(existsSync(recovery()));
  const exited = new Promise((r) => app.child.once("exit", r));
  await app.eval(() => void window.__TAURI__.core.invoke("app_close"));
  await exited;
  assert.equal(existsSync(recovery()), false, "removed on close");
  app = await startApp({ tmp: app.tmp });
  assert.deepEqual(await state(), { file: null, dirty: false, canUndo: false, tracks: [] }, "a fresh start");
  assert.deepEqual(app.errors, []);
});

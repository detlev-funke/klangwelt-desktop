// Audiodateien per Drag & Drop als Spuren einfügen (Stelle unter der Maus,
// in eine Audiospur oder als neue Spuren), Formate prüfen und sauber melden,
// Aufnahmen in eine Melodie- oder Rhythmus-Spur umwandeln (Knopf am Clip,
// Knopf im Spurkopf der Tonhöhen-Ansicht, Kontextmenü, Agent).
//
// Das Ablegen selbst meldet Tauri als Ereignis „tauri://drag-drop“ (Pfade und
// Stelle in physischen Pixeln); der Test löst dasselbe Ereignis aus.
import { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startApp, makeTest, noteGeo } from "./harness.mjs";
import { drums, sing, writeWav } from "./audiofiles.mjs";

let app;
const test = makeTest(() => app);
const files = {};
before(async () => {
  app = await startApp();
  const sr = 22_050;
  files.melody = join(app.tmp, "Melodie gesungen.wav");
  // c' e' g' c'' – je 0,5 s (bei 120 BPM je ein Schlag), 24 Bit Stereo (rechts leiser)
  const m = sing([[60, 0.5], [64, 0.5], [67, 0.5], [72, 0.5]], sr);
  writeWav(files.melody, [m, m.map((v) => v * 0.5)], sr, 24);
  files.beat = join(app.tmp, "Beat.wav");
  // zwei Takte: Bassdrum auf 1 und 3, Snare auf 2 und 4, Hi-Hat auf den Achteln dazwischen
  const pattern = { kick: [0, 8, 16, 24], snare: [4, 12, 20, 28], hat: [2, 6, 10, 14, 18, 22, 26, 30] };
  writeWav(files.beat, [drums(pattern, 32, 120, 44_100)], 44_100);
  files.short = join(app.tmp, "kurz.wav");
  writeWav(files.short, [Array.from({ length: 8000 }, (_, i) => 0.3 * Math.sin(i / 5))], 8000);
  files.mp3 = join(app.tmp, "Lied.mp3");
  writeFileSync(files.mp3, Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(400)]));
  files.text = join(app.tmp, "notiz.txt");
  writeFileSync(files.text, "keine Musik");
});
after(async () => {
  await app?.close();
});

beforeEach(async () => {
  await app.reset();
  await app.eval(() => {
    T.st.viewport.value = { pxPerBeat: 60, scrollX: 0, scrollY: 0 };
    T.st.showPanel("spuren");
  });
});

const project = () => app.eval(() => T.st.snapshot.peek().project);
const message = () => app.eval(() => T.st.message.peek()?.text ?? "");
const undoLabel = () => app.eval(() => T.st.snapshot.peek().undoLabel);
const undo = () => app.eval(() => T.st.act(window.__TAURI__.core.invoke("undo")));

/** Stelle über der Zeitleiste: Schlag und y (Fensterpixel). */
async function timelineAt(beat, y) {
  return app.eval((beat, y) => {
    const c = T.$("kw-timeline canvas").getBoundingClientRect();
    const v = T.st.viewport.peek();
    return { x: c.x + beat * v.pxPerBeat - v.scrollX, y: y ?? c.y + c.height - 40 };
  }, beat, y);
}

/** Ziehen und Ablegen wie Tauri: Ereignisse hereinziehen, darüber, ablegen. */
async function drop(paths, at, { during } = {}) {
  await app.eval((paths, at) => window.__TAURI__.event.emit("tauri://drag-enter", { paths, position: at }), paths, at);
  await app.eval((at) => window.__TAURI__.event.emit("tauri://drag-over", { position: at }), at);
  await app.eval(() => T.sleep(250));
  const seen = during ? await during() : undefined;
  await app.eval((paths, at) => window.__TAURI__.event.emit("tauri://drag-drop", { paths, position: at }), paths, at);
  return seen;
}

async function waitTracks(n) {
  await app.waitFor((n) => T.st.snapshot.peek().project.tracks.length === n, { what: `${n} Spuren`, timeout: 15000 }, n);
}

/** Audio einfügen ohne Ziehen (für die Umwandel-Tests). */
async function importFile(path, startBeats = 0) {
  const r = await app.eval((p, s) => window.__TAURI__.core.invoke("audio_import", { paths: [p], trackId: null, startBeats: s }), path, startBeats);
  await app.eval((s) => (T.st.snapshot.value = s), r.snapshot);
  await app.eval(() => T.sleep(200));
  return r.imported[0];
}

// ------------------------------------------------------------------ Einfügen

test("Audiodatei auf die leere Zeitleiste ziehen: neue Audiospur mit Clip ab der Mausposition, Anzeige beim Ziehen", async () => {
  const at = await timelineAt(4.1);
  const info = await drop([files.melody], at, { during: () => app.eval(() => T.$("kw-timeline").dataset.dropInfo ?? null) });
  assert.equal(info, "Audiodatei → Takt 2.1.1 · neue Spur");
  await waitTracks(1);
  const p = await project();
  const t = p.tracks[0];
  assert.equal(t.kind, "audio");
  assert.equal(t.name, "Melodie gesungen");
  assert.equal(t.clips.length, 1);
  const c = t.clips[0];
  assert.equal(c.startBeats, 4, "rastet auf den Schlag ein");
  assert.equal(c.source.type, "audio");
  assert.equal(c.source.warp, false, "Originaltempo");
  assert.ok(Math.abs(c.source.durationSecs - 2.16) < 0.01, `Dauer ${c.source.durationSecs}`);
  assert.match(await message(), /„Melodie gesungen“ eingefügt \(WAV 24 Bit, 2,2 s, zu mono gemittelt\)/);
  assert.equal(await undoLabel(), "Audio einfügen: Melodie gesungen");
  assert.equal(await app.eval(() => T.$("kw-timeline").dataset.dropInfo ?? null), null, "Anzeige weg");
  assert.deepEqual(await app.eval(() => T.st.selection.peek()), { trackId: t.id, clipId: c.id });
  await undo();
  assert.equal((await project()).tracks.length, 0, "ein Rückgängig-Schritt");
});

test("Auf eine Audiospur gezogen: Clip kommt in diese Spur; mehrere Dateien: je eine eigene Spur darunter", async () => {
  await importFile(files.short, 0);
  const id = (await project()).tracks[0].id;
  const g = await noteGeo(app, id);
  const at = await timelineAt(8, g.rowY + 40);
  const info = await drop([files.melody], at, { during: () => app.eval(() => T.$("kw-timeline").dataset.dropInfo ?? null) });
  assert.equal(info, "Audiodatei → Takt 3.1.1 · in „kurz“");
  await app.waitFor((id) => T.st.snapshot.peek().project.tracks.find((t) => t.id === id).clips.length === 2, { what: "zweiter Clip" }, id);
  assert.equal((await project()).tracks.length, 1, "keine neue Spur");
  // zwei Dateien auf dieselbe Spur: die erste hinein, die zweite als neue Spur direkt darunter
  await drop([files.short, files.beat], await timelineAt(12, g.rowY + 40));
  await waitTracks(2);
  const p = await project();
  assert.deepEqual(p.tracks.map((t) => [t.name, t.clips.length]), [["kurz", 3], ["Beat", 1]]);
  assert.equal(p.tracks[1].clips[0].startBeats, 12);
  assert.equal(await undoLabel(), "2 Audiodateien einfügen");
});

test("Auf einen Spurkopf gezogen: in diese Spur ab Anfang; über die Instrumentspur: neue Spur darunter", async () => {
  await app.eval(() => T.st.run({ type: "addTrack", track: { id: 0, name: "Klavier", kind: "instrument" } }));
  await importFile(files.short, 0);
  await app.eval(() => T.sleep(200));
  const head = await app.eval(() => {
    const rows = T.$$("kw-tracks .track-row");
    return rows.map((r) => { const b = r.getBoundingClientRect(); return { x: b.x + 30, y: b.y + b.height / 2, id: Number(r.dataset.trackId) }; });
  });
  assert.equal(head.length, 2);
  // auf den Kopf der Audiospur
  await drop([files.melody], { x: head[1].x, y: head[1].y });
  await app.waitFor((id) => T.st.snapshot.peek().project.tracks.find((t) => t.id === id).clips.length === 2, { what: "Clip in der Audiospur" }, head[1].id);
  const c = (await project()).tracks[1].clips.find((c) => c.name === "Melodie gesungen");
  assert.equal(c.startBeats, 0);
  // auf den Kopf der Instrumentspur → neue Audiospur direkt darunter
  await drop([files.beat], { x: head[0].x, y: head[0].y });
  await waitTracks(3);
  assert.deepEqual((await project()).tracks.map((t) => t.name), ["Klavier", "Beat", "kurz"]);
});

test("MP3 und andere Dateien werden sauber gemeldet; mit offener Bibliothek wird Audio trotzdem eingefügt", async () => {
  await drop([files.mp3], await timelineAt(0));
  await app.waitFor(() => /MP3 kann Klangwelt noch nicht lesen/.test(T.st.message.peek()?.text ?? ""), { what: "Meldung zu MP3" });
  assert.match(await message(), /„Lied\.mp3“: MP3 kann Klangwelt noch nicht lesen – unterstützt sind WAV, AIFF, FLAC und Opus/);
  assert.equal(await app.eval(() => T.st.message.peek().kind), "error");
  assert.equal((await project()).tracks.length, 0);
  await drop([files.text], await timelineAt(0));
  await app.waitFor(() => /kann Klangwelt nicht einfügen/.test(T.st.message.peek()?.text ?? ""), { what: "Meldung zu Textdatei" });
  // gemischt: lesbare Datei kommt, die andere wird genannt
  await drop([files.short, files.mp3], await timelineAt(0));
  await waitTracks(1);
  await app.waitFor(() => /nicht gelesen: „Lied\.mp3“: MP3/.test(T.st.message.peek()?.text ?? ""), { what: "Teil-Meldung" });
  // Bibliothek offen (eigenes Fenster neben den Spuren): Audio geht trotzdem in die Zeitleiste, kein Bibliotheksfehler
  await app.eval(() => T.st.showPanel("bibliothek"));
  await app.eval(() => T.sleep(300));
  await app.eval(() => T.st.showPanel("spuren"));
  await drop([files.melody], await timelineAt(0));
  await waitTracks(2);
  assert.doesNotMatch(await message(), /MusicXML/);
});

// ------------------------------------------------------------------ Umwandeln

test("Knopf „♪ → Noten“ am Audio-Clip: Melodie-Spur direkt darunter mit den gesungenen Tönen", async () => {
  await app.eval(() => T.st.run({ type: "addTrack", track: { id: 0, name: "Oben", kind: "instrument" } }));
  const imp = await importFile(files.melody, 4);
  await app.eval(() => T.st.run({ type: "addTrack", track: { id: 0, name: "Unten", kind: "instrument" } }));
  await app.eval(() => T.sleep(250));
  const btn = await app.waitFor((id) => T.$("kw-timeline").noteButtonRect(id), { what: "Knopf am Clip" }, imp.clipId);
  await app.click(btn.x + btn.w / 2, btn.y + btn.h / 2);
  await app.waitFor(() => T.st.snapshot.peek().project.tracks.length === 4, { what: "Melodie-Spur", timeout: 20000 });
  const p = await project();
  assert.deepEqual(p.tracks.map((t) => t.name), ["Oben", "Melodie gesungen", "Melodie aus Melodie gesungen", "Unten"], "direkt unter der Audiospur");
  const mel = p.tracks[2];
  assert.equal(mel.kind, "instrument");
  assert.equal(mel.clips[0].startBeats, 4, "an der Stelle des Audio-Clips");
  assert.equal(mel.clips[0].source.lengthBeats, 8, "ganze Takte");
  assert.deepEqual(mel.clips[0].source.notes.map((n) => n.pitch), [60, 64, 67, 72]);
  assert.equal(await undoLabel(), "In Melodie-Spur umwandeln");
  assert.match(await message(), /„Melodie aus Melodie gesungen“ angelegt: 4 Noten/);
  await undo();
  assert.equal((await project()).tracks.length, 3);
});

test("Tonhöhen-Ansicht: Knopf „Noten“ im Spurkopf wandelt alle Audio-Clips der Spur um", async () => {
  const imp = await importFile(files.melody, 0);
  // zweiter Clip derselben Aufnahme weiter hinten in derselben Spur
  await app.eval((p, tid) => window.__TAURI__.core.invoke("audio_import", { paths: [p], trackId: tid, startBeats: 8 }).then((r) => (T.st.snapshot.value = r.snapshot)), files.melody, imp.trackId);
  // sichtbar = belegt Platz (nicht nur das hidden-Attribut prüfen)
  const shown = (sel = ".toggle.convert") => app.eval((sel) => T.$$(`.track-row ${sel}`).map((b) => b.getBoundingClientRect().width > 0), sel);
  assert.deepEqual(await shown(), [false], "kompakt: kein Knopf");
  assert.deepEqual(await shown(".toggle.v.x"), [false], "Audiospur: kein Knopf für die Ausdrucksspur");
  await app.eval((id) => T.st.run({ type: "setTrack", trackId: id, patch: { view: "notes" } }), imp.trackId);
  await app.waitFor(() => T.$(".track-row .toggle.convert").getBoundingClientRect().width > 0, { what: "Knopf im Spurkopf" });
  await app.clickOn(".track-row .toggle.convert");
  await app.waitFor(() => T.st.snapshot.peek().project.tracks.length === 2, { what: "Melodie-Spur", timeout: 20000 });
  assert.deepEqual(await shown(), [true, false], "die neue Instrumentspur hat keinen Umwandeln-Knopf");
  // Ausdrucksspur-Knopf nur bei der Instrumentspur in der Notenansicht
  assert.deepEqual(await shown(".toggle.v.x"), [false, true]);
  const mel = (await project()).tracks[1];
  assert.equal(mel.name, "Melodie aus Melodie gesungen");
  assert.deepEqual(mel.clips.map((c) => c.startBeats), [0, 8], "ein Clip je Audio-Clip");
  // im Notenband der Tonhöhen-Ansicht trägt der Clip den Knopf ebenfalls
  assert.ok(await app.eval((id) => !!T.$("kw-timeline").noteButtonRect(id), imp.clipId));
});

test("Kontextmenü am Audio-Clip: In Rhythmus-Spur umwandeln – Bassdrum, Snare und Hi-Hat an ihren Stellen", async () => {
  const imp = await importFile(files.beat, 0);
  const g = await noteGeo(app, imp.trackId);
  await app.click(g.cx + 1.3 * g.ppb - g.scrollX, g.rowY + 50, { button: "right" });
  await app.waitFor(() => T.$(".ctx-menu .menu-title")?.textContent === "Beat", { what: "Menü des Audio-Clips" });
  assert.deepEqual(await app.eval(() => T.$$(".ctx-menu .menu-item b").map((b) => b.textContent)),
    ["In Melodie-Spur umwandeln", "In Rhythmus-Spur umwandeln", "Analyse zeigen", "Tempo erkennen", "Clip löschen"]);
  await app.clickOn(".ctx-menu [data-act=rhythmus]");
  await app.waitFor(() => T.st.snapshot.peek().project.tracks.length === 2, { what: "Rhythmus-Spur", timeout: 20000 });
  const t = (await project()).tracks[1];
  assert.equal(t.name, "Rhythmus aus Beat");
  assert.equal(t.instrument.kind, "drums");
  const notes = t.clips[0].source.notes;
  const steps = (pitch) => notes.filter((n) => n.pitch === pitch).map((n) => Math.round(n.startBeats * 4));
  assert.deepEqual(steps(36), [0, 8, 16, 24], `Bassdrum: ${JSON.stringify(notes)}`);
  assert.deepEqual(steps(38), [4, 12, 20, 28], "Snare");
  assert.deepEqual(steps(42), [2, 6, 10, 14, 18, 22, 26, 30], "Hi-Hat");
  assert.equal(t.clips[0].source.lengthBeats, 12, "auf ganze Takte (4,5 s = 9 Schläge → 3 Takte)");
  assert.equal(await undoLabel(), "In Rhythmus-Spur umwandeln");
});

test("Clip-Fenster eines Audio-Clips: „Rhythmus → Schlagzeug“", async () => {
  const imp = await importFile(files.beat, 0);
  await app.eval((sel) => {
    T.st.selection.value = sel;
    T.st.showPanel("clip");
  }, { trackId: imp.trackId, clipId: imp.clipId });
  await app.waitFor(() => T.$$("kw-panel[tab=clip] .btn").some((b) => b.textContent.includes("Rhythmus → Schlagzeug")), { what: "Knopf im Clip-Fenster" });
  await app.clickOn("kw-panel[tab=clip] .btn", { text: "Rhythmus → Schlagzeug" });
  await app.waitFor(() => T.st.snapshot.peek().project.tracks.length === 2, { what: "Rhythmus-Spur", timeout: 20000 });
  assert.equal((await project()).tracks[1].instrument.kind, "drums");
  await app.eval(() => T.st.showPanel("spuren"));
});

test("Agent: import_audio und audio_to_notes", async () => {
  const r = await app.mcp("import_audio", { paths: [files.beat, files.mp3], startBeats: 4 });
  assert.equal(r.eingefuegt.length, 1);
  assert.equal(r.eingefuegt[0].format, "WAV 16 Bit");
  assert.match(r.fehler[0], /MP3/);
  await app.waitFor(() => T.st.snapshot.peek().project.tracks.length === 1, { what: "Spur in der Oberfläche" });
  const c = await app.mcp("audio_to_notes", { trackId: r.eingefuegt[0].trackId, target: "rhythmus" });
  assert.ok(c.noten >= 16, `Noten: ${c.noten}`);
  await app.waitFor(() => T.st.snapshot.peek().project.tracks.length === 2, { what: "Rhythmus-Spur" });
  assert.equal((await project()).tracks[1].clips[0].startBeats, 4);
});

test("keine Fehler im Fenster", () => {
  assert.deepEqual(app.errors, []);
});

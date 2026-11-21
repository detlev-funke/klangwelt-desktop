// The agent's library tools on the desktop: a score is addressed by its doc,
// not by a file path – the same tools as in the browser (klang_app::agent).
// Two movements of a test sextet lie in the library folder as own scores
// ("Eigene/Einzelsaetze", like a piece kept as single movements); the agent
// finds them (search_library), reads voices, bars and notes
// (read_library_score), takes all voices over as tracks and puts the second
// movement after the first on the same tracks (import_library_score) – each
// one undo step.
import { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startApp, makeTest } from "./harness.mjs";
import { SEXTET, SEXTET_PARTS, expectedExcerpt, scoreXml } from "../../klangwelt/tests/library-scores.mjs";

let app;
const test = makeTest(() => app);
before(async () => {
  app = await startApp();
});
after(async () => {
  await app?.close();
});

const idle = (what, timeout = 60000) =>
  app.waitFor(async () => {
    const i = await window.__TAURI__.core.invoke("library_info");
    return i.id && !i.loading && !i.adding && !i.building && i.merging == null && !i.download ? i : null;
  }, { timeout, what });
const tracks = () => app.eval(() => T.st.snapshot.peek().project.tracks.map((t) => ({ id: t.id, name: t.name, clips: t.clips.map((c) => [c.startBeats, c.source.notes?.length ?? 0]) })));

test("own movements are added to the library", async () => {
  await idle("library loaded", 20000);
  const dir = join(app.tmp, "bibliothek", "Eigene", "Einzelsaetze");
  mkdirSync(dir, { recursive: true });
  for (const m of SEXTET) writeFileSync(join(dir, m.file), scoreXml(m));
  await app.mcp("add_to_library", { paths: [dir] });
  const info = await app.waitFor(async () => {
    const i = await window.__TAURI__.core.invoke("library_info");
    return i.scores === 2 && !i.adding && i.merging == null ? i : null;
  }, { timeout: 60000, what: "both movements in the library" });
  assert.equal(info.voices, 12);
});

let docs;
test("agent: search_library finds both movements by title words", async () => {
  const r = await app.mcp("search_library", { text: "testsextett satz" });
  assert.equal(r.hits.length, 2, JSON.stringify(r));
  assert.ok(r.hits.every((h) => h.composer === "Pjotr Test" && h.origin === undefined), JSON.stringify(r.hits));
  assert.deepEqual(r.hits.map((h) => h.file).sort(), SEXTET.map((m) => m.file).sort());
  docs = SEXTET.map((m) => r.hits.find((h) => h.title === m.title)?.doc);
  assert.ok(docs.every((d) => Number.isInteger(d)), JSON.stringify(r.hits));
  assert.equal((await app.mcp("search_library", { text: "Quintett" })).hits.length, 0);
});

test("agent: read_library_score lists voices and bars, and the notes of a bar range", async () => {
  const r = await app.mcp("read_library_score", { doc: docs[1] });
  assert.deepEqual(r.voices.map((v) => v.name), SEXTET_PARTS.map(([n]) => n));
  assert.deepEqual([r.bars, r.pickup, r.timeSignature, r.tempo], [3, false, "4/4", 60]);
  assert.equal(r.excerpt, undefined, "no notes without bars");
  const ex = await app.mcp("read_library_score", { doc: docs[0], fromBar: 4, voices: ["Violoncello 2", "viola 1"] });
  assert.deepEqual(ex.excerpt, { fromBar: 4, toBar: 4, startQuarter: 9, endQuarter: 12 });
  assert.equal(ex.voices[5].excerpt, expectedExcerpt(SEXTET[0], 5, 4, 4));
  assert.equal(ex.voices[2].excerpt, expectedExcerpt(SEXTET[0], 2, 4, 4));
  assert.equal(ex.voices[0].excerpt, undefined, "only the chosen voices");
  await assert.rejects(app.mcp("read_library_score", { doc: docs[0], fromBar: 9 }), /bars 1–4/);
  // analyze_score works with the doc as well as with the path
  assert.equal((await app.mcp("analyze_score", { doc: docs[0] })).titel, SEXTET[0].title);
});

test("agent: import_library_score takes all voices over as tracks – one undo step", async () => {
  await app.reset();
  const r = await app.mcp("import_library_score", { doc: docs[0] });
  assert.equal(r.tracks.length, 6, JSON.stringify(r));
  assert.deepEqual([r.startBeats, r.endBeats], [0, 12]);
  assert.equal(r.created.tracks.length, 6);
  const shown = await app.waitFor(() => {
    const ts = T.st.snapshot.peek().project.tracks;
    return ts.length === 6 ? ts.map((t) => t.name) : null;
  }, { what: "six tracks in the window" });
  assert.deepEqual(shown, SEXTET_PARTS.map(([n]) => `${SEXTET[0].title} – ${n}`));
  assert.equal(await app.eval(() => T.st.snapshot.peek().undoLabel), "6 Stimmen aus Bibliothek übernehmen");
});

test("agent: the second movement goes after the first on the same tracks; undo takes both back", async () => {
  const before = await tracks();
  const r = await app.mcp("import_library_score", { doc: docs[1], trackIds: before.map((t) => t.id), startBeats: 12 });
  assert.ok(r.tracks.every((t) => !t.newTrack), JSON.stringify(r));
  assert.equal(r.endBeats, 24);
  const after = await app.waitFor(() => {
    const ts = T.st.snapshot.peek().project.tracks;
    return ts.every((t) => t.clips.length === 2) ? ts.map((t) => t.clips.map((c) => [c.startBeats, c.source.notes.length])) : null;
  }, { what: "second clip on every track" });
  assert.equal(after.length, 6, "no new tracks");
  assert.ok(after.every((c) => JSON.stringify(c) === JSON.stringify([[0, 12], [12, 12]])), JSON.stringify(after));
  // a part of the second movement only, bars 2–3, on a new track
  const part = await app.mcp("import_library_score", { doc: docs[1], voices: ["Viola 2"], fromBar: 2, toBar: 3, startBeats: 24 });
  assert.equal(part.tracks[0].track, `${SEXTET[1].title} – Viola 2 (T. 2–3)`);
  assert.equal(part.tracks[0].notes, 8);
  await app.mcp("undo");
  await app.mcp("undo");
  assert.ok((await tracks()).every((t) => t.clips.length === 1));
  await app.mcp("undo");
  assert.equal((await tracks()).length, 0);
});

test("no errors in the window", () => {
  assert.deepEqual(app.errors, []);
});

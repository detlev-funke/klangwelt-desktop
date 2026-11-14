// Fuge: Thema wählen → Antwort, Verwandlungen, Gegensatz, Fugenplan anlegen, Kontrapunkt-Prüfer.
import { before, after } from "node:test";
import assert from "node:assert/strict";
import { startApp, makeTest } from "./harness.mjs";

let app;
const test = makeTest(() => app);
let subject;
before(async () => {
  app = await startApp();
  // Thema in C-Dur: C G E F D E C (Viertel, letzte halbe)
  subject = await app.eval(async () => {
    await T.st.run({ type: "addTrack", track: { id: 0, name: "Thema", kind: "instrument" } });
    const t = T.st.snapshot.peek().project.tracks.at(-1);
    const pitches = [60, 67, 64, 65, 62, 64, 60];
    const notes = pitches.map((p, i) => ({ pitch: p, startBeats: i, lengthBeats: i === 6 ? 2 : 1, velocity: 100 }));
    await T.st.run({ type: "addClip", trackId: t.id, clip: { id: 0, name: "Dux", startBeats: 0, source: { type: "notes", lengthBeats: 8, notes } } });
    const c = T.st.snapshot.peek().project.tracks.at(-1).clips[0];
    T.st.showPanel("fuge");
    await T.waitFor(() => T.$(".fg-subject"));
    return { trackId: t.id, clipId: c.id };
  });
});
after(async () => {
  await app?.close();
});

const titles = () => app.eval(() => T.$$(".fg-card .fg-title").map((t) => t.firstChild.textContent));

test("Themenliste enthält den Clip; Wählen zeigt Thema und Antwort", async () => {
  await app.waitFor((v) => T.$$(".fg-subject option").some((o) => o.value === v), { what: "Clip in der Liste" }, `${subject.trackId}:${subject.clipId}`);
  await app.eval((v) => {
    const s = T.$(".fg-subject");
    s.value = v;
    s.dispatchEvent(new Event("change"));
  }, `${subject.trackId}:${subject.clipId}`);
  await app.waitFor(() => T.$$(".fg-card .fg-title").some((t) => t.textContent.startsWith("Thema und Antwort")), { what: "Themenkarte" });
  const t = await titles();
  for (const want of ["Thema und Antwort", "Verwandlungen", "Gegensatz", "Engführungen", "Fugenplan"]) assert.ok(t.includes(want), `${want} fehlt: ${t}`);
  assert.match(await app.eval(() => T.$(".fg-legend").textContent), /Antwort \(Comes, (tonal|real)\)/);
});

test("„+ Antwort als Spur“ legt die Antwort hinter das Thema", async () => {
  await app.clickOn(".fg-card .btn.blue", { text: "Antwort als Spur" });
  const t = await app.waitFor(() => T.st.snapshot.peek().project.tracks.find((t) => t.name === "Antwort") ?? null, { what: "Spur Antwort" });
  assert.equal(t.clips[0].startBeats, 8, "nach dem Thema (2 Takte)");
  assert.equal(t.clips[0].source.notes.length, 7);
  // Antwort beginnt auf der Dominante (G)
  assert.equal(t.clips[0].source.notes[0].pitch % 12, 7);
});

test("Gegensatz-Vorschläge berechnen", async () => {
  await app.clickOn(".fg-card .btn.primary", { text: "Vorschläge berechnen" });
  await app.waitFor(() => T.$$(".fg-card").some((c) => c.textContent.includes("Neu berechnen")), { timeout: 20000, what: "Gegensätze" });
});

test("Fugenplan berechnen und als Spuren anlegen", async () => {
  const n0 = await app.eval(() => T.st.snapshot.peek().project.tracks.length);
  await app.clickOn(".fg-card .btn.primary", { text: "Plan berechnen" });
  await app.waitFor(() => T.$$(".fg-sec").length > 0, { timeout: 20000, what: "Abschnitte des Plans" });
  await app.clickOn(".fg-card .btn.blue", { text: "Fuge anlegen" });
  const names = await app.waitFor((n0) => {
    const ts = T.st.snapshot.peek().project.tracks;
    return ts.length > n0 ? ts.slice(n0).map((t) => t.name) : null;
  }, { what: "Fugenstimmen" }, n0);
  assert.equal(names.length, 3, JSON.stringify(names));
  assert.ok(names.every((n) => n.startsWith("Fuge – ")));
});

test("Kontrapunkt-Prüfer markiert Stellen in der Zeitleiste", async () => {
  await app.clickOn(".fg-card .btn.primary", { text: "Prüfen" });
  await app.waitFor(() => T.$$(".fg-card").some((c) => c.querySelector(".fg-title")?.textContent.startsWith("Kontrapunkt-Prüfer") && /Fehler|Warnung|Hinweis|keine/i.test(c.textContent)), { timeout: 15000, what: "Prüfergebnis" });
  const marks = await app.eval(() => T.st.counterpointMarks.peek().length);
  const issues = await app.eval(() => T.$$(".fg-issue").length);
  assert.equal(marks, issues, "jede Stelle als Markierung");
});

test("Agent: fugue_subject und check_counterpoint", async () => {
  const s = await app.mcp("fugue_subject", { trackId: subject.trackId, clipId: subject.clipId });
  assert.ok(JSON.stringify(s).includes("ntwort"), JSON.stringify(s).slice(0, 200));
  const c = await app.mcp("check_counterpoint", {});
  assert.ok(c && typeof c === "object");
});

test("keine Fehler im Fenster", () => {
  assert.deepEqual(app.errors, []);
});

// Song window: templates of whole pieces (trance, ambient …) and a
// mini editor – sections as columns, roles as rows, one level per cell
// (off / sparse / full). "Generate song" creates the tracks (one clip per
// section, drums in one track), generating again replaces them; one
// undo step. Plus "Start with a song ▾" in the empty project and the agent.
import { before, after } from "node:test";
import assert from "node:assert/strict";
import { startApp, makeTest } from "./harness.mjs";

let app;
const test = makeTest(() => app);
before(async () => {
  app = await startApp();
});
after(async () => {
  await app?.close();
});

const proj = () => app.eval(() => T.st.snapshot.peek().project);
async function openSong() {
  await app.eval(() => T.st.showPanel("song"));
  await app.waitFor(() => T.$$(".song-cell").length > 0, { what: "Song-Raster" });
}
const cell = (layer, section) => `.song-cell[data-layer="${layer}"][data-section="${section}"]`;
const level = (layer, section) => app.eval((s) => {
  const c = T.$(s);
  return c.classList.contains("l2") ? 2 : c.classList.contains("l1") ? 1 : 0;
}, cell(layer, section));
const summary = () => app.eval(() => T.$(".song-summary").textContent);
const undo = () => app.eval(() => T.st.act(window.__TAURI__.core.invoke("undo")));

test("templates and grid: sections as columns, roles as rows", async () => {
  await app.reset();
  await openSong();
  assert.deepEqual(await app.eval(() => T.$$(".song-tpl").map((b) => b.textContent)), ["Trance", "Ambient", "Deep House", "Synthwave", "Lo-Fi"]);
  await app.clickOn(".song-tpl", { text: "Trance" });
  assert.equal(await app.eval(() => T.$(".song-tpl.on").textContent), "Trance");
  assert.deepEqual(await app.eval(() => T.$$(".song-sec-name").map((i) => i.value)),
    ["Intro", "Thema", "Aufbau", "Break", "Steigerung", "Höhepunkt", "Höhepunkt 2", "Outro"]);
  assert.deepEqual(await app.eval(() => T.$$(".song-layer b").map((b) => b.textContent)),
    ["Fläche", "Arpeggio", "Bass", "Lead", "Kick", "Hi-Hats", "Clap", "Percussion", "Übergänge"]);
  assert.equal(await summary(), "8 Abschnitte · 120 Takte · 3:29 min");
  // first only pads, then it grows
  assert.equal(await level("pad", 0), 1);
  assert.equal(await level("kick", 0), 0);
  assert.equal(await level("kick", 1), 1);
  assert.equal(await level("kick", 5), 2);
  // columns as wide as their bars
  const w = await app.eval(() => T.$$(".song-sec").map((s) => Math.round(s.getBoundingClientRect().width)));
  assert.ok(w[4] < w[0], `Steigerung (8 T.) schmaler als Intro (16 T.): ${w}`);
});

test("edit cells, sections and properties – the plan stays remembered", async () => {
  await openSong();
  await app.clickOn(".song-tpl", { text: "Trance" });
  // off → sparse → full → off; Shift+click back
  await app.clickOn(cell("lead", 0));
  assert.equal(await level("lead", 0), 1);
  await app.clickOn(cell("lead", 0));
  assert.equal(await level("lead", 0), 2);
  await app.clickOn(cell("lead", 0), { mods: 8 });
  assert.equal(await level("lead", 0), 1);
  assert.match(await app.eval(() => T.$(".song-desc").textContent), /bearbeitet/);
  // duplicate section, move, remove; change bars
  await app.clickOn('.song-sec[data-index="4"] .song-sec-tools .btn[title="verdoppeln"]');
  assert.equal((await app.eval(() => T.$$(".song-sec-name").map((i) => i.value)))[5], "Steigerung 2");
  assert.equal(await summary(), "9 Abschnitte · 128 Takte · 3:43 min");
  await app.clickOn('.song-sec[data-index="5"] .song-sec-tools .btn[title="entfernen"]');
  await app.clickOn('.song-sec[data-index="1"] .song-sec-tools .btn[title="nach vorn"]');
  assert.deepEqual((await app.eval(() => T.$$(".song-sec-name").map((i) => i.value))).slice(0, 2), ["Thema", "Intro"]);
  await app.eval(() => {
    const s = T.$('.song-sec[data-index="0"] .song-sec-bars');
    s.value = "8";
    s.dispatchEvent(new Event("change"));
  });
  assert.equal(await summary(), "8 Abschnitte · 112 Takte · 3:15 min");
  // Tempo and chords
  await app.eval(() => {
    const t = T.$(".song-tempo");
    t.value = "140";
    t.dispatchEvent(new Event("change"));
    const c = T.$(".song-chords");
    c.value = "a, d - E";
    c.dispatchEvent(new Event("change"));
  });
  const saved = await app.eval(() => JSON.parse(localStorage.getItem("klangwelt.song.plan")));
  assert.equal(saved.tempo, 140);
  assert.deepEqual(saved.chords, ["a", "d", "E"]);
  assert.equal(saved.sections[0].name, "Thema");
  assert.equal(saved.sections[1].levels.lead, 1);
  // click the template again: back to the original
  await app.clickOn(".song-tpl", { text: "Trance" });
  assert.equal(await summary(), "8 Abschnitte · 120 Takte · 3:29 min");
  assert.doesNotMatch(await app.eval(() => T.$(".song-desc").textContent), /bearbeitet/);
});

test("generate song: tracks with clips per section, regenerating replaces, one undo step", async () => {
  await app.reset();
  await openSong();
  await app.clickOn(".song-tpl", { text: "Trance" });
  await app.clickOn(".song-write");
  await app.waitFor(() => T.st.snapshot.peek().project.tracks.length === 5, { what: "fünf Spuren", timeout: 20000 });
  let p = await proj();
  assert.equal(p.tempoBpm, 138);
  assert.deepEqual(p.tracks.map((t) => t.name), ["Fläche", "Arpeggio", "Bass", "Lead", "Beat"]);
  assert.ok(p.tracks.every((t) => t.view === "compact"), "flache Spuren für den Überblick");
  const pad = p.tracks[0];
  assert.equal(pad.instrument.kind, "synth");
  assert.equal(pad.clips.length, 7, "Fläche in 7 von 8 Abschnitten");
  assert.equal(pad.clips[0].name, "Intro");
  const beat = p.tracks[4];
  assert.equal(beat.instrument.kind, "drums");
  assert.equal(beat.clips[0].startBeats, 64, "Beat erst nach dem Intro");
  assert.ok(await app.eval(() => T.st.viewport.peek().pxPerBeat < 6), "Zeitleiste zeigt den ganzen Song");
  // lead already in the intro and generate again: replaces instead of doubling
  await app.clickOn(cell("lead", 0));
  await app.clickOn(".song-write");
  await app.waitFor(() => T.st.snapshot.peek().project.tracks.find((t) => t.name === "Lead")?.clips[0]?.name === "Intro", { what: "Lead im Intro", timeout: 20000 });
  p = await proj();
  assert.equal(p.tracks.length, 5, "ersetzt");
  assert.match(await app.eval(() => T.st.snapshot.peek().undoLabel), /Song „Trance“ neu erzeugen/);
  // one undo: the previous song; one more: empty
  await undo();
  await app.waitFor(() => T.st.snapshot.peek().project.tracks.find((t) => t.name === "Lead")?.clips[0]?.name === "Break", { what: "voriger Song" });
  await undo();
  await app.waitFor(() => T.st.snapshot.peek().project.tracks.length === 0, { what: "leer" });
});

test("empty project: “Start with a song ▾” creates the song and opens the song window", async () => {
  await app.reset();
  await app.eval(() => T.st.showPanel("clip"));
  await app.waitFor(() => T.$(".empty-hint .song-start")?.checkVisibility(), { what: "Knopf" });
  await app.clickOn(".empty-hint .song-start");
  await app.waitFor(() => T.$$(".song-menu .song-tpl-item").length === 5, { what: "fünf Vorlagen" });
  await app.clickOn('.song-menu .song-tpl-item[data-template="ambient"]');
  await app.waitFor(() => T.st.snapshot.peek().project.tracks.length === 5, { what: "Ambient-Spuren", timeout: 20000 });
  assert.equal((await proj()).tempoBpm, 84);
  await app.waitFor(() => T.$(".song")?.checkVisibility() && T.$(".song-tpl.on")?.textContent === "Ambient", { what: "Song-Fenster mit Ambient" });
});

test("agent: list templates, write a song with custom sections", async () => {
  await app.reset();
  const list = await app.mcp("list_song_templates", {});
  assert.equal(list.vorlagen.length, 5);
  const trance = list.vorlagen.find((t) => t.template === "trance");
  assert.equal(trance.takte, 120);
  assert.equal(trance.abschnitte[0].stufen, "pad 1");
  const r = await app.mcp("write_song", {
    template: "trance", tempo: 132, key: "d-Moll", chords: ["d", "B", "F", "C"],
    sections: [
      { name: "Anfang", bars: 8, kind: "intro", levels: { pad: 1, arp: 1 } },
      { name: "Aufbau", bars: 8, kind: "aufbau", levels: { pad: 2, arp: 2, kick: 1, hats: 1, fx: 2 } },
      { name: "Drop", bars: 8, kind: "hoehepunkt", levels: { pad: 2, arp: 2, bass: 2, lead: 2, kick: 2, hats: 2, clap: 2, fx: 1 } },
    ],
  });
  assert.equal(r.takte, 24);
  assert.equal(r.spuren.length, 5);
  const p = await proj();
  assert.equal(p.tempoBpm, 132);
  const pad = p.tracks.find((t) => t.name === "Fläche");
  // D minor: roots d (2) and B (10) occur
  const pcs = new Set(pad.clips.flatMap((c) => c.source.notes.map((n) => n.pitch % 12)));
  assert.ok(pcs.has(2) && pcs.has(10), [...pcs].join(","));
  await assert.rejects(app.mcp("write_song", { template: "polka" }), /Keine Song-Vorlage „polka“/);
  await assert.rejects(app.mcp("write_song", { template: "trance", key: "lila" }), /Tonart „lila“/);
});

test("no errors in the window", () => {
  assert.deepEqual(app.errors, []);
});

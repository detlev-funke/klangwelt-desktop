// The gear menu's display settings in the desktop app: the language as one entry that
// opens the list, the interface size as the webview's own zoom (remembered in the settings
// file and applied before the window shows at the next start – clicks, double clicks and
// drags still hit what is under the mouse), the spacing of the layout (tight, normal, airy)
// and the project page, which opens in the system's browser.
import { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startApp, makeTest, sleep } from "./harness.mjs";

let app;
const test = makeTest(() => app);
after(async () => {
  await app?.close();
});

/** The shell's settings file of this instance (KLANGWELT_BIBLIOTHEK). */
const settingsFile = () => {
  try {
    return JSON.parse(readFileSync(join(app.tmp, "bibliothek", "einstellungen.json"), "utf8"));
  } catch {
    return {};
  }
};

async function openSettings() {
  if (!(await app.eval(() => !!T.$(".set-menu.open")))) await app.clickOn('[data-help="einstellungen"]');
  await app.waitFor(() => !!T.$(".set-menu.open .lang-entry"), { what: "settings menu" });
}

async function closeMenus() {
  await app.eval(() => {
    for (const m of T.$$(".menu.open")) m.classList.remove("open");
  });
}

/** Window size in CSS px and the pixel ratio – page zoom changes both. */
const size = () => app.eval(() => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio }));

/** Set the size slider the way releasing its thumb does (input, then change). */
async function slideTo(percent) {
  await openSettings();
  await app.eval((p) => {
    const s = T.$(".set-menu.open .scale-slider");
    s.value = String(p);
    s.dispatchEvent(new Event("input", { bubbles: true }));
    s.dispatchEvent(new Event("change", { bubbles: true }));
  }, percent);
}

/** A notes clip at beat 1 on a new track, its pitch lanes 60…71 and the timeline at 50 px per beat. */
const pianoRoll = () =>
  app.eval(async () => {
    await T.st.act(window.__TAURI__.core.invoke("project_new"));
    await T.st.run({ type: "addTrack", track: { id: 0, name: "Maus", kind: "instrument" } });
    const t = T.st.snapshot.peek().project.tracks.at(-1);
    if (t.view !== "notes") await T.st.run({ type: "setTrack", trackId: t.id, patch: { view: "notes" } });
    await T.st.run({ type: "addClip", trackId: t.id, clip: { id: 0, name: "Noten", startBeats: 1, source: { type: "notes", lengthBeats: 4, notes: [] } } });
    T.pr.pitchViews.update((m) => ({ ...m, [t.id]: { low: 60, span: 12 } }));
    T.st.viewport.value = { pxPerBeat: 50, scrollX: 0, scrollY: 0 };
    T.st.selection.value = null;
    T.st.showPanel("spuren");
    await T.sleep(300);
    return t.id;
  });

/** Window point of a pitch lane's middle at a beat (the timeline's own geometry). */
const pointOf = (id, beat, pitch) =>
  app.eval((id, beat, pitch) => {
    const tracks = T.st.snapshot.peek().project.tracks;
    const track = tracks.find((t) => t.id === id);
    const g = T.pr.geoFor(track);
    const c = T.$("kw-timeline canvas").getBoundingClientRect();
    const { pxPerBeat, scrollX, scrollY } = T.st.viewport.peek();
    const top = T.pr.rowTops(tracks)[tracks.indexOf(track)];
    return [c.x + beat * pxPerBeat - scrollX, c.y + T.st.RULER_H + top - scrollY + T.pr.laneY(g, pitch) + g.laneH / 2];
  }, id, beat, pitch);

async function dblclick(x, y) {
  await app.mouse("mouseMoved", x, y);
  for (const clickCount of [1, 2]) {
    await app.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount });
    await app.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount });
  }
  await sleep(250);
}

test("gear menu: the language is one entry with its flag; it opens the list and goes back", async () => {
  app = await startApp();
  await openSettings();
  const entry = await app.eval(() => {
    const e = T.$(".set-menu.open .lang-entry");
    return { flag: e.querySelector("svg.flag")?.dataset.flag, name: e.querySelector("b").textContent, languages: T.$$(".set-menu.open [data-lang]").length };
  });
  assert.deepEqual(entry, { flag: "de", name: "Deutsch", languages: 0 });
  await app.clickOn(".set-menu.open .lang-entry");
  await app.waitFor(() => T.$$(".set-menu.open [data-lang]").length === 7, { what: "language list" });
  assert.equal(await app.eval(() => document.activeElement?.dataset.lang), "de");
  await app.clickOn(".set-menu.open .lang-back");
  assert.deepEqual(await app.eval(() => [T.$(".set-menu").dataset.page, T.$$(".set-menu.open [data-lang]").length]), ["main", 0]);
  await closeMenus();
});

test("interface size: the webview zooms (40 … 200 %), clicks and drags still hit; remembered for the next start", async () => {
  const base = await size();
  await openSettings();
  const s = await app.eval(() => {
    const r = T.$(".set-menu.open .scale-slider");
    return { disabled: r.disabled, min: r.min, max: r.max, value: T.$(".set-menu.open .scale-value").textContent };
  });
  assert.deepEqual(s, { disabled: false, min: "40", max: "200", value: "100 %" });
  await slideTo(80);
  await app.waitFor((w) => Math.abs(innerWidth - w / 0.8) <= 3, { what: "page laid out at 80 %" }, base.w);
  const z = await size();
  assert.ok(Math.abs(z.dpr - base.dpr * 0.8) < 0.02, `pixel ratio ${z.dpr} (was ${base.dpr})`);
  assert.equal(settingsFile().ui_scale, 0.8, "in the settings file");
  assert.equal(await app.eval(() => T.$(".set-menu .scale-value").textContent), "80 %");
  await closeMenus();

  // a double click on the lane of E4 (64), a bit after beat 3: a note E4 on beat 3 (2 beats into the clip)
  const id = await pianoRoll();
  await dblclick(...(await pointOf(id, 3.1, 64)));
  await app.waitFor((id) => T.st.snapshot.peek().project.tracks.find((t) => t.id === id).clips[0].source.notes.length === 1, { what: "note from a double click" }, id);
  assert.deepEqual(await app.eval((id) => T.st.snapshot.peek().project.tracks.find((t) => t.id === id).clips[0].source.notes.map((n) => [n.pitch, n.startBeats]), id), [[64, 2]]);
  // drag the note by its middle one beat to the right and two semitones up
  const len = await app.eval((id) => T.st.snapshot.peek().project.tracks.find((t) => t.id === id).clips[0].source.notes[0].lengthBeats, id);
  const [nx, ny] = await pointOf(id, 3 + len / 2, 64);
  const [, ny2] = await pointOf(id, 3 + len / 2, 66);
  await app.drag([nx, ny], [nx + 50, ny2], { steps: 10 });
  await app.waitFor((id) => T.st.snapshot.peek().project.tracks.find((t) => t.id === id).clips[0].source.notes[0]?.startBeats === 3, { what: "note dragged" }, id);
  assert.deepEqual(await app.eval((id) => T.st.snapshot.peek().project.tracks.find((t) => t.id === id).clips[0].source.notes.map((n) => [n.pitch, n.startBeats]), id), [[66, 3]]);
  // the dock's gutter follows the mouse 1:1
  const gutter = await app.eval(() => {
    const g = T.$("#dock .dk-gutter.row").getBoundingClientRect();
    return { x: g.x + g.width / 2, y: g.y + g.height / 2 };
  });
  await app.drag([gutter.x, gutter.y], [gutter.x - 60, gutter.y], { steps: 6 });
  const moved = await app.eval(() => T.$("#dock .dk-gutter.row").getBoundingClientRect().x + T.$("#dock .dk-gutter.row").getBoundingClientRect().width / 2);
  assert.ok(Math.abs(moved - (gutter.x - 60)) <= 3, `gutter at ${moved}, mouse at ${gutter.x - 60}`);

  // a reload of the page (as when switching the language) keeps the zoom
  await app.eval(() => location.reload());
  await app.waitFor(() => !!document.querySelector("kw-transport")?.childElementCount && !!window.__TAURI__, { timeout: 20000, what: "reload" });
  assert.ok(Math.abs((await size()).w - base.w / 0.8) <= 3, "still 80 % after a reload");

  // the next start: zoomed before anything shows, the slider at 80 %
  const tmp = app.tmp;
  await app.stop();
  app = await startApp({ tmp });
  const again = await size();
  assert.ok(Math.abs(again.w - base.w / 0.8) <= 3, `80 % at the start: ${again.w} px (100 %: ${base.w})`);
  await openSettings();
  assert.equal(await app.eval(() => T.$(".set-menu.open .scale-value").textContent), "80 %");
  // back to 100 %: the button next to the slider
  await app.eval(() => T.$(".set-menu.open .scale-reset").click());
  await app.waitFor((w) => Math.abs(innerWidth - w) <= 1, { what: "100 %" }, base.w);
  assert.equal(settingsFile().ui_scale, 1);
  await closeMenus();
});

test("spacing: tight, normal and airy change margins, gutters and tab bars at once and stay for the next start", async () => {
  const spacing = () =>
    app.eval(() => {
      const area = T.$("#dock .dk-area").getBoundingClientRect();
      const host = T.$("#dock").getBoundingClientRect();
      return {
        density: document.documentElement.dataset.density ?? "normal",
        inset: Math.round(area.left - host.left),
        gutter: Math.round(T.$("#dock .dk-gutter.row").getBoundingClientRect().width),
        tabs: Math.round(T.$("#dock .dk-tabs").getBoundingClientRect().height),
      };
    });
  await openSettings();
  assert.deepEqual(await spacing(), { density: "normal", inset: 5, gutter: 5, tabs: 33 });
  await app.clickOn('.set-menu.open [data-density="tight"]');
  assert.deepEqual(await spacing(), { density: "tight", inset: 2, gutter: 2, tabs: 29 });
  await app.clickOn('.set-menu.open [data-density="air"]');
  assert.deepEqual(await spacing(), { density: "air", inset: 12, gutter: 10, tabs: 38 });
  const tmp = app.tmp;
  await app.stop();
  app = await startApp({ tmp });
  assert.deepEqual(await spacing(), { density: "air", inset: 12, gutter: 10, tabs: 38 });
  await openSettings();
  await app.clickOn('.set-menu.open [data-density="normal"]');
  assert.deepEqual(await spacing(), { density: "normal", inset: 5, gutter: 5, tabs: 33 });
  await closeMenus();
});

test("Klangwelt on GitHub: the desktop app hands the project page to the system's browser – https only", async () => {
  // the test stands in for the browser: the call is recorded, nothing opens
  await app.eval(async () => {
    const { backend } = await import("./bridge.js");
    window.__opened = [];
    backend.openUrl = async (url) => void window.__opened.push(url);
  });
  await openSettings();
  await app.clickOn(".set-menu.open [data-github]");
  assert.deepEqual(await app.eval(() => window.__opened), ["https://github.com/detlev-funke/klangwelt"]);
  assert.equal(await app.eval(() => T.$(".set-menu").classList.contains("open")), false, "the menu closed");
  assert.equal(await app.eval(() => location.protocol + location.host), "http:tauri.localhost", "the window stayed on Klangwelt");
  // the shell's command refuses anything but a plain https address (and opens nothing for it)
  for (const url of ["http://example.com", "file:///C:/Windows/notepad.exe", "https://example.com/a b", 'https://x" & calc']) {
    const err = await app.eval((u) => window.__TAURI__.core.invoke("open_url", { url: u }).then(() => null, (e) => String(e)), url);
    assert.equal(err, `Keine Webadresse: ${url}`);
  }
});

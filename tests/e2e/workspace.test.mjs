// Workspace: Window menu, settings (pitch axis), clip window, expression
// (painting velocity, Alt+drag), audio analysis of the demo, Sound window (sound shaping).
import { before, after } from "node:test";
import assert from "node:assert/strict";
import { startApp, makeTest, noteGeo, geoFns, MOD } from "./harness.mjs";

let app;
const test = makeTest(() => app);
before(async () => {
  app = await startApp();
});
after(async () => {
  await app?.close();
});

/** Instrument track in score view with 4 notes (velocity 100), view 80 px/beat. */
async function noteTrack() {
  return app.eval(async () => {
    await T.st.run({ type: "addTrack", track: { id: 0, name: "Ausdruck", kind: "instrument" } });
    const t = T.st.snapshot.peek().project.tracks.at(-1);
    if (t.view !== "notes") await T.st.run({ type: "setTrack", trackId: t.id, patch: { view: "notes" } });
    const notes = [0, 1, 2, 3].map((s) => ({ pitch: 60 + s, startBeats: s, lengthBeats: 0.9, velocity: 100 }));
    await T.st.run({ type: "addClip", trackId: t.id, clip: { id: 0, name: "Noten", startBeats: 0, source: { type: "notes", lengthBeats: 4, notes } } });
    T.st.viewport.value = { pxPerBeat: 80, scrollX: 0, scrollY: 0 };
    T.st.showPanel("spuren");
    await T.sleep(200);
    return t.id;
  });
}
const velocities = (id) => app.eval((id) => T.st.snapshot.peek().project.tracks.find((t) => t.id === id).clips[0].source.notes.map((n) => n.velocity), id);

test("window menu hides a window and shows it again", async () => {
  await app.clickOn("kw-transport .btn", { text: "Fenster" });
  await app.clickOn(".win-menu .menu-item.win", { text: "Bibliothek" });
  await app.waitFor(() => !T.$$(".dk-tab").some((t) => t.textContent.includes("Bibliothek")), { what: "Bibliothek ausgeblendet" });
  await app.clickOn("kw-transport .btn", { text: "Fenster" });
  await app.clickOn(".win-menu .menu-item.win", { text: "Bibliothek" });
  await app.waitFor(() => T.$$(".dk-tab").some((t) => t.textContent.includes("Bibliothek")), { what: "Bibliothek wieder da" });
});

test("docking: under the target cross the content of the target area fades", async () => {
  const tab = await app.eval(() => {
    const t = T.$$(".dk-tab").find((x) => x.textContent.includes("Analyse"));
    const r = t.getBoundingClientRect();
    return [r.x + r.width / 2, r.y + r.height / 2];
  });
  const over = await app.eval(() => {
    const r = T.$("kw-timeline").getBoundingClientRect();
    return [r.x + r.width / 2, r.y + r.height / 2];
  });
  const seen = await app.drag(tab, over, {
    steps: 12,
    during: async () => {
      await new Promise((r) => setTimeout(r, 150));
      const v = await app.eval(() => {
        const under = T.$(".dk-stack.dk-under");
        return {
          under: !!under && !!under.querySelector("kw-timeline"),
          opacity: under ? Number(getComputedStyle(under.querySelector(".dk-body")).opacity) : 1,
          cross: T.$$(".dk-target.show").length,
        };
      });
      // cancel: the layout stays
      await app.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
      await app.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
      return v;
    },
  });
  assert.equal(seen.under, true, "Spuren-Fläche ist das Ziel");
  assert.ok(seen.opacity < 0.5, `verblasst: ${seen.opacity}`);
  assert.ok(seen.cross > 0, "Ziel-Kreuz sichtbar");
  assert.equal(await app.eval(() => T.$$(".dk-stack.dk-under").length), 0, "nach dem Ziehen wieder normal");
  assert.ok(await app.eval(() => T.$$(".dk-tab").some((t) => t.textContent.includes("Analyse"))), "Analyse noch da");
});

test("settings: switch the pitch axis", async () => {
  const before = await app.eval(() => T.pr.highOnTop.peek());
  await app.clickOn("kw-transport .btn.icon[title='Einstellungen']");
  await app.clickOn(".set-option", { text: before ? "Tiefe Töne oben" : "Hohe Töne oben" });
  assert.equal(await app.eval(() => T.pr.highOnTop.peek()), !before);
  await app.clickOn("kw-transport .btn.icon[title='Einstellungen']");
  await app.clickOn(".set-option", { text: before ? "Hohe Töne oben" : "Tiefe Töne oben" });
  assert.equal(await app.eval(() => T.pr.highOnTop.peek()), before);
});

test("clip window explains the controls (Alt+click places notes)", async () => {
  await app.reset();
  const id = await noteTrack();
  await app.eval((id) => {
    const t = T.st.snapshot.peek().project.tracks.find((t) => t.id === id);
    T.st.selection.value = { trackId: id, clipId: t.clips[0].id };
    T.st.showPanel("clip");
  }, id);
  const hint = await app.waitFor(() => T.$$(".hint").map((h) => h.textContent).find((t) => t.includes("Alt+Klick setzt eine Note")) ?? null, { what: "Bedienhilfe" });
  assert.match(hint, /Auswahlrahmen/);
});

test("expression track: paint velocity across several notes", async () => {
  await app.reset();
  const id = await noteTrack();
  // Expression track is on by default – only show it if hidden
  if (!(await app.eval(() => T.$("kw-tracks .toggle.v.x").classList.contains("on")))) await app.clickOn("kw-tracks .toggle.v.x");
  const lane = await app.waitFor((id) => {
    const p = T.st.snapshot.peek().project;
    const i = p.tracks.findIndex((t) => t.id === id);
    const g = T.pr.geoFor(p.tracks[i]);
    if (!g.exprH) return null;
    const c = T.$("kw-timeline canvas").getBoundingClientRect();
    const rowY = c.y + T.st.RULER_H + T.pr.rowTops(p.tracks)[i] - T.st.viewport.peek().scrollY;
    return { x: c.x, top: rowY + g.exprTop, h: g.exprH };
  }, { what: "Ausdrucksspur" }, id);
  // just above the floor of the track = quiet
  const y = lane.top + lane.h - 4;
  await app.drag([lane.x + 5, y], [lane.x + 80 * 3.5, y]);
  const v = await velocities(id);
  assert.ok(v.every((x) => x < 40), `alle leiser: ${v}`);
  // Button hides the expression track (one click is enough)
  await app.clickOn("kw-tracks .toggle.v.x");
  await app.waitFor((id) => !T.pr.geoFor(T.st.snapshot.peek().project.tracks.find((t) => t.id === id)).exprH, { what: "Ausdrucksspur aus" }, id);
});

test("Alt+drag on a note changes its velocity", async () => {
  await app.reset();
  const id = await noteTrack();
  const g = geoFns(await noteGeo(app, id));
  await app.drag([g.X(1.4), g.Y(61)], [g.X(1.4), g.Y(61) - 60], { mods: MOD.alt });
  const v = await velocities(id);
  assert.ok(v[1] > 100, `lauter: ${v}`);
  assert.equal(v[0], 100, "andere Noten unverändert");
});

test("demo: analyzing an audio clip shows key, tempo and notes", async () => {
  await app.reset();
  await app.eval(() => T.st.act(window.__TAURI__.core.invoke("create_demo")));
  await app.eval(() => {
    const p = T.st.snapshot.peek().project;
    const t = p.tracks.find((t) => t.clips.some((c) => c.source.type === "audio"));
    const c = t.clips.find((c) => c.source.type === "audio");
    T.st.selection.value = { trackId: t.id, clipId: c.id };
    T.st.showPanel("clip");
  });
  await app.clickOn(".btn", { text: "Analysieren" });
  const facts = await app.waitFor(() => T.$(".analysis .facts")?.textContent ?? null, { timeout: 20000, what: "Analyse" });
  assert.match(facts, /Tonart/);
  assert.match(facts, /Tempo-Schätzung/);
  assert.match(facts, /Noten/);
});

test("sound window: choose a starting point and insert a pattern", async () => {
  await app.reset();
  const r = await app.mcp("create_instrument_track", { kind: "bass" });
  await app.eval((id) => {
    T.st.selection.value = { trackId: id, clipId: null };
    T.st.showPanel("klang");
  }, r.trackId);
  await app.waitFor(() => T.$$(".snd-field[data-field=charakter] .snd-mark").length > 1, { what: "Klang-Fenster" });
  const before = await app.eval((id) => JSON.stringify(T.st.snapshot.peek().project.tracks.find((t) => t.id === id).instrument), r.trackId);
  const preset = await app.eval(() => T.$$(".snd-field[data-field=charakter] .snd-mark")[1].dataset.name);
  await app.clickOn(".snd-field[data-field=charakter] .snd-mark", { text: preset });
  await app.waitFor((id, b) => JSON.stringify(T.st.snapshot.peek().project.tracks.find((t) => t.id === id).instrument) !== b, { what: "Voreinstellung übernommen" }, r.trackId, before);
  const clips = await app.eval((id) => T.st.snapshot.peek().project.tracks.find((t) => t.id === id).clips.length, r.trackId);
  await app.clickOn(".sound .btn", { text: "Muster einfügen" });
  await app.waitFor((id, n) => T.st.snapshot.peek().project.tracks.find((t) => t.id === id).clips.length === n + 1, { what: "Muster" }, r.trackId, clips);
});

test("sound shaping: warmth, beating, color, roughness, width and distance for every instrument", async () => {
  const list = await app.mcp("list_instruments", {});
  const text = JSON.stringify(list);
  for (const key of ["waerme", "schwebung", "raum", "farbe", "rauheit", "breite"]) assert.ok(text.includes(key), `list_instruments nennt ${key}`);
  for (const kind of ["pluck", "organ", "harpsichord", "synth"]) {
    const r = await app.mcp("create_instrument_track", { kind });
    await app.eval((id) => {
      T.st.selection.value = { trackId: id, clipId: null };
      T.st.showPanel("klang");
    }, r.trackId);
    await app.waitFor(() => T.$$(".sound .pgroup h4").some((h) => h.textContent.includes("Klangformung")), { what: `Gruppe Klangformung (${kind})` });
    const labels = await app.eval(() => {
      const of = (name) => [...T.$$(".sound .pgroup").find((x) => x.querySelector("h4")?.textContent === name).querySelectorAll(".slider label span")].map((x) => x.textContent);
      return [of("Klangformung"), of("Klangfarbe"), of("Raum")];
    });
    assert.deepEqual(labels, [["Wärme", "Schwebung"], ["Farbe", "Rauheit"], ["Breite", "Entfernung"]]);
    // Pull up the distance: ends up as "raum" in the track's instrument
    await app.eval(() => {
      const g = T.$$(".sound .pgroup").find((x) => x.querySelector("h4")?.textContent === "Raum");
      const raum = [...g.querySelectorAll(".slider")].find((x) => x.textContent.includes("Entfernung")).querySelector("input");
      raum.value = "0.9";
      raum.dispatchEvent(new Event("input"));
      raum.dispatchEvent(new Event("change"));
    });
    const raum = await app.waitFor((id) => {
      const v = T.st.snapshot.peek().project.tracks.find((t) => t.id === id).instrument.params.raum;
      return Math.abs(v - 0.9) < 1e-6 ? v : null;
    }, { what: "Raum gesetzt" }, r.trackId);
    assert.equal(raum, 0.9);
  }
  // also adjustable via agent
  const t = await app.mcp("create_instrument_track", { kind: "bass" });
  await app.mcp("set_sound", { trackId: t.trackId, params: { waerme: 0.8, raum: 0.4 } });
  const p = await app.waitFor((id) => {
    const x = T.st.snapshot.peek().project.tracks.find((tr) => tr.id === id).instrument.params;
    return x.waerme === 0.8 ? x : null;
  }, { what: "Agent setzt Wärme" }, t.trackId);
  assert.equal(p.raum, 0.4);
});

test("no errors in the window", () => {
  assert.deepEqual(app.errors, []);
});

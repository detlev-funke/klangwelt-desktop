// Klang-Fenster: drei Felder (Charakter, Klangfarbe, Raum) mit eigenen
// Startpunkten, die nur ihr eigenes Feld ändern; Punkt ziehen (ein
// Rückgängig-Schritt); Felder ein-/ausblenden; Anspielen aus · Einzelton ·
// Muster; Synth mit Verlaufsvorlagen, Puls, Ausklang und gezeichneten Kurven;
// Wellenform; dasselbe per Agent.
import { before, after } from "node:test";
import assert from "node:assert/strict";
import { startApp, makeTest, sleep } from "./harness.mjs";

let app;
const test = makeTest(() => app);
before(async () => {
  app = await startApp();
});
after(async () => {
  await app?.close();
});

const inst = (id) => app.eval((id) => T.st.snapshot.peek().project.tracks.find((t) => t.id === id).instrument, id);
async function open(kind) {
  const r = await app.mcp("create_instrument_track", { kind });
  await app.eval((id) => {
    T.st.selection.value = { trackId: id, clipId: null };
    T.st.showPanel("klang");
  }, r.trackId);
  await app.waitFor(() => T.$$(".snd-field").length === 3, { what: "Felder" });
  // Vorhören beim Loslassen aus – die Tests sollen leise sein
  await app.eval(() => T.$(".snd-play .seg-btn[data-mode=aus]").click());
  return r.trackId;
}
const mark = (field, name) => app.clickOn(`.snd-field[data-field=${field}] .snd-mark`, { text: name });
/** Punkt in einem Feld (x, y je 0…1) in Fensterkoordinaten. */
const plotAt = (field, x, y) => app.eval(async (field, x, y) => {
  const el = T.$(`.snd-field[data-field=${field}] .snd-plot`);
  el.scrollIntoView({ block: "center" });
  await T.sleep(100);
  const r = el.getBoundingClientRect();
  return [r.x + x * r.width, r.y + (1 - y) * r.height];
}, field, x, y);

test("Drei Felder mit Achsen und Startpunkten", async () => {
  await app.reset();
  await open("drums");
  const f = await app.eval(() => T.$$(".snd-field").map((el) => ({
    key: el.dataset.field,
    marks: [...el.querySelectorAll(".snd-mark")].map((m) => m.dataset.name),
    x: [...el.querySelectorAll(".snd-xwords span")].map((s) => s.textContent),
    y: el.querySelector(".snd-ylab").textContent,
  })));
  assert.deepEqual(f.map((x) => x.key), ["charakter", "klangfarbe", "raum"]);
  assert.deepEqual(f[0].x, ["knackig", "saftig", "voll", "mächtig"]);
  assert.equal(f[0].y, "schlicht → komplex");
  assert.ok(f[0].marks.includes("Trap") && f[0].marks.includes("808"));
  assert.deepEqual(f[1].x, ["dunkel", "warm", "klar", "hell"]);
  assert.equal(f[1].y, "glatt → rau");
  assert.deepEqual(f[2].x, ["schmal", "mittig", "breit", "weit"]);
  assert.equal(f[2].y, "nah → fern");
  assert.ok(f[2].marks.includes("Kirche"));
  // keine Knöpfe mit Voreinstellungen neben den Feldern
  assert.equal(await app.eval(() => T.$$(".sound-side .presets").length), 1, "nur Vorhören");
});

test("Ein Startpunkt ändert nur sein eigenes Feld", async () => {
  await app.reset();
  const id = await open("drums");
  await mark("klangfarbe", "Staub");
  await mark("raum", "Kirche");
  const a = await app.waitFor((id) => {
    const p = T.st.snapshot.peek().project.tracks.find((t) => t.id === id).instrument.params;
    return p.raum > 0.85 && p.rauheit > 0.7 ? p : null;
  }, { what: "Klangfarbe und Raum gesetzt" }, id);
  await mark("charakter", "Trap");
  const b = await app.waitFor((id) => {
    const i = T.st.snapshot.peek().project.tracks.find((t) => t.id === id).instrument;
    return i.preset === "Trap" ? i.params : null;
  }, { what: "Trap" }, id);
  for (const k of ["farbe", "rauheit", "breite", "raum"]) assert.equal(b[k], a[k], `${k} unverändert`);
  assert.ok(b["kick.laenge"] > a["kick.laenge"] + 0.2, "Trap ist mächtiger");
  await app.waitFor(() => T.$(".snd-field[data-field=charakter] .snd-mark.on")?.dataset.name === "Trap", { what: "Marke Trap aktiv" });
  await mark("klangfarbe", "Glanz");
  const c = await app.waitFor((id) => {
    const p = T.st.snapshot.peek().project.tracks.find((t) => t.id === id).instrument.params;
    return p.farbe > 0.8 ? p : null;
  }, { what: "Glanz" }, id);
  for (const [k, v] of Object.entries(b)) if (k !== "farbe" && k !== "rauheit") assert.equal(c[k], v, `${k} unverändert`);
  await app.waitFor(() => T.$(".snd-field[data-field=klangfarbe] .snd-mark.on")?.dataset.name === "Glanz", { what: "Marke Glanz aktiv" });
});

test("Punkt ziehen verschiebt die Regler – ein Rückgängig-Schritt", async () => {
  await app.reset();
  const id = await open("drums");
  const before = (await inst(id)).params;
  await app.drag(await plotAt("charakter", 0.1, 0.3), await plotAt("charakter", 0.9, 0.3), { steps: 10 });
  const after = await app.waitFor((id) => {
    const p = T.st.snapshot.peek().project.tracks.find((t) => t.id === id).instrument.params;
    return p["charakter.x"] > 0.85 ? p : null;
  }, { what: "gezogen" }, id);
  assert.ok(after["kick.laenge"] > before["kick.laenge"] + 0.2, "mächtiger");
  assert.ok(after["kick.grundton"] < before["kick.grundton"], "tiefer");
  assert.equal((await inst(id)).preset, "eigen");
  // letzte Bewegung abwarten (die Anfragen laufen nacheinander)
  await app.waitFor(async (id) => {
    const x = T.st.snapshot.peek().project.tracks.find((t) => t.id === id).instrument.params["charakter.x"];
    await T.sleep(250);
    return x === T.st.snapshot.peek().project.tracks.find((t) => t.id === id).instrument.params["charakter.x"] ? x : null;
  }, { what: "Ziehen fertig" }, id);
  assert.match(await app.eval(() => T.$(".snd-field[data-field=charakter] .snd-field-head .muted").textContent), /^mächtig · griffig$/);
  await app.eval(() => T.st.act(window.__TAURI__.core.invoke("undo")));
  const undone = await app.waitFor((id) => {
    const p = T.st.snapshot.peek().project.tracks.find((t) => t.id === id).instrument.params;
    return p["charakter.x"] < 0.5 ? p : null;
  }, { what: "rückgängig" }, id);
  assert.equal(undone["kick.laenge"], before["kick.laenge"], "ein Schritt macht das ganze Ziehen rückgängig");
});

test("Klangfarbe und Raum lassen sich ausblenden – das bleibt so", async () => {
  await app.reset();
  const id = await open("bass");
  await app.clickOn(".snd-toggle", { text: "Raum" });
  assert.equal(await app.eval(() => T.$(".snd-field[data-field=raum]").hidden), true);
  // neu aufbauen (andere Spur und zurück): bleibt ausgeblendet
  const other = await open("pluck");
  assert.equal(await app.eval(() => T.$(".snd-field[data-field=raum]").hidden), true);
  await app.eval((id) => (T.st.selection.value = { trackId: id, clipId: null }), id);
  await app.waitFor(() => T.$(".snd-kinds .seg-btn.on")?.textContent === "Bass", { what: "Bass-Spur" });
  assert.equal(await app.eval(() => T.$(".snd-field[data-field=raum]").hidden), true);
  await app.clickOn(".snd-toggle", { text: "Raum" });
  assert.equal(await app.eval(() => T.$(".snd-field[data-field=raum]").hidden), false);
  assert.ok(other > 0);
});

test("Die Schrift eines Startpunkts fängt keine Klicks – nur sein Punkt", async () => {
  await app.reset();
  const id = await open("drums");
  // Klick auf den Namen „Techno“: setzt den Punkt dort, wählt aber nicht den Startpunkt
  const at = await app.eval(async () => {
    const m = T.$$(".snd-field[data-field=charakter] .snd-mark").find((x) => x.dataset.name === "Techno");
    m.scrollIntoView({ block: "center" });
    await T.sleep(100);
    const s = m.querySelector("span").getBoundingClientRect();
    const p = T.$(".snd-field[data-field=charakter] .snd-plot").getBoundingClientRect();
    return { x: s.x + s.width / 2, y: s.y + s.height / 2, fx: (s.x + s.width / 2 - p.x) / p.width };
  });
  await app.click(at.x, at.y);
  const i = await app.waitFor((id) => {
    const i = T.st.snapshot.peek().project.tracks.find((t) => t.id === id).instrument;
    return i.preset === "eigen" ? i : null;
  }, { what: "Punkt gesetzt statt Startpunkt" }, id);
  assert.ok(Math.abs(i.params["charakter.x"] - at.fx) < 0.03, `x ${i.params["charakter.x"]} ≈ ${at.fx}`);
  // Klick auf den Punkt der Marke wählt den Startpunkt
  await mark("charakter", "Techno");
  await app.waitFor((id) => T.st.snapshot.peek().project.tracks.find((t) => t.id === id).instrument.preset === "Techno", { what: "Startpunkt Techno" }, id);
  const dot = await app.eval(() => {
    const m = T.$$(".snd-field[data-field=charakter] .snd-mark").find((x) => x.dataset.name === "Techno");
    const p = T.$(".snd-field[data-field=charakter] .snd-plot").getBoundingClientRect();
    const r = m.querySelector("i").getBoundingClientRect();
    return [(r.x + r.width / 2 - p.x) / p.width, 1 - (r.y + r.height / 2 - p.y) / p.height];
  });
  assert.ok(Math.abs(dot[0] - 0.22) < 0.02 && Math.abs(dot[1] - 0.42) < 0.02, `Punkt sitzt genau auf dem Startpunkt: ${dot}`);
});

test("Die Felder wachsen mit dem Fenster und passen in die sichtbare Höhe", async () => {
  await app.reset();
  await open("drums");
  const size = () => app.eval(() => {
    const p = T.$(".snd-field[data-field=charakter] .snd-plot").getBoundingClientRect();
    const b = T.$(".snd-plot").closest(".tab-body").getBoundingClientRect();
    return { w: Math.round(p.width), h: Math.round(p.height), widths: T.$$(".snd-plot").map((x) => Math.round(x.getBoundingClientRect().width)), bodyBottom: b.bottom };
  });
  const small = await size();
  assert.equal(new Set(small.widths).size, 1, "alle gleich groß");
  assert.equal(small.w, small.h, "quadratisch");
  try {
    await app.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1500, deviceScaleFactor: 1, mobile: false });
    const big = await app.waitFor((w) => {
      const p = T.$(".snd-plot").getBoundingClientRect();
      return p.width > w + 20 ? Math.round(p.width) : null;
    }, { what: "größere Felder" }, small.w);
    // sichtbar ohne Rollen: das Feld endet oberhalb der Unterkante des Fensters
    const geo = await app.eval(() => {
      const body = T.$(".snd-plot").closest(".tab-body");
      body.scrollTop = 0;
      return { plotBottom: T.$(".snd-plot").getBoundingClientRect().bottom, bodyBottom: body.getBoundingClientRect().bottom };
    });
    assert.ok(geo.plotBottom <= geo.bodyBottom, JSON.stringify(geo));
    assert.ok(big > small.w);
    // ein Feld ausgeblendet: die übrigen dürfen breiter werden, bleiben aber in der Höhe
    await app.clickOn(".snd-toggle", { text: "Raum" });
    await sleep(200);
    const two = await app.eval(() => {
      const p = T.$(".snd-plot").getBoundingClientRect();
      return { w: p.width, bottom: p.bottom, bodyBottom: T.$(".snd-plot").closest(".tab-body").getBoundingClientRect().bottom };
    });
    assert.ok(two.w >= big - 1 && two.bottom <= two.bodyBottom, JSON.stringify(two));
    await app.clickOn(".snd-toggle", { text: "Raum" });
  } finally {
    await app.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  }
});

test("Zeitverlauf lässt sich einklappen – das bleibt so", async () => {
  await app.reset();
  await open("synth");
  assert.equal(await app.eval(() => T.$(".snd-time").open), true, "anfangs offen");
  await app.clickOn(".snd-time > summary");
  try {
    assert.equal(await app.eval(() => T.$(".snd-time").open), false);
    assert.equal(await app.eval(() => T.$(".snd-wave").checkVisibility()), false, "Wellenform weg");
    await open("drums");
    assert.equal(await app.eval(() => T.$(".snd-time").open), false, "bleibt eingeklappt");
  } finally {
    // für die übrigen Tests wieder offen
    await app.eval(() => T.$(".snd-time").open || T.$(".snd-time > summary").click());
  }
  await app.waitFor(() => T.$(".snd-wave").checkVisibility() && T.$(".snd-wave").getBoundingClientRect().height > 50, { what: "Wellenform wieder da" });
});

test("Synth: Verlaufsvorlagen setzen Kurven, Puls und Ausklang", async () => {
  await app.reset();
  const id = await open("synth");
  const chips = await app.eval(() => T.$$(".snd-vchip").map((b) => b.textContent));
  assert.deepEqual(chips, ["Anschwellen", "Glocke", "Atmen", "Aufblühen", "Pulsieren", "Wellen", "Gate", "Stich"]);
  assert.equal(await app.eval(() => T.$(".snd-vchip.on")?.textContent), "Anschwellen", "Standard");
  await app.clickOn(".snd-vchip", { text: "Pulsieren" });
  const i = await app.waitFor((id) => {
    const x = T.st.snapshot.peek().project.tracks.find((t) => t.id === id).instrument;
    return x.params["verlauf.puls"] === 2 ? x : null;
  }, { what: "Pulsieren" }, id);
  assert.deepEqual(i.curves.laut, [[0, 0], [0.08, 0.9]]);
  assert.equal(i.params["verlauf.pulstiefe"], 0.85);
  await app.waitFor(() => T.$(".snd-vchip.on")?.textContent === "Pulsieren" && T.$(".snd-vctl .seg-btn.on")?.textContent === "⅛", { what: "Anzeige" });
  await app.clickOn(".snd-vctl .seg-btn", { text: "aus" });
  await app.waitFor((id) => T.st.snapshot.peek().project.tracks.find((t) => t.id === id).instrument.params["verlauf.puls"] === 0, { what: "Puls aus" }, id);
  // Charakter-Startpunkt beim Synth ändert den Verlauf nicht
  const curves = JSON.stringify((await inst(id)).curves);
  await mark("charakter", "Kathedrale");
  await app.waitFor((id) => T.st.snapshot.peek().project.tracks.find((t) => t.id === id).instrument.preset === "Kathedrale", { what: "Kathedrale" }, id);
  assert.equal(JSON.stringify((await inst(id)).curves), curves);
});

test("Synth: Punkt per Doppelklick hinzufügen und ziehen", async () => {
  await app.reset();
  const id = await open("synth");
  await app.waitFor(() => T.$(".snd-time-head .muted")?.textContent.includes("Akkord"), { what: "Wellenform", timeout: 8000 });
  const orig = (await inst(id)).curves.laut;
  const n0 = orig.length;
  // Mitte der Lautstärke-Spur, bei 40 % der Breite
  const [x, y] = await app.eval(async () => {
    T.$(".snd-wave").scrollIntoView({ block: "center" });
    await T.sleep(100);
    const r = T.$(".snd-wave").getBoundingClientRect();
    return [r.x + r.width * 0.4, r.y + (r.height - 16) * 0.3];
  });
  await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  for (const clickCount of [1, 2]) {
    await app.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount });
    await app.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount });
  }
  const added = await app.waitFor((id, n0) => {
    const c = T.st.snapshot.peek().project.tracks.find((t) => t.id === id).instrument.curves.laut;
    return c.length === n0 + 1 ? c : null;
  }, { what: "Punkt hinzugefügt" }, id, n0);
  const idx = added.findIndex((p) => !orig.some((q) => q[0] === p[0] && q[1] === p[1]));
  assert.ok(idx > 0 && Math.abs(added[idx][1] - 0.5) < 0.2, JSON.stringify(added));
  // den neuen Punkt nach unten ziehen
  await app.drag([x, y], [x, y + 40], { steps: 6 });
  const moved = await app.waitFor((id, idx, v0) => {
    const c = T.st.snapshot.peek().project.tracks.find((t) => t.id === id).instrument.curves.laut;
    return c[idx][1] < v0 - 0.2 ? c : null;
  }, { what: "Punkt gezogen" }, id, idx, added[idx][1]);
  assert.equal(moved.length, n0 + 1);
});

test("Anspielen: Umschalter aus · Einzelton · Muster, gemerkt", async () => {
  await app.reset();
  await open("drums");
  // Vorhören abfangen: festhalten, welches Muster erklingen soll (ohne Audio)
  // (invoke selbst ist schreibgeschützt; die Brücke liest window.__TAURI__.core bei jedem Aufruf)
  await app.eval(() => {
    if (!window.__played) {
      window.__played = [];
      const core = window.__TAURI__.core;
      window.__TAURI__.core = { ...core, invoke: (cmd, args, opts) => (cmd === "preview_track" ? (window.__played.push(args.pattern), Promise.resolve(1)) : core.invoke(cmd, args, opts)) };
    }
    window.__played.length = 0;
  });
  const played = () => app.eval(() => [...window.__played]);
  assert.deepEqual(await app.eval(() => T.$$(".snd-play .seg-btn").map((b) => [b.dataset.mode, b.textContent])),
    [["aus", "aus"], ["ton", "Einzelschlag"], ["muster", "Beat"]]);
  await mark("charakter", "Trap");
  await sleep(400);
  assert.deepEqual(await played(), [], "aus: nichts");
  // Einzelschlag: Umschalten spielt gleich an, danach nach jeder Änderung
  await app.clickOn(".snd-play .seg-btn[data-mode=ton]");
  await mark("charakter", "House");
  await app.waitFor(() => window.__played.length === 2, { what: "zwei Einzelschläge" });
  assert.deepEqual(await played(), ["kick", "kick"]);
  // Muster
  await app.clickOn(".snd-play .seg-btn[data-mode=muster]");
  await mark("klangfarbe", "Staub");
  await app.waitFor(() => window.__played.length === 4, { what: "zwei Beats" });
  assert.deepEqual((await played()).slice(2), ["beat", "beat"]);
  assert.equal(await app.eval(() => JSON.parse(localStorage.getItem("klangwelt.klang.ansicht")).anspielen), "muster", "gemerkt");
  assert.equal(await app.eval(() => T.$(".snd-play .seg-btn.on").dataset.mode), "muster");
  // Synth: Einzelton = ein langer Ton, auch nach einer Verlaufsvorlage
  await open("synth");
  await app.eval(() => (window.__played.length = 0));
  await app.clickOn(".snd-play .seg-btn[data-mode=ton]");
  assert.equal(await app.eval(() => T.$(".snd-play .seg-btn[data-mode=ton]").textContent), "Einzelton");
  await app.clickOn(".snd-vchip", { text: "Atmen" });
  await app.waitFor(() => window.__played.length === 2, { what: "Einzelton nach dem Verlauf" });
  assert.deepEqual(await played(), ["einzelton", "einzelton"]);
  // für die übrigen Tests wieder still
  await app.eval(() => T.$(".snd-play .seg-btn[data-mode=aus]").click());
});

test("Agent: Felder, Startpunkte und Verlauf", async () => {
  await app.reset();
  const { trackId } = await app.mcp("create_instrument_track", { kind: "synth" });
  const list = await app.mcp("list_instruments", {});
  const synth = list.instrumente.find((s) => s.kind === "synth");
  assert.deepEqual(synth.fields.map((f) => f.key), ["charakter", "klangfarbe", "raum"]);
  assert.ok(synth.verlauf.some((v) => v.name === "Glocke"));
  const r = await app.mcp("set_sound_field", { trackId, field: "raum", preset: "Kirche" });
  assert.ok(r.anzeige.length > 0);
  let p = (await inst(trackId)).params;
  assert.equal(p.breite, 0.85);
  assert.equal(p.raum, 0.9);
  await app.mcp("set_sound_field", { trackId, field: "charakter", x: 0.2, y: 0.8 });
  p = (await inst(trackId)).params;
  assert.equal(p.raum, 0.9, "Raum bleibt");
  assert.equal(p["charakter.x"], 0.2);
  await app.mcp("set_sound", { trackId, verlauf: "Glocke" });
  assert.equal((await inst(trackId)).curves.laut[1][1], 1);
  await app.mcp("set_sound", { trackId, curves: { hell: [[0, 0.1], [2, 0.9]] } });
  assert.deepEqual((await inst(trackId)).curves.hell, [[0, 0.1], [2, 0.9]]);
  await assert.rejects(app.mcp("set_sound_field", { trackId, field: "raum", preset: "Mond" }), /Kein Startpunkt „Mond“.*Kirche/);
  await assert.rejects(app.mcp("set_sound", { trackId, verlauf: "Sturm" }), /Kein Verlauf „Sturm“/);
  // Schlagzeug: mächtiger heißt längere Bassdrum (Messwert)
  const drums = await app.mcp("create_instrument_track", { kind: "drums" });
  const len = async (x) => {
    const m = await app.mcp("set_sound_field", { trackId: drums.trackId, field: "charakter", x, y: 0.4 });
    return parseFloat(m.anzeige.find((a) => a.label === "Bassdrum-Länge").detail.replace(",", "."));
  };
  assert.ok((await len(1)) > (await len(0)) + 0.2, "mächtig klingt länger");
});

test("keine Fehler im Fenster", () => {
  assert.deepEqual(app.errors, []);
});

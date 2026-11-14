// Harmonie: Quintenzirkel, Vorschläge mit Stimmung, Legende, Wege zum Schluss,
// Kadenzkarten (+ anhängen / In Spur), Moll, Agent.
import { before, after } from "node:test";
import assert from "node:assert/strict";
import { startApp, makeTest, sleep } from "./harness.mjs";

let app;
const test = makeTest(() => app);
before(async () => {
  app = await startApp();
  await app.eval(async () => {
    T.st.showPanel("harmonie");
    await T.waitFor(() => T.$$(".hc-cell").length === 36 && T.$$(".hc-path").length > 0, 10000);
  });
});
after(async () => {
  await app?.close();
});

const sketch = () => app.eval(() => T.$$(".hc-chips .hc-chip:not(.cand) b").map((b) => b.textContent));
const toast = () => app.eval(() => T.$(".toast")?.textContent ?? "");

/** Verlauf auf die Tonika zurücksetzen. */
async function clearSketch() {
  await app.clickOn(".hc-actions .btn", { text: "Leeren" });
  await app.waitFor(() => T.$$(".hc-chips .hc-chip b").length === 1, { what: "Verlauf nur Tonika" });
}

test("Zirkel mit 36 Feldern, Legende mit fünf Stimmungen", async () => {
  const r = await app.eval(() => ({
    cells: T.$$(".hc-cell").length,
    legend: T.$$(".hc-lg").map((l) => [l.textContent, getComputedStyle(l.querySelector("i")).backgroundColor]),
  }));
  assert.equal(r.cells, 36);
  assert.deepEqual(r.legend, [
    ["lösend", "rgb(94, 224, 143)"],
    ["spannend", "rgb(255, 180, 84)"],
    ["überraschend", "rgb(255, 122, 198)"],
    ["hell", "rgb(255, 224, 102)"],
    ["dunkel", "rgb(111, 155, 255)"],
  ]);
});

test("Vorschläge und Pfeile tragen ihre Stimmung", async () => {
  await clearSketch();
  const r = await app.eval(() => ({
    rows: T.$$(".hc-row").map((row) => [row.querySelector(".hc-pick b").textContent, row.querySelector(".hc-mood")?.dataset.mood]),
    arrows: T.$$(".hc-arrow").map((a) => a.dataset.mood),
  }));
  const mood = Object.fromEntries(r.rows);
  assert.equal(mood.G, "spannend", "C → G baut Spannung auf");
  assert.equal(mood.F, "hell");
  assert.equal(mood.a, "dunkel");
  assert.ok(r.arrows.length >= 3 && r.arrows.every(Boolean), JSON.stringify(r.arrows));
});

test("Wege zum Schluss von C: alle Schlussarten, mehrschrittig, mit längeren Varianten", async () => {
  const paths = await app.eval(() => T.$$(".hc-path").map((p) => ({
    label: p.querySelector(".hc-plabel").textContent,
    longer: p.classList.contains("longer"),
    chords: [...p.querySelectorAll(".hc-pchip b")].map((b) => b.textContent),
    moods: [...p.querySelectorAll(".hc-pto")].map((a) => a.dataset.mood),
  })));
  const main = paths.filter((p) => !p.longer);
  assert.deepEqual(main.map((p) => p.label).sort(), ["Ganzschluss", "Halbschluss", "Plagalschluss", "Trugschluss"]);
  for (const p of paths) {
    assert.equal(p.chords[0], "C", "beginnt beim aktuellen Akkord");
    assert.equal(p.moods.length, p.chords.length - 1);
  }
  const ganz = main.find((p) => p.label === "Ganzschluss");
  assert.equal(ganz.chords.at(-1), "C");
  assert.equal(ganz.moods.at(-1), "loesend");
  assert.ok(paths.some((p) => p.longer && p.chords.length >= 4), "längere Variante vorhanden");
  const trug = main.find((p) => p.label === "Trugschluss");
  assert.equal(trug.chords.at(-1), "a");
  assert.equal(trug.moods.at(-1), "ueberraschend");
});

test("Maus über einem Weg zeichnet ihn nummeriert in den Zirkel, Klick hält ihn fest", async () => {
  const row = await app.center(".hc-path");
  await app.mouse("mouseMoved", row.x - row.w / 2 + 20, row.y);
  await sleep(150);
  const shown = await app.eval(() => ({
    segs: T.$$(".hc-route .seg").map((s) => s.dataset.mood),
    nums: T.$$(".hc-route .step text").map((t) => t.textContent),
    dim: T.$(".hc-arrows")?.classList.contains("dim"),
    steps: T.$(".hc-path").querySelectorAll(".hc-pto").length,
  }));
  assert.equal(shown.segs.length, shown.steps);
  assert.deepEqual(shown.nums, shown.segs.map((_, i) => String(i + 1)));
  assert.equal(shown.dim, true, "Vorschlagspfeile werden blass");
  // weg mit der Maus: Weg verschwindet
  await app.mouse("mouseMoved", 5, 500);
  await sleep(150);
  assert.equal(await app.eval(() => T.$$(".hc-route").length), 0);
  // Klick hält fest
  await app.click(row.x - row.w / 2 + 20, row.y);
  await app.mouse("mouseMoved", 5, 500);
  await sleep(150);
  assert.equal(await app.eval(() => T.$(".hc-path").classList.contains("on")), true);
  assert.ok(await app.eval(() => T.$$(".hc-route .seg").length) > 0, "festgehaltener Weg bleibt");
  await app.click(row.x - row.w / 2 + 20, row.y); // wieder lösen
  await app.mouse("mouseMoved", 5, 500);
  await sleep(100);
  assert.equal(await app.eval(() => T.$$(".hc-route").length), 0);
});

test("„+“ an einem Weg hängt seine Akkorde an den Verlauf", async () => {
  await clearSketch();
  const chords = await app.eval(() => [...T.$(".hc-path").querySelectorAll(".hc-pchip b")].slice(1).map((b) => b.textContent));
  await app.clickOn(".hc-path .hc-pbtns .btn.blue");
  await app.waitFor((n) => T.$$(".hc-chips .hc-chip b").length === 1 + n, { what: "Verlauf verlängert" }, chords.length);
  assert.deepEqual(await sketch(), ["C", ...chords]);
  assert.match(await toast(), /an den Verlauf angehängt/);
});

test("Kadenzkarte „+ anhängen“: Akkorde erscheinen sichtbar im Verlauf (Fehlerbericht)", async () => {
  await clearSketch();
  const card = await app.eval(() => {
    const c = T.$(".hc-cadcard");
    return { name: c.querySelector("b").textContent, chords: [...c.querySelectorAll(".hc-pchip b")].map((b) => b.textContent) };
  });
  // Knopf liegt weit unten – vorher ist der Verlauf aus dem Bild gerollt
  await app.clickOn(".hc-cadcard .btn.blue", { text: "anhängen" });
  await app.waitFor(() => T.$$(".hc-chips .hc-chip b").length > 1, { what: "Verlauf verlängert" });
  const expect = card.chords[0] === "C" ? card.chords : ["C", ...card.chords];
  assert.deepEqual(await sketch(), expect, `${card.name}: ${card.chords.join(" ")}`);
  assert.match(await toast(), new RegExp(`${card.name}: \\d Akkorde an den Verlauf angehängt`));
  assert.ok(await app.eval(() => T.$$(".hc-chip.new").length) > 0, "neue Akkorde leuchten auf");
  await app.waitFor(() => {
    const r = T.$(".hc-sketch").getBoundingClientRect();
    const box = T.$(".hc-sketch").closest(".tab-body, kw-panel")?.getBoundingClientRect() ?? { top: 0, bottom: innerHeight };
    return r.top >= box.top - 1 && r.top < box.bottom;
  }, { what: "Verlauf im Bild" });
});

test("Kadenzkarte „In Spur“: anhängen und gleich vierstimmig in die Spur schreiben", async () => {
  await app.reset();
  await clearSketch();
  await app.clickOn(".hc-cadcard .btn", { text: "In Spur" });
  const t = await app.waitFor(() => T.st.snapshot.peek().project.tracks.find((t) => t.name === "Akkorde") ?? null, { what: "Spur Akkorde" });
  // geschrieben wird der ganze noch nicht geschriebene Verlauf: Tonika + Kadenz
  const chords = (await sketch()).length;
  const notes = t.clips.reduce((a, c) => a + c.source.notes.length, 0);
  assert.equal(notes, 4 * chords, `${chords} Akkorde × 4 Stimmen`);
  await app.waitFor((n) => T.$$(".hc-chip.fixed").length === n, { what: "alle Akkorde als „in der Spur“ markiert" }, chords);
});

test("Legende: Maus über einer Stimmung blendet die anderen aus", async () => {
  await clearSketch();
  const item = await app.center(".hc-lg.m-dunkel");
  await app.mouse("mouseMoved", item.x, item.y);
  await sleep(100);
  const r = await app.eval(() => ({
    faded: T.$$(".harmony .faded").map((e) => e.dataset.mood),
    kept: T.$$(".harmony [data-mood]:not(.faded)").map((e) => e.dataset.mood),
  }));
  assert.ok(r.faded.length > 0 && !r.faded.includes("dunkel"), JSON.stringify(r));
  assert.ok(r.kept.every((m) => m === "dunkel"));
  await app.mouse("mouseMoved", 5, 500);
  await sleep(100);
  assert.equal(await app.eval(() => T.$$(".harmony .faded").length), 0);
});

test("a-Moll: phrygischer Halbschluss über iv⁶", async () => {
  await app.eval(async () => {
    const sel = T.$("kw-panel[tab='harmonie'] .hc-select");
    sel.value = "9:m";
    sel.dispatchEvent(new Event("change"));
    await T.waitFor(() => T.$(".hc-key")?.textContent === "a-Moll");
  });
  await clearSketch();
  const phr = await app.waitFor(() => {
    const p = T.$$(".hc-path").find((r) => r.querySelector(".hc-plabel").textContent.startsWith("Phryg"));
    return p ? [...p.querySelectorAll(".hc-pchip span")].map((s) => s.textContent) : null;
  }, { what: "phrygischer Weg" });
  assert.ok(phr.includes("iv⁶"), JSON.stringify(phr));
  assert.equal(phr.at(-1), "V");
});

test("Agent: suggest_chords liefert Stimmung und Wege zum Schluss", async () => {
  const r = await app.mcp("suggest_chords", { key: "C-Dur", chords: ["C", "a"] });
  assert.ok(r.vorschlaege.every((v) => ["lösend", "spannend", "überraschend", "hell", "dunkel"].includes(v.stimmung)));
  const ziele = r.wegeZumSchluss.map((w) => w.schluss);
  for (const z of ["Ganzschluss", "Plagalschluss", "Halbschluss", "Trugschluss"]) assert.ok(ziele.includes(z), z);
  for (const w of r.wegeZumSchluss) assert.equal(w.stimmungen.length, w.akkorde.length);
});

test("keine Fehler im Fenster", () => {
  assert.deepEqual(app.errors, []);
});

test("Wege zum Schluss: Übergangswahrscheinlichkeit aus der Bibliothek steht sichtbar unter jedem Pfeil", async () => {
  // Zahlen der Bibliothek unterschieben – das Testprojekt hat keine Akkordstatistik
  await app.eval(async () => {
    const { backend } = await import("./bridge.js");
    const orig = backend.harmonySuggest.bind(backend);
    window.__origSuggest = orig;
    backend.harmonySuggest = async (...a) => {
      const r = await orig(...a);
      for (const p of r.paths ?? []) p.shares = p.steps.map((_, i) => [0.48, 0.07, 0.33, 0.2][i % 4]);
      return r;
    };
    T.st.showPanel("harmonie");
  });
  // neu laden lassen: Tonart umschalten und zurück
  await app.eval(async () => {
    const sel = T.$("kw-panel[tab=harmonie] .hc-head select");
    const v = sel.value;
    sel.value = [...sel.options].find((o) => o.value !== v).value;
    sel.dispatchEvent(new Event("change"));
    await T.sleep(300);
    sel.value = v;
    sel.dispatchEvent(new Event("change"));
  });
  await app.waitFor(() => T.$$("kw-panel[tab=harmonie] .hc-path .hc-pct").length > 0, { what: "Prozente an den Pfeilen", timeout: 10000 });
  const labels = await app.eval(() => [...T.$("kw-panel[tab=harmonie] .hc-path").querySelectorAll(".hc-pct")].map((x) => x.textContent));
  assert.ok(labels.length >= 1 && labels.every((l) => /^\d+(,\d)? %$/.test(l)), labels.join(" | "));
  assert.ok(labels.includes("48 %"), labels.join(" | "));
  await app.eval(async () => {
    const { backend } = await import("./bridge.js");
    backend.harmonySuggest = window.__origSuggest;
  });
});

test("Breites Harmonie-Fenster: Wege zum Schluss rechts, der Zirkel bleibt beim Scrollen stehen", async () => {
  await app.eval(() => T.st.showPanel("harmonie"));
  await app.waitFor(() => T.$$("kw-panel[tab=harmonie] .hc-path").length > 0, { what: "Wege" });
  // schmal (Standard rechts): Wege unter dem Zirkel
  const narrow = await app.eval(() => ({ cols: getComputedStyle(T.$(".hc-body")).gridTemplateColumns.split(" ").length, inLeft: !!T.$(".hc-left .hc-paths") }));
  if (narrow.cols === 1) assert.equal(narrow.inLeft, true, "schmal: Wege links unter dem Zirkel");
  // breit machen: das Fenster schwebend und groß
  await app.eval(() => {
    const panel = T.$("kw-panel[tab=harmonie]");
    panel.style.width = "980px";
  });
  await app.waitFor(() => !!T.$(".hc-side .hc-paths"), { what: "Wege rechts" });
  const wide = await app.eval(() => {
    const body = T.$("kw-panel[tab=harmonie] .tab-body");
    const before = T.$(".hc-circle").getBoundingClientRect().top;
    body.scrollTop = 300;
    return new Promise((res) => requestAnimationFrame(() => res({
      cols: getComputedStyle(T.$(".hc-body")).gridTemplateColumns.split(" ").length,
      sticky: getComputedStyle(T.$(".hc-left")).position,
      moved: Math.abs(T.$(".hc-circle").getBoundingClientRect().top - before),
      scrolled: body.scrollTop,
    })));
  });
  assert.equal(wide.cols, 2);
  assert.equal(wide.sticky, "sticky");
  if (wide.scrolled > 50) assert.ok(wide.moved < wide.scrolled, `Zirkel bleibt stehen (${wide.moved} px bei ${wide.scrolled} px Scrollen)`);
  // wieder schmal: Wege zurück unter den Zirkel
  await app.eval(() => {
    T.$("kw-panel[tab=harmonie] .tab-body").scrollTop = 0;
    T.$("kw-panel[tab=harmonie]").style.width = "";
  });
  if (narrow.cols === 1) await app.waitFor(() => !!T.$(".hc-left .hc-paths"), { what: "Wege wieder links" });
});

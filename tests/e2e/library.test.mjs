// Bibliothek: leere „Standard“ beim Start, Ordner hinzufügen (Doppelte einmal),
// Melodie- und Titelsuche, Partitur öffnen,
// Stimmen wählen (Klick, Strg+Klick, „Alle Stimmen“), Anhören ↔ Stopp ab dem
// Cursor (bis gestoppt wird), Zeitfenster in Schleife, Tempo für Anhören und
// Übernehmen, Stimmen als Spuren übernehmen, Stöbern, Agent-Suche.
import { before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startApp, makeTest, MOD, sleep } from "./harness.mjs";
import { CHORAL_MELODY, PIECES, writePieces } from "./fixtures.mjs";

/** Länge des Testchorals in Vierteln. */
const CHORAL_QUARTERS = PIECES[0].parts[0].notes.reduce((a, n) => a + Number(n.split(":")[1] ?? 1), 0);

let app;
const test = makeTest(() => app);
before(async () => {
  app = await startApp();
});
after(async () => {
  await app?.close();
});

const voices = () => app.eval(() => T.$$(".lib-voice").map((c) => (c.classList.contains("on") ? "✓" : "·") + c.firstChild?.nextSibling?.textContent));
const playBtn = () => app.eval(() => T.$(".lib-selbar .btn")?.textContent ?? null);
const takeBtn = () => app.eval(() => T.$(".lib-voices .btn.primary")?.textContent ?? null);
const tempoVal = () => app.eval(() => Number(T.$(".lib-tempo-in").value));
/** Punkt in der Notenrolle bei Viertel `q` (links, nicht gerollt). */
const rollAt = (q) => app.eval((q, total) => {
  T.$(".lib-roll-wrap").scrollLeft = 0;
  T.$(".lib-roll").scrollIntoView({ block: "center" });
  const b = T.$(".lib-roll").getBoundingClientRect();
  return [b.x + (b.width / total) * q, b.y + b.height / 2];
}, q, CHORAL_QUARTERS);

async function openChoral() {
  await app.eval(async (mel) => {
    T.$$(".lib-mode .seg-btn").find((b) => b.textContent.includes("Suchen"))?.click();
    const m = T.$(".lib-search input.mono");
    m.value = mel;
    T.$(".lib-search input:not(.mono)").value = "";
    T.$$(".lib-search .btn").find((b) => b.textContent.trim() === "Suchen").click();
    await T.waitFor(() => T.$$(".lib-hit").length);
    T.$$(".lib-hit").find((h) => h.textContent.includes("Testchoral")).click();
    await T.waitFor(() => T.$(".lib-title")?.textContent.includes("Testchoral") && T.$$(".lib-voice").length === 3);
  }, CHORAL_MELODY);
}

const libInfo = () => app.eval(() => window.__TAURI__.core.invoke("library_info"));
/** Wartet, bis kein Auftrag der Bibliothek mehr läuft. */
const idle = (what, timeout = 60000) =>
  app.waitFor(async () => {
    const i = await window.__TAURI__.core.invoke("library_info");
    return !i.loading && !i.adding && !i.building && i.merging == null && !i.download ? i : null;
  }, { timeout, what });

// Fehlerbericht: von Hand gestartet zeigte die Bibliothek einen Pfad, den man nicht ändern
// konnte, und lud nur das zuletzt heruntergeladene Paket. Jetzt: genau eine aktive Bibliothek
// (beim ersten Start die leere „Standard“), vom Programm gemerkt, ohne Pfadfeld.
test("Beim Start ist „Standard“ aktiv – Name statt Pfad, leer zeigt den Katalog", async () => {
  const info = await idle("Bibliothek geladen", 20000);
  assert.equal(info.id, "standard");
  assert.equal(info.name, "Standard");
  assert.equal(info.scores, 0);
  assert.equal(info.path, undefined, "kein Pfad mehr in der Info");
  await app.eval(() => T.st.showPanel("bibliothek"));
  await app.waitFor(() => T.$(".lib-name b")?.textContent === "Standard", { what: "Name in der Leiste" });
  assert.equal(await app.eval(() => T.$(".lib-bar").querySelectorAll("input").length), 0, "kein Pfadfeld");
  assert.equal(await app.eval(() => T.$$(".lib-bar .btn").some((b) => /Ordner indizieren|Index laden/.test(b.textContent))), false);
  await app.waitFor(() => !!T.$(".lib-catalog:not([hidden])"), { what: "Katalog öffnet sich bei leerer Bibliothek" });
  await app.eval(() => T.$(".lib-catalog-head .btn").click());
  // Liste und Indexdatei liegen im Bibliotheksordner (Tests: eigener Ordner)
  const root = join(app.tmp, "bibliothek");
  const reg = JSON.parse(readFileSync(join(root, "bibliotheken.json"), "utf8"));
  assert.equal(reg.active, "standard");
  assert.deepEqual(reg.libraries.map((l) => l.name), ["Standard"]);
  assert.ok(existsSync(join(root, "Indizes", reg.libraries[0].file)), "Indexdatei angelegt");
});

test("Hinzufügen: ein Ordner landet in „Standard“", async () => {
  const dir = writePieces(join(app.tmp, "noten"));
  await app.clickOn(".lib-bar .btn", { text: "Hinzufügen" });
  await app.waitFor(() => !!T.$(".lib-addbox:not([hidden]) input"), { what: "Feld zum Hinzufügen" });
  assert.match(await app.eval(() => T.$(".lib-addbox .muted").textContent), /In „Standard“ aufnehmen/);
  await app.eval((d) => {
    T.$(".lib-addbox input").value = d;
    T.$$(".lib-addbox .btn").find((b) => b.textContent.includes("Hinzufügen")).click();
  }, dir);
  const info = await app.waitFor(async () => {
    const i = await window.__TAURI__.core.invoke("library_info");
    return i.scores === 2 && !i.adding && i.merging == null ? i : null;
  }, { timeout: 60000, what: "übernommen" });
  assert.equal(info.voices, 5);
  assert.equal(await app.eval(() => T.$(".lib-addbox").hidden), true, "Feld schließt sich");
  await app.waitFor(() => /2 Partituren übernommen/.test(T.$(".lib-status").textContent), { what: "Statuszeile" });
  assert.match(await app.eval(() => T.$(".lib-status").textContent), /„Standard“ hat jetzt 2 Partituren/);
  const reg = JSON.parse(readFileSync(join(app.tmp, "bibliothek", "bibliotheken.json"), "utf8"));
  assert.equal(reg.libraries[0].scores, 2);
  assert.equal(reg.libraries[0].paths.length, 1, "Ordner vermerkt (für „Neu aufbauen“)");
});

test("Nochmal hinzufügen: schon Enthaltenes kommt nicht doppelt", async () => {
  const dir = join(app.tmp, "noten");
  await app.mcp("add_to_library", { paths: [join(dir, "testchoral.musicxml"), dir] });
  const info = await idle("fertig");
  assert.equal(info.scores, 2);
  assert.match(info.message, /Nichts Neues, 2 schon enthalten/);
});

test("Melodiesuche findet den Choral, Öffnen wählt die Treffer-Stimme", async () => {
  await openChoral();
  assert.deepEqual(await voices(), ["✓Sopran", "·Alt", "·Bass"]);
  assert.match(await playBtn(), /^Ab T\. 1 · Sopran$/);
  assert.equal(await takeBtn(), "Stimme als Spur");
  assert.equal(await app.eval(() => T.$(".lib-allvoices")?.classList.contains("on")), false);
});

test("Klick wählt eine Stimme, Strg+Klick mehrere, mindestens eine bleibt", async () => {
  await app.clickOn(".lib-voice", { text: "Bass" });
  assert.deepEqual(await voices(), ["·Sopran", "·Alt", "✓Bass"]);
  await app.clickOn(".lib-voice", { text: "Alt", mods: MOD.ctrl });
  assert.deepEqual(await voices(), ["·Sopran", "✓Alt", "✓Bass"]);
  assert.match(await playBtn(), /· 2 Stimmen$/);
  assert.equal(await takeBtn(), "2 Stimmen als Spuren");
  await app.clickOn(".lib-voice", { text: "Alt", mods: MOD.ctrl });
  await app.clickOn(".lib-voice", { text: "Bass", mods: MOD.ctrl }); // letzte bleibt
  assert.deepEqual(await voices(), ["·Sopran", "·Alt", "✓Bass"]);
});

test("Kästchen „Alle Stimmen“ wählt alle – und zurück zur Treffer-Stimme", async () => {
  await app.clickOn(".lib-allvoices");
  assert.deepEqual(await voices(), ["✓Sopran", "✓Alt", "✓Bass"]);
  assert.equal(await app.eval(() => T.$(".lib-allvoices").classList.contains("on")), true);
  assert.match(await playBtn(), /· alle Stimmen$/);
  assert.equal(await takeBtn(), "3 Stimmen als Spuren");
  await app.clickOn(".lib-allvoices");
  assert.deepEqual(await voices(), ["✓Sopran", "·Alt", "·Bass"]);
});

test("Anhören wird zum Stopp-Knopf; Klick darauf stoppt", async () => {
  await app.clickOn(".lib-selbar .btn");
  assert.equal(await playBtn(), "Stopp");
  await app.waitFor(() => T.st.status.peek().previewing === true, { what: "Vorhören läuft" });
  // die Abspiellinie läuft mit
  await app.waitFor(() => !T.$(".lib-playhead").hidden && parseFloat(T.$(".lib-playhead").style.left) > 0, { what: "Abspiellinie" });
  await app.clickOn(".lib-selbar .btn");
  assert.match(await playBtn(), /^Ab T\. 1/);
  await app.waitFor(() => T.st.status.peek().previewing === false, { what: "Vorhören beendet" });
  assert.equal(await app.eval(() => T.$(".lib-playhead").hidden), true);
});

test("Stimmen umwählen während der Wiedergabe: spielt an derselben Stelle weiter", async () => {
  const head = () => app.eval(() => (T.$(".lib-playhead").hidden ? null : parseFloat(T.$(".lib-playhead").style.left)));
  await app.clickOn(".lib-selbar .btn");
  await app.waitFor(() => T.st.status.peek().previewing === true, { what: "Vorhören läuft" });
  await app.waitFor(() => !T.$(".lib-playhead").hidden && parseFloat(T.$(".lib-playhead").style.left) > 20, { what: "Linie läuft" });
  const before = await head();
  await app.clickOn(".lib-voice", { text: "Alt" });
  assert.deepEqual(await voices(), ["·Sopran", "✓Alt", "·Bass"]);
  assert.equal(await playBtn(), "Stopp", "läuft weiter");
  const after = await app.waitFor(() => (!T.$(".lib-playhead").hidden ? parseFloat(T.$(".lib-playhead").style.left) : null), { what: "Linie nach dem Umwählen" });
  assert.ok(after >= before - 1, `nicht wieder von vorn: ${after} ≥ ${before}`);
  assert.equal(await app.eval(() => T.st.status.peek().previewing), true);
  await app.clickOn(".lib-voice", { text: "Sopran" });
  assert.equal(await playBtn(), "Stopp");
  await app.clickOn(".lib-selbar .btn");
  await app.waitFor(() => T.st.status.peek().previewing === false, { what: "Vorhören beendet" });
  assert.match(await playBtn(), /^Ab T. 1 · Sopran$/);
});

test("Klick in die Notenrolle setzt den Cursor; abgespielt wird ab dort", async () => {
  const bar = 4; // 4/4
  const [x, y] = await rollAt(bar + 0.5);
  await app.click(x, y);
  assert.match(await playBtn(), /^Ab T\. 2 · Sopran$/);
  const left = await app.eval(() => parseFloat(T.$(".lib-cursor").style.left));
  const expect = await app.eval((q, total) => (T.$(".lib-roll").clientWidth / total) * q, bar, CHORAL_QUARTERS);
  assert.ok(Math.abs(left - expect) < 2, `Cursor am Taktanfang: ${left} statt ${expect}`);
  // Anfang der Abspiellinie = Cursor
  await app.clickOn(".lib-selbar .btn");
  const head = await app.waitFor(() => (!T.$(".lib-playhead").hidden ? parseFloat(T.$(".lib-playhead").style.left) : null), { what: "Abspiellinie" });
  assert.ok(head >= left - 1, `Linie startet am Cursor: ${head} ≥ ${left}`);
  await app.clickOn(".lib-selbar .btn");
  const [x0] = await rollAt(0.2);
  await app.click(x0, y);
  assert.match(await playBtn(), /^Ab T\. 1/);
});

test("Tempo: Regler ändert das Tempo, „Original“ setzt es zurück", async () => {
  const orig = await tempoVal();
  assert.ok(orig > 0);
  assert.equal(await app.eval(() => T.$(".lib-tempo-orig").hidden), true);
  await app.clickOn(".lib-tempo .btn", { text: "+" });
  assert.equal(await tempoVal(), Math.round(orig * 1.1));
  assert.equal(await app.eval(() => T.$(".lib-tempo").classList.contains("changed")), true);
  // während es klingt, gilt ein neues Tempo sofort (es läuft weiter)
  await app.clickOn(".lib-selbar .btn");
  await app.waitFor(() => T.st.status.peek().previewing === true, { what: "Vorhören läuft" });
  await app.clickOn(".lib-tempo .btn", { text: "−" });
  assert.equal(await playBtn(), "Stopp");
  await app.clickOn(".lib-selbar .btn");
  await app.clickOn(".lib-tempo-orig");
  assert.equal(await tempoVal(), orig);
  assert.equal(await app.eval(() => T.$(".lib-tempo-orig").hidden), true);
});

test("Zeitfenster markieren: Knopf heißt „Markierung“, sie läuft in Schleife, bis gestoppt wird", async () => {
  const r = await app.eval(() => {
    T.$(".lib-roll-wrap").scrollLeft = 0;
    T.$(".lib-roll").scrollIntoView({ block: "center" });
    const b = T.$(".lib-roll").getBoundingClientRect();
    return { x: b.x, y: b.y + b.height / 2, w: b.width };
  });
  // Die Notenrolle zeigt die ganze Partitur über ihre Breite
  const qw = r.w / CHORAL_QUARTERS;
  await app.drag([r.x + qw * 0.1, r.y], [r.x + qw * 1.1, r.y]);
  assert.match(await app.eval(() => T.$(".lib-selinfo").textContent), /^Markiert: T\. 1–1 · 1 Viertel$/);
  assert.match(await playBtn(), /^Markierung · Sopran$/);
  assert.equal(await takeBtn(), "Abschnitt als Spur");
  await app.clickOn(".lib-selbar .btn");
  assert.equal(await playBtn(), "Stopp");
  await app.waitFor(() => T.st.status.peek().previewing === true, { what: "Vorhören läuft" });
  // ein Viertel ist längst vorbei – es klingt aber weiter
  await app.eval(() => T.sleep(2500));
  assert.equal(await app.eval(() => T.st.status.peek().previewing), true, "Schleife läuft weiter");
  assert.equal(await playBtn(), "Stopp");
  await app.clickOn(".lib-selbar .btn");
  assert.match(await playBtn(), /^Markierung/);
  await app.waitFor(() => T.st.status.peek().previewing === false, { what: "Vorhören beendet" });
});

test("Zeitleiste: Taktzahlen, Strg+Mausrad zoomt, Ziehen wandert in der Zeit, Klick setzt den Cursor", async () => {
  const geo = () => app.eval(() => {
    const w = T.$(".lib-roll-wrap");
    const r = T.$(".lib-ruler").getBoundingClientRect();
    return { left: w.scrollLeft, cw: w.clientWidth, sw: w.scrollWidth, x: r.x, y: r.y + r.height / 2, w: r.width, h: r.height };
  });
  await app.eval(() => {
    T.$(".lib-roll-wrap").scrollLeft = 0;
    T.$(".lib-roll-wrap").scrollIntoView({ block: "center" });
  });
  let g = await geo();
  assert.equal(g.h, 22, "Zeitleiste über der Rolle");
  assert.ok(g.sw <= g.cw + 1, "kurzes Stück füllt die Breite");
  // Strg+Mausrad über der Rolle: hineinzoomen – erst wenn das Fenster nach dem
  // Scrollen ruhig steht; ein zu früher Stoß wird einmal wiederholt
  await app.waitFor(async () => {
    const a = T.$(".lib-ruler").getBoundingClientRect().y;
    await T.sleep(120);
    return Math.abs(T.$(".lib-ruler").getBoundingClientRect().y - a) < 0.5;
  }, { what: "Rolle steht" });
  g = await geo();
  for (let round = 0; round < 2 && (await geo()).sw <= g.cw * 1.5; round++) {
    await app.mouse("mouseMoved", g.x + 40, g.y + 60);
    await sleep(100);
    for (let i = 0; i < 14; i++) {
      await app.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: g.x + 40, y: g.y + 60, deltaX: 0, deltaY: -240, modifiers: 2 });
      await sleep(30);
    }
    await sleep(200);
  }
  const under = await app.eval((x, y) => {
    const e = document.elementFromPoint(x, y);
    return e ? `${e.className} < ${e.parentElement?.className}` : "nichts";
  }, g.x + 40, g.y + 60);
  g = await geo();
  assert.ok(g.sw > g.cw * 1.5, `hineingezoomt: ${g.sw} > 1,5 × ${g.cw} (unter der Maus: ${under})`);
  // Ziehen auf der Zeitleiste: die Zeit wandert mit der Maus
  const before = g.left;
  await app.drag([g.x + 300, g.y], [g.x + 150, g.y], { steps: 6 });
  g = await geo();
  assert.ok(Math.abs(g.left - before - 150) < 12, `150 px weiter: ${before} → ${g.left}`);
  // Mausrad ohne Strg: blättert ebenfalls in der Zeit
  await app.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: g.x + 40, y: g.y + 60, deltaX: 0, deltaY: 120 });
  await sleep(150);
  const after = (await geo()).left;
  assert.ok(after > g.left + 50, `Mausrad blättert: ${g.left} → ${after}`);
  // Klick auf die Zeitleiste setzt den Cursor dorthin – auf den Anfang der Viertel
  g = await geo();
  await app.click(g.x + 100, g.y);
  const cur = await app.eval(() => parseFloat(T.$(".lib-cursor").style.left));
  const qw = g.sw / CHORAL_QUARTERS;
  const at = g.left + 100;
  assert.ok(cur <= at + 1 && cur > at - qw - 1, `Cursor an der Klickstelle: ${cur} (Klick bei ${at}, Viertel ${qw.toFixed(0)} px)`);
  // die Taktzahlen der Zeitleiste stehen im gezoomten Ausschnitt (Bild nicht leer)
  const painted = await app.eval(() => {
    const c = T.$(".lib-ruler");
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    let max = 0;
    for (let i = 0; i < d.length; i += 4) {
      max = Math.max(max, d[i]);
      if (d[i] > 100) n++;
    }
    return { n, max, w: c.width, h: c.height, sl: T.$(".lib-roll-wrap").scrollLeft, sw: T.$(".lib-roll-wrap").scrollWidth };
  });
  assert.ok(painted.n > 3 && painted.max > 120, `Taktzahlen gezeichnet: ${JSON.stringify(painted)}`);
  // wieder ganz herauszoomen (die folgenden Tests rechnen mit der ganzen Breite)
  for (let i = 0; i < 12; i++) {
    await app.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: g.x + 40, y: g.y + 60, deltaX: 0, deltaY: 400, modifiers: 2 });
  }
  await sleep(200);
  g = await geo();
  assert.ok(g.sw <= g.cw + 1 && g.left === 0, "wieder die ganze Partitur");
  await app.eval(() => T.$(".lib-roll").scrollIntoView({ block: "center" }));
  const [x0, y0] = await rollAt(0.2);
  await app.click(x0, y0);
});

test("Abschnitt als Spur: nur der markierte Ausschnitt, Takte im Namen", async () => {
  const n0 = await app.eval(() => T.st.snapshot.peek().project.tracks.length);
  await app.clickOn(".lib-voices .btn.primary");
  const t = await app.waitFor((n0) => {
    const ts = T.st.snapshot.peek().project.tracks;
    return ts.length > n0 ? ts.at(-1) : null;
  }, { what: "neue Spur" }, n0);
  assert.equal(t.name, "Testchoral – Sopran (T. 1–1)");
  assert.deepEqual(t.clips[0].source.notes.map((n) => [n.pitch, n.startBeats]), [[60, 0]]);
  await app.clickOn(".lib-selbar .btn.ghost[title='Markierung aufheben']");
});

test("Übernehmen im gewählten Tempo: auf das Projekttempo umgerechnet", async () => {
  await app.eval(() => T.st.act(window.__TAURI__.core.invoke("project_new")));
  const bpm = await app.eval(() => T.st.snapshot.peek().project.tempoBpm);
  const take = async () => {
    const n0 = await app.eval(() => T.st.snapshot.peek().project.tracks.length);
    await app.clickOn(".lib-voices .btn.primary");
    const t = await app.waitFor((n0) => {
      const ts = T.st.snapshot.peek().project.tracks;
      return ts.length > n0 ? ts.at(-1) : null;
    }, { what: "neue Spur" }, n0);
    return t.clips[0].source.notes.slice(0, 2).map((n) => [n.startBeats, n.lengthBeats]);
  };
  // „Projekt“: ein Viertel = ein Schlag
  await app.clickOn(".lib-tempo-proj");
  assert.equal(await tempoVal(), bpm);
  assert.deepEqual(await take(), [[0, 1], [1, 1]]);
  // halb so schnell wie das Projekt: jedes Viertel zwei Schläge
  await app.eval((v) => {
    const i = T.$(".lib-tempo-in");
    i.value = String(v);
    i.dispatchEvent(new Event("change"));
  }, bpm / 2);
  assert.deepEqual(await take(), [[0, 2], [2, 2]]);
  await app.clickOn(".lib-tempo-orig");
  await app.eval(() => T.st.act(window.__TAURI__.core.invoke("project_new")));
});

test("Mehrere Stimmen als Spuren: je Stimme eine Spur, ein Undo-Schritt", async () => {
  await app.eval(() => T.st.act(window.__TAURI__.core.invoke("project_new")));
  await app.clickOn(".lib-voice", { text: "Alt", mods: MOD.ctrl });
  await app.clickOn(".lib-voices .btn.primary");
  const names = await app.waitFor(() => {
    const ts = T.st.snapshot.peek().project.tracks;
    return ts.length === 2 ? ts.map((t) => t.name) : null;
  }, { what: "zwei Spuren" });
  assert.deepEqual(names, ["Testchoral – Sopran", "Testchoral – Alt"]);
  assert.match(await app.eval(() => T.st.snapshot.peek().undoLabel), /2 Stimmen aus Bibliothek/);
  await app.eval(() => T.st.act(window.__TAURI__.core.invoke("undo")));
  assert.equal(await app.eval(() => T.st.snapshot.peek().project.tracks.length), 0);
});

test("Titelsuche findet das Duett", async () => {
  const hits = await app.eval(async () => {
    T.$(".lib-search input:not(.mono)").value = "Duett";
    T.$(".lib-search input.mono").value = "";
    T.$$(".lib-search .btn").find((b) => b.textContent.trim() === "Suchen").click();
    await T.waitFor(() => T.$$(".lib-hit").some((h) => h.textContent.includes("Duett")));
    return T.$$(".lib-hit").map((h) => h.querySelector(".t").textContent);
  });
  assert.ok(hits.every((h) => h.includes("Duett")), JSON.stringify(hits));
});

test("Stöbern zeigt die Stücke im Baum", async () => {
  const shown = await app.eval(async () => {
    T.$$(".lib-mode .seg-btn").find((b) => b.textContent.includes("Stöbern")).click();
    await T.waitFor(() => T.$(".tree-head"));
    return T.$(".tree-head").textContent;
  });
  assert.match(shown, /^2 Partituren/);
  await app.eval(() => T.$$(".lib-mode .seg-btn").find((b) => b.textContent.includes("Suchen")).click());
});

// Fehlerbericht: im kleinen Fenster war das Ende des Download-Katalogs nicht erreichbar.
test("Download-Katalog im kleinen Fenster: endet im Fenster und rollt bis zur letzten Karte", async () => {
  await app.send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 640, deviceScaleFactor: 1, mobile: false });
  try {
    await app.eval(() => {
      T.st.showPanel("bibliothek");
      if (!T.$(".lib-catalog:not([hidden])")) T.$$(".lib-bar .btn").find((b) => b.textContent.includes("Herunterladen")).click();
    });
    await app.waitFor(() => T.$$(".lib-card-foot .btn").filter((b) => b.offsetParent).length > 0, { what: "Katalog" });
    const r = await app.eval(async () => {
      const box = T.$(".lib-catalog").closest(".tab-body").getBoundingClientRect();
      const scroller = T.$(".lib-catalog > :not(.lib-catalog-head)");
      scroller.scrollTop = scroller.scrollHeight;
      await T.sleep(150);
      const cat = T.$(".lib-catalog").getBoundingClientRect();
      const last = T.$$(".lib-card-foot .btn").filter((b) => b.offsetParent).at(-1).getBoundingClientRect();
      return { box: [box.top, box.bottom], cat: [cat.top, cat.bottom], last: [last.top, last.bottom], rollt: scroller.scrollHeight > scroller.clientHeight };
    });
    assert.ok(r.cat[1] <= r.box[1] + 1, `Katalog endet im Fenster: ${JSON.stringify(r)}`);
    assert.ok(r.last[1] <= r.cat[1] + 1 && r.last[0] >= r.cat[0], `letzter Knopf sichtbar: ${JSON.stringify(r)}`);
    assert.ok(r.rollt, "im kleinen Fenster rollt der Katalog in sich");
  } finally {
    await app.eval(() => T.$(".lib-catalog-head .btn")?.click());
    await app.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  }
});

test("Agent: search_melody findet den Choral – auch transponiert", async () => {
  // Sopran-Anfang eine Quarte höher: die Suche ist unabhängig von der Tonart
  const midi = [60, 62, 64, 65, 67, 67, 69, 69, 69, 69, 67].map((m) => m + 5);
  const dur = [1, 1, 1, 1, 2, 2, 1, 1, 1, 1, 4];
  const r = await app.mcp("search_melody", { notes: midi.map((m, i) => ({ midi: m, duration: dur[i] })) });
  assert.match(JSON.stringify(r), /Testchoral/);
});

test("keine Fehler im Fenster", () => {
  assert.deepEqual(app.errors, []);
});

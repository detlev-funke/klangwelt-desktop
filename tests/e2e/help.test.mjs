// Context help and intro tour: The help window shows the detailed text
// for the element under the mouse; F1 pins it (lock) and opens the
// window even if it was closed. Every control has a
// tooltip. The intro tour on the empty page goes through all windows.
import { before, after } from "node:test";
import assert from "node:assert/strict";
import { startApp, makeTest, injectHelpers } from "./harness.mjs";

let app;
const test = makeTest(() => app);
before(async () => {
  app = await startApp();
});
after(async () => {
  await app?.close();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Moves the mouse over an element (center or offset). */
async function hover(selector, { dy = 0, fy } = {}) {
  const r = await app.eval((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    const b = el.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y, h: b.height };
  }, selector);
  if (!r) throw new Error(`fehlt: ${selector}`);
  const y = fy != null ? r.y + r.h * fy : r.y + r.h / 2 + dy;
  await app.mouse("mouseMoved", r.x, y);
  await sleep(120);
}

const helpTitle = () => app.eval(() => T.$("kw-help .help-title")?.textContent ?? null);
const helpVisible = () => app.eval(() => {
  const el = T.$("kw-help");
  return !!el && el.getBoundingClientRect().width > 0;
});

test("help is closed at first; F1 opens it and pins the text for the element under the mouse", async () => {
  await app.reset();
  assert.equal(await helpVisible(), false, "startet geschlossen");
  // the Export entry of the File menu
  await app.clickOn("kw-transport .file-btn");
  await hover(".file-menu.open .mi-export");
  await app.key("F1");
  await app.waitFor(() => T.$("kw-help .help-title")?.textContent === "Exportieren", { what: "Hilfe zu Exportieren" });
  assert.equal(await app.eval(() => T.$("kw-help").classList.contains("frozen")), true, "festgehalten");
  assert.equal(await app.eval(() => T.$("kw-help .help-lock").classList.contains("on")), true, "Schloss sichtbar");
  assert.match(await app.eval(() => T.$("kw-help .help-text").textContent), /Opus/);
  assert.match(await app.eval(() => T.$("kw-help .help-keys").textContent), /Strg\+E/);
  // frozen: other elements change nothing
  await hover(".save-btn");
  assert.equal(await helpTitle(), "Exportieren");
  // F1 on another element: now pins that one
  await app.key("F1");
  assert.equal(await helpTitle(), "Speichern");
  // F1 once more on the same one: releases – then the help follows the mouse again
  await app.key("F1");
  assert.equal(await app.eval(() => T.$("kw-help").classList.contains("frozen")), false);
  await app.eval(() => document.querySelectorAll(".menu.open").forEach((m) => m.classList.remove("open")));
  await hover("[data-help=metronom]");
  assert.equal(await helpTitle(), "Metronom");
});

test("follows the mouse: tooltips, window entries, ruler and tracks separate; not over itself", async () => {
  await app.reset();
  await app.mcp("create_instrument_track", { kind: "pluck" });
  await app.eval(() => T.st.act(window.__TAURI__.core.invoke("get_state")));
  if (!(await helpVisible())) {
    await app.key("F1");
    await app.key("F1");
  }
  await hover(".harmony-toggle");
  assert.equal(await helpTitle(), "Harmonie in der Zeitleiste");
  const ruler = await app.eval(() => {
    const b = T.$("kw-timeline canvas").getBoundingClientRect();
    return { x: b.x + b.width / 2, top: b.y };
  });
  await app.mouse("mouseMoved", ruler.x, ruler.top + 10);
  await sleep(120);
  assert.equal(await helpTitle(), "Lineal");
  await app.mouse("mouseMoved", ruler.x, ruler.top + 70);
  await sleep(120);
  assert.equal(await helpTitle(), "Zeitleiste");
  // Element without its own entry: tooltip on top, the window below
  await app.eval(() => T.st.showPanel("song"));
  await app.waitFor(() => T.$(".song-play"), { what: "Song-Fenster" });
  await hover(".song-play");
  assert.equal(await helpTitle(), "Fenster „Song“");
  assert.equal(await app.eval(() => T.$("kw-help .help-tip").textContent), "Von vorn abspielen");
  // over the help window the text stays put
  await hover("kw-help .help-text");
  assert.equal(await helpTitle(), "Fenster „Song“");
  // Click on the lock pins, another click releases
  await app.clickOn("kw-help .help-lock");
  assert.equal(await app.eval(() => T.$("kw-help").classList.contains("frozen")), true);
  await hover(".save-btn");
  assert.equal(await helpTitle(), "Fenster „Song“");
  await app.clickOn("kw-help .help-lock");
  await hover(".save-btn");
  assert.equal(await helpTitle(), "Speichern");
});

test("closed help window: F1 brings it back", async () => {
  if (!(await helpVisible())) await app.key("F1");
  const tab = await app.center(".dk-tab[data-panel=hilfe]");
  await app.click(tab.x, tab.y, { button: "middle" });
  await app.waitFor(() => !T.$("kw-help") || T.$("kw-help").getBoundingClientRect().width === 0, { what: "Hilfe zu" });
  await hover(".save-btn");
  await app.key("F1");
  await app.waitFor(() => T.$("kw-help")?.getBoundingClientRect().width > 0, { what: "Hilfe wieder offen" });
  assert.equal(await helpTitle(), "Speichern");
  // F1 also works while typing in a field
  await app.key("F1"); // release
  await app.eval(() => T.$("[data-help=tempo] input").focus());
  await app.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "F1", code: "F1", windowsVirtualKeyCode: 112, nativeVirtualKeyCode: 112 });
  await app.send("Input.dispatchKeyEvent", { type: "keyUp", key: "F1", code: "F1", windowsVirtualKeyCode: 112, nativeVirtualKeyCode: 112 });
  await sleep(150);
  assert.equal(await app.eval(() => T.$("kw-help").classList.contains("frozen")), true);
});

test("every visible control has a tooltip (itself or on its frame)", async () => {
  await app.reset();
  const missing = async (where) => app.eval((w) => {
    const roots = w === "leer" ? [T.$("kw-transport"), T.$("main.workspace")] : [T.$(`kw-panel[tab="${w}"]`)];
    const out = [];
    for (const root of roots) {
      if (!root) continue;
      for (const el of root.querySelectorAll("button, input, select, textarea")) {
        const b = el.getBoundingClientRect();
        if (!b.width || !b.height || el.closest(".beat-menu, .menu, [hidden]")) continue;
        let ok = false;
        for (let a = el; a && a !== root.parentElement; a = a.parentElement) {
          if (a.getAttribute("title") || a.getAttribute("aria-label") || a.getAttribute("placeholder")) { ok = true; break; }
        }
        if (!ok) out.push(`${el.tagName.toLowerCase()}.${el.className} „${el.textContent.trim().slice(0, 24)}“`);
      }
    }
    return out;
  }, where);
  assert.deepEqual(await missing("leer"), [], "Leerseite und Leiste");
  await app.mcp("create_instrument_track", { kind: "pluck" });
  await app.eval(() => {
    const t = T.st.snapshot.peek().project.tracks[0];
    T.st.selection.value = { trackId: t.id, clipId: t.clips[0]?.id ?? null };
  });
  assert.deepEqual(await missing("leer"), [], "Spurkopf");
  for (const id of ["clip", "klang", "rhythmus", "song", "fuge", "harmonie", "agent"]) {
    await app.eval((i) => T.st.showPanel(i), id);
    await sleep(500);
    assert.deepEqual(await missing(id), [], `Fenster ${id}`);
  }
});

const tracks = () => app.eval(() => T.st.snapshot.peek().project.tracks.length);
const count = () => app.eval(() => T.$(".tour-count")?.textContent ?? "");
async function step(n, total) {
  await app.key("ArrowRight");
  await app.waitFor((want) => T.$(".tour-count")?.textContent === want && T.$(".tour-card"), { what: `Schritt ${n}`, timeout: 15000 }, `${n} / ${total}`);
  await sleep(150);
}

test("intro tour: yellow button on the empty page, demo content in every window, afterwards as before", async () => {
  await app.reset();
  // Download overview closed beforehand (without a library it opens by itself) –
  // the tour opens it in the library step and closes it again afterwards
  await app.eval(() => T.st.showPanel("bibliothek"));
  await sleep(600);
  await app.eval(() => {
    if (T.$("kw-panel[tab=bibliothek] .lib-catalog")?.hidden === false) T.$("kw-panel[tab=bibliothek] [data-help=lib-herunterladen]").click();
  });
  assert.equal(await app.eval(() => T.$("kw-panel[tab=bibliothek] .lib-catalog").hidden), true, "vorher zu");
  await app.eval(() => T.st.showPanel("klang"));
  await sleep(200);
  const before = await app.eval(() => [...T.st.visiblePanels.peek()].sort());
  const heights = () => app.eval(() => ({
    spuren: Math.round(T.$("main.workspace").closest(".dk-stack").getBoundingClientRect().height),
    unten: Math.round(T.$("kw-panel[tab=klang]").closest(".dk-stack").getBoundingClientRect().height),
  }));
  const h0 = await heights();
  assert.match(await app.eval(() => getComputedStyle(T.$(".intro-btn")).backgroundImage), /gradient/, "gelb wie die Zettel");
  await app.clickOn(".intro-btn");
  await app.waitFor(() => T.$(".tour-card"), { what: "Tour", timeout: 15000 });
  assert.equal(await tracks(), 3, "Demo geladen");
  assert.match(await count(), /^1 \/ \d+$/);
  const total = Number((await count()).split("/")[1]);
  assert.ok(total >= 12, `${total} Schritte`);
  const seen = [];
  for (let i = 1; i < total; i++) {
    await step(i + 1, total);
    seen.push(await app.eval(() => {
      const hole = T.$(".tour-hole")?.getBoundingClientRect();
      return {
        title: T.$(".tour-title").textContent,
        hole: hole ? [hole.width, hole.height] : null,
        notes: T.$$(".tour-note").length,
        visible: [...T.st.visiblePanels.peek()],
        dyn: T.$$("kw-panel[tab=clip] .mark.dyn").length,
        analyse: !!T.$("kw-panel[tab=analyse] canvas"),
        klang: T.$$("kw-panel[tab=klang] .snd-field").length,
        fuge: T.$("kw-panel[tab=fuge] .fg-subject")?.value ?? "",
        pos: T.st.status.peek().positionSecs,
        help: T.$("kw-help .help-title")?.textContent ?? "",
        spurenH: T.$("main.workspace").closest(".dk-stack").getBoundingClientRect().height,
        untenH: T.$("kw-panel[tab=clip]").closest(".dk-stack").getBoundingClientRect().height,
        harmonieW: T.$("kw-panel[tab=harmonie]").closest(".dk-stack").getBoundingClientRect().width,
        hcCols: getComputedStyle(T.$("kw-panel[tab=harmonie] .hc-body")).gridTemplateColumns.split(" ").length,
        zirkelSichtbar: (() => {
          const c = T.$("kw-panel[tab=harmonie] .hc-circle")?.getBoundingClientRect();
          const box = T.$("kw-panel[tab=harmonie] .tab-body").getBoundingClientRect();
          return !!c && c.top >= box.top - 2 && c.bottom <= box.bottom + 2 && c.height > 200;
        })(),
        wegeSichtbar: (() => {
          const c = T.$("kw-panel[tab=harmonie] .hc-paths")?.getBoundingClientRect();
          const box = T.$("kw-panel[tab=harmonie]").closest(".dk-stack").getBoundingClientRect();
          return !!c && c.height > 0 && c.top < box.bottom - 20 && c.bottom > box.top;
        })(),
        katalog: T.$("kw-panel[tab=bibliothek] .lib-catalog") ? !T.$("kw-panel[tab=bibliothek] .lib-catalog").hidden : false,
        klangLinks: T.$("kw-panel[tab=klang] .snd-main")?.getBoundingClientRect().width ?? 0,
        klangRechts: T.$("kw-panel[tab=klang] .sound-side")?.getBoundingClientRect().width ?? 0,
      };
    }));
  }
  const by = (t) => seen.find((x) => x.title.startsWith(t));
  assert.ok(by("Die Leiste")?.hole && by("Die Leiste").notes >= 3, "Leiste mit Zetteln");
  for (const [title, panel] of [["Spuren", "spuren"], ["Clip", "clip"], ["Analyse", "analyse"], ["Klang", "klang"], ["Rhythmus", "rhythmus"], ["Song", "song"], ["Bibliothek", "bibliothek"], ["Fuge", "fuge"], ["Harmonie", "harmonie"], ["Agent", "agent"], ["Hilfe", "hilfe"]]) {
    const x = by(title);
    assert.ok(x, `Schritt ${title}`);
    assert.ok(x.hole && x.hole[0] > 100, `${title}: Fenster hervorgehoben`);
    assert.ok(x.visible.includes(panel), `${title}: Fenster aufgeschlagen`);
  }
  // the lower windows get more room, the tracks keep theirs
  assert.ok(by("Spuren").spurenH > by("Spuren").untenH, `Spuren groß: ${by("Spuren").spurenH} > ${by("Spuren").untenH}`);
  for (const t of ["Clip", "Analyse", "Klang", "Rhythmus", "Song", "Bibliothek", "Fuge"]) {
    const x = by(t);
    assert.ok(x.untenH > x.spurenH * 1.3, `${t}: unten vergrößert (${Math.round(x.untenH)} zu ${Math.round(x.spurenH)})`);
  }
  // Harmony: wide enough for two columns, the cadences are visible
  assert.ok(by("Harmonie").harmonieW >= 700, `Harmonie breit: ${Math.round(by("Harmonie").harmonieW)} px`);
  assert.equal(by("Harmonie").hcCols, 2, "Zirkel links, Fortsetzungen und Kadenzen rechts");
  assert.ok(by("Harmonie").wegeSichtbar, "Wege zum Schluss sichtbar");
  assert.ok(by("Harmonie").zirkelSichtbar, "Quintenzirkel ganz zu sehen");
  // Library: download overview open – closed again in the next step
  assert.ok(by("Bibliothek").katalog, "Download-Übersicht offen");
  assert.equal(by("Fuge").katalog, false, "danach wieder zu");
  // Sound: the fields on the left get the most room
  assert.ok(by("Klang").klangLinks > by("Klang").klangRechts * 1.6, `Klang: links ${Math.round(by("Klang").klangLinks)} px, rechts ${Math.round(by("Klang").klangRechts)} px`);
  // demo content in the windows
  assert.ok(by("Spuren").notes >= 2, "Spuren: Zettel an Stumm/Solo und Klaviatur");
  assert.ok(by("Clip").dyn >= 6, "Clip: Vortragszeichen des Themas");
  assert.ok(by("Analyse").analyse, "Analyse: Kurve der Arpeggio-Aufnahme");
  assert.ok(by("Klang").klang >= 1, "Klang: Felder der Melodie");
  assert.ok(by("Fuge").fuge, "Fuge: Thema gewählt");
  assert.ok(by("Harmonie").pos > 1, `Harmonie: Abspielposition in Takt 2 (${by("Harmonie").pos} s)`);
  assert.equal(by("Hilfe").help, "Wiedergabe", "Hilfe erklärt den Abspielknopf");
  // last step: "Done" takes the demo back; the tabs are as before
  assert.ok(await app.eval(() => !!T.$(".tour-btn.keep")), "Knopf „Demo behalten“");
  await app.clickOn(".tour-btn.primary");
  await app.waitFor(() => !T.$(".tour"), { what: "Tour zu" });
  await app.waitFor(() => T.st.snapshot.peek().project.tracks.length === 0 && T.$(".intro-btn"), { what: "Demo zurückgenommen" });
  await sleep(200);
  const after = await app.eval(() => [...T.st.visiblePanels.peek()].filter((x) => x !== "hilfe").sort());
  assert.deepEqual(after, before.filter((x) => x !== "hilfe"));
  assert.equal(await app.eval(() => T.$("kw-panel[tab=analyse] canvas")), null, "keine alte Analyse");
  // sizes as before – also in the saved layout
  const h1 = await heights();
  assert.ok(Math.abs(h1.spuren - h0.spuren) <= 2 && Math.abs(h1.unten - h0.unten) <= 2, `Größen zurück: ${JSON.stringify(h0)} → ${JSON.stringify(h1)}`);
});

test("intro tour: “Keep demo” leaves the tracks in place; Esc ends it and cleans up", async () => {
  await app.reset();
  await app.clickOn(".intro-btn");
  await app.waitFor(() => T.$(".tour-card"), { what: "Tour", timeout: 15000 });
  const total = Number((await count()).split("/")[1]);
  for (let i = 1; i < total; i++) await step(i + 1, total);
  await app.clickOn(".tour-btn.keep");
  await app.waitFor(() => !T.$(".tour"), { what: "Tour zu" });
  await sleep(300);
  assert.equal(await tracks(), 3, "Demo bleibt");
  // Esc in the middle of the tour: demo gone again; ← goes back
  await app.reset();
  await app.clickOn(".intro-btn");
  await app.waitFor(() => T.$(".tour-card"), { what: "Tour", timeout: 15000 });
  await step(2, total);
  await step(3, total);
  await app.key("ArrowLeft");
  await app.waitFor(() => T.$(".tour-count")?.textContent.startsWith("2 /"), { what: "zurück" });
  await app.key("Escape");
  await app.waitFor(() => !T.$(".tour"), { what: "Esc beendet" });
  await app.waitFor(() => T.st.snapshot.peek().project.tracks.length === 0, { what: "Demo zurückgenommen" });
});

/** Sets the layout (or with null the default layout) and reloads the UI. */
async function withLayout(layout) {
  await app.eval((l) => {
    if (l) localStorage.setItem("klangwelt.dock.v1", JSON.stringify(l));
    else localStorage.removeItem("klangwelt.dock.v1");
    setTimeout(() => location.reload(), 50);
  }, layout);
  await sleep(1500);
  await injectHelpers(app);
  await sleep(300);
}

test("tour also enlarges at the bottom when the tool window sits in a row next to the agent", async () => {
  await app.reset();
  // like the person: tracks | harmony on top, tools | agent below
  const stack = (panels) => ({ kind: "stack", panels, active: panels[0] });
  await withLayout({
    root: { kind: "split", dir: "col", sizes: [0.62, 0.38], children: [
      { kind: "split", dir: "row", sizes: [0.78, 0.22], children: [stack(["spuren"]), stack(["harmonie"])] },
      { kind: "split", dir: "row", sizes: [0.6, 0.4], children: [stack(["clip", "analyse", "klang", "rhythmus", "song", "bibliothek", "fuge"]), stack(["agent"])] },
    ] },
    floats: [], closed: ["hilfe"], homes: {},
  });
  const h = () => app.eval(() => ({
    spuren: Math.round(T.$("main.workspace").closest(".dk-stack").getBoundingClientRect().height),
    unten: Math.round(T.$("kw-panel[tab=clip]").closest(".dk-stack").getBoundingClientRect().height),
    breit: Math.round(T.$("kw-panel[tab=clip]").closest(".dk-stack").getBoundingClientRect().width),
  }));
  const h0 = await h();
  assert.ok(h0.unten < h0.spuren, `vorher unten klein: ${JSON.stringify(h0)}`);
  await app.clickOn(".intro-btn");
  await app.waitFor(() => T.$(".tour-card"), { what: "Tour", timeout: 15000 });
  const total = Number((await count()).split("/")[1]);
  for (let i = 2; i <= 4; i++) await step(i, total); // up to "Clip"
  assert.match(await app.eval(() => T.$(".tour-title").textContent), /^Clip/);
  const h1 = await h();
  assert.ok(h1.unten > h1.spuren * 1.3, `unten höher: ${JSON.stringify(h1)}`);
  assert.ok(Math.abs(h1.breit - h0.breit) <= 2, `Breite bleibt: ${h0.breit} → ${h1.breit}`);
  await app.key("Escape");
  await app.waitFor(() => !T.$(".tour"), { what: "Tour zu" });
  await sleep(300);
  const h2 = await h();
  assert.ok(Math.abs(h2.unten - h0.unten) <= 2 && Math.abs(h2.spuren - h0.spuren) <= 2, `danach wie vorher: ${JSON.stringify(h0)} → ${JSON.stringify(h2)}`);
  await withLayout(null);
});

test("small window: at the bottom the tour gets even taller", async () => {
  await app.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  try {
    await sleep(400);
    await app.reset();
    await app.clickOn(".intro-btn");
    await app.waitFor(() => T.$(".tour-card"), { what: "Tour", timeout: 15000 });
    const total = Number((await count()).split("/")[1]);
    for (let i = 2; i <= 4; i++) await step(i, total); // up to "Clip"
    const r = await app.eval(() => {
      const spuren = T.$("main.workspace").closest(".dk-stack").getBoundingClientRect().height;
      const unten = T.$("kw-panel[tab=clip]").closest(".dk-stack").getBoundingClientRect().height;
      return { spuren, unten, anteil: unten / (spuren + unten) };
    });
    // higher than the usual 62 % – until the tracks reach their minimum height (200 px)
    assert.ok(r.anteil > 0.66 && r.spuren <= 215, `unten ${Math.round(r.unten)} px, oben ${Math.round(r.spuren)} px (${Math.round(r.anteil * 100)} %)`);
    await app.key("Escape");
    await app.waitFor(() => !T.$(".tour"), { what: "Tour zu" });
  } finally {
    await app.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
    await sleep(400);
  }
});

test("closing during the tour: tour ends, demo disappears, then the app closes", async () => {
  await app.reset();
  await app.clickOn(".intro-btn");
  await app.waitFor(() => T.$(".tour-card"), { what: "Tour", timeout: 15000 });
  const total = Number((await count()).split("/")[1]);
  await step(2, total);
  await step(3, total);
  assert.equal(await app.eval(() => T.st.snapshot.peek().dirty), true, "Demo macht das Projekt ungespeichert");
  // close the window – we intercept the real quit
  await app.eval(async () => {
    const { backend } = await import("./bridge.js");
    window.__closeCalls = 0;
    backend.appClose = async () => { window.__closeCalls++; };
    await window.__TAURI__.event.emit("close-requested", { dirty: true, busy: null });
  });
  await app.waitFor(() => window.__closeCalls === 1, { what: "App schließt ohne Rückfrage" });
  assert.equal(await app.eval(() => !!T.$(".tour")), false, "Tour beendet");
  assert.equal(await tracks(), 0, "Demo zurückgenommen");
  assert.equal(await app.eval(() => !!T.$(".modal-back")), false, "kein Dialog");
  // dialogs lie above the tour
  assert.ok(await app.eval(() => {
    const probe = document.createElement("div");
    probe.className = "modal-back";
    const tour = document.createElement("div");
    tour.className = "tour";
    document.body.append(probe, tour);
    const ok = Number(getComputedStyle(probe).zIndex) > Number(getComputedStyle(tour).zIndex);
    probe.remove();
    tour.remove();
    return ok;
  }), "Dialog über der Tour");
});

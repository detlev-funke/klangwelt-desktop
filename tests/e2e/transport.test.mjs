// Transport: Wiedergabe, Stopp (Position und Ansicht an den Anfang), Wiederholen, Metronom, Tempo.
import { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startApp, makeTest, sleep } from "./harness.mjs";

let app;
const test = makeTest(() => app);
before(async () => {
  app = await startApp();
});
after(async () => {
  await app?.close();
});

/** Instrumentspur mit einem Takt Noten ab `start` (Schläge). */
async function oneBar(start = 0) {
  return app.eval(async (start) => {
    await T.st.run({ type: "addTrack", track: { id: 0, name: "Takt", kind: "instrument" } });
    const t = T.st.snapshot.peek().project.tracks.at(-1);
    const notes = [0, 1, 2, 3].map((s) => ({ pitch: 60 + s * 2, startBeats: s, lengthBeats: 0.9, velocity: 100 }));
    await T.st.run({ type: "addClip", trackId: t.id, clip: { id: 0, name: "Takt", startBeats: start, source: { type: "notes", lengthBeats: 4, notes } } });
    return t.id;
  }, start);
}

const beatNow = () => app.eval(() => (T.st.status.peek().positionSecs * T.st.snapshot.peek().project.tempoBpm) / 60);

/** Schläge während der Wiedergabe beobachten. */
async function watchBeats(ms, every = 100) {
  const seen = [];
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await sleep(every);
    seen.push(await beatNow());
  }
  return seen;
}

test("Leertaste startet und pausiert, die Position bleibt stehen", async () => {
  await app.reset();
  await oneBar();
  await app.key(" ");
  await app.waitFor(() => T.st.status.peek().playing, { what: "Wiedergabe" });
  await sleep(400);
  await app.key(" ");
  await app.waitFor(() => !T.st.status.peek().playing, { what: "Pause" });
  const pos = await beatNow();
  assert.ok(pos > 0.3, `Position nach Pause: ${pos}`);
  await sleep(300);
  assert.equal(await beatNow(), pos, "Pause hält die Position");
});

test("Stopp-Knopf: anhalten, Position und Ansicht an den Anfang", async () => {
  await app.reset();
  await oneBar(16);
  await app.eval(() => window.__TAURI__.core.invoke("seek", { seconds: 6 }));
  await app.eval(() => window.__TAURI__.core.invoke("transport", { action: "play" }));
  await app.eval(() => (T.st.viewport.value = { ...T.st.viewport.peek(), scrollX: 900 }));
  await sleep(300);
  await app.clickOn("kw-transport .btn.big[title^='Stopp']");
  await app.waitFor(() => !T.st.status.peek().playing && T.st.status.peek().positionSecs === 0, { what: "Stopp am Anfang" });
  assert.equal(await app.eval(() => T.st.viewport.peek().scrollX), 0, "Ansicht springt an den Anfang");
});

test("Enter und Pos1 wirken wie Stopp", async () => {
  for (const key of ["Enter", "Home"]) {
    await app.eval(() => window.__TAURI__.core.invoke("seek", { seconds: 3 }));
    await app.eval(() => (T.st.viewport.value = { ...T.st.viewport.peek(), scrollX: 500 }));
    await app.key(key);
    await app.waitFor(() => T.st.status.peek().positionSecs === 0 && T.st.viewport.peek().scrollX === 0, { what: `Stopp mit ${key}` });
  }
});

test("Metronome: off at first, the last chosen state survives a restart", async () => {
  const metro = () => app.eval(() => T.st.snapshot.peek().engine.metronome);
  assert.equal(await metro(), false, "off on first start");
  await app.clickOn("kw-transport .btn[title='Metronom']");
  await app.waitFor(() => T.st.snapshot.peek().engine.metronome === true, { what: "on" });
  // restart with the same profile: stays on
  const errors = app.errors;
  await app.stop();
  app = await startApp({ tmp: app.tmp });
  app.errors.push(...errors);
  assert.equal(await metro(), true, "on after the restart");
  assert.equal(await app.eval(() => T.$("kw-transport .btn[title='Metronom']").classList.contains("on")), true);
  // switched off by the agent: remembered as well
  await app.mcp("set_metronome", { enabled: false });
  await app.waitFor(() => T.st.snapshot.peek().engine.metronome === false, { what: "off" });
  assert.equal(JSON.parse(readFileSync(join(app.tmp, "bibliothek", "einstellungen.json"), "utf8")).metronom, false, "in the settings");
  await app.stop();
  app = await startApp({ tmp: app.tmp });
  app.errors.push(...errors);
  assert.equal(await metro(), false, "off after the second restart");
});

test("Metronom-Knopf schaltet um", async () => {
  const before = await app.eval(() => T.st.snapshot.peek().engine.metronome);
  await app.clickOn("kw-transport .btn[title='Metronom']");
  await app.waitFor((b) => T.st.snapshot.peek().engine.metronome === !b, { what: "Metronom umgeschaltet" }, before);
  assert.equal(await app.eval(() => T.$("kw-transport .btn[title='Metronom']").classList.contains("on")), !before);
  await app.clickOn("kw-transport .btn[title='Metronom']");
  await app.waitFor((b) => T.st.snapshot.peek().engine.metronome === b, {}, before);
});

test("Wiederholen: Knopf und Taste L, Zustand im Knopf", async () => {
  await app.reset();
  const loopBtn = "kw-transport .btn[title^='Wiederholen']";
  await app.clickOn(loopBtn);
  await app.waitFor(() => T.st.snapshot.peek().engine.loopOn, { what: "Wiederholen an" });
  assert.ok(await app.eval((s) => T.$(s).classList.contains("on"), loopBtn));
  assert.match(await app.eval((s) => T.$(s).title, loopBtn), /Wiederholen an \(L\) – am Ende des Stücks/);
  await app.key("l");
  await app.waitFor(() => !T.st.snapshot.peek().engine.loopOn, { what: "Wiederholen aus" });
  assert.ok(!(await app.eval((s) => T.$(s).classList.contains("on"), loopBtn)));
});

test("Wiederholen ohne Bereich: am Ende des Stücks wieder von vorn", async () => {
  await app.reset();
  await oneBar(0); // Stück = 1 Takt (4 Schläge)
  await app.eval(() => window.__TAURI__.core.invoke("set_loop", { enabled: true }));
  await app.eval(() => window.__TAURI__.core.invoke("seek", { seconds: (3 * 60) / T.st.snapshot.peek().project.tempoBpm }));
  await app.eval(() => window.__TAURI__.core.invoke("transport", { action: "play" }));
  const seen = await watchBeats(1500);
  await app.eval(() => window.__TAURI__.core.invoke("transport", { action: "stop" }));
  assert.ok(seen.every((b) => b < 4.3), `bleibt im Stück: ${seen.map((b) => b.toFixed(1))}`);
  assert.ok(seen.some((b) => b < 2), `springt an den Anfang: ${seen.map((b) => b.toFixed(1))}`);
});

test("Wiederholen mit markiertem Bereich: nur der Bereich", async () => {
  await app.reset();
  await oneBar(0);
  await oneBar(8);
  await app.eval(async () => {
    await T.st.act(window.__TAURI__.core.invoke("set_loop_range", { range: [4, 8] }));
    await T.st.act(window.__TAURI__.core.invoke("set_loop", { enabled: true }));
    await window.__TAURI__.core.invoke("seek", { seconds: (7 * 60) / T.st.snapshot.peek().project.tempoBpm });
    await window.__TAURI__.core.invoke("transport", { action: "play" });
  });
  const seen = await watchBeats(1800);
  await app.eval(() => window.__TAURI__.core.invoke("transport", { action: "stop" }));
  assert.ok(seen.every((b) => b >= 3.9 && b < 8.3), `bleibt im Bereich 4–8: ${seen.map((b) => b.toFixed(1))}`);
  assert.ok(seen.some((b) => b < 6), `springt zurück: ${seen.map((b) => b.toFixed(1))}`);
  assert.match(await app.eval(() => T.$("kw-transport .btn[title^='Wiederholen']").title), /markierter Bereich, Takt 2\.1 bis 3\.1/);
});

test("Wiederholen aus: hält einen Takt nach dem Ende des Stücks an, Play beginnt dann vorn", async () => {
  await app.reset();
  await oneBar(0); // Stück endet bei Schlag 4 → Halt bei Schlag 8
  const bpm = await app.eval(() => T.st.snapshot.peek().project.tempoBpm);
  await app.eval(async (bpm) => {
    await window.__TAURI__.core.invoke("seek", { seconds: (6.5 * 60) / bpm });
    await window.__TAURI__.core.invoke("transport", { action: "play" });
  }, bpm);
  await app.waitFor(() => T.st.status.peek().playing, { what: "spielt", timeout: 2000 }).catch(() => {});
  await app.waitFor(() => !T.st.status.peek().playing, { what: "angehalten", timeout: 4000 });
  const beat = await app.eval((bpm) => (T.st.status.peek().positionSecs * bpm) / 60, bpm);
  assert.ok(Math.abs(beat - 8) < 0.1, `hält einen Takt nach dem Ende: Schlag ${beat.toFixed(2)}`);
  // Play steht hinter dem Ende: beginnt wieder vorn
  await app.eval(() => window.__TAURI__.core.invoke("transport", { action: "play" }));
  const seen = await watchBeats(500);
  await app.eval(() => window.__TAURI__.core.invoke("transport", { action: "stop" }));
  assert.ok(seen.some((b) => b < 2), `von vorn: ${seen.map((b) => b.toFixed(1))}`);
});

test("Markierter Bereich ohne Wiederholen: Play spielt genau den Bereich einmal, dann zurück an den Anfang", async () => {
  await app.reset();
  await oneBar(0);
  await oneBar(8);
  const bpm = await app.eval(() => T.st.snapshot.peek().project.tempoBpm);
  await app.eval(async () => {
    await T.st.act(window.__TAURI__.core.invoke("set_loop_range", { range: [4, 6] }));
    await T.st.act(window.__TAURI__.core.invoke("set_loop", { enabled: false }));
    await window.__TAURI__.core.invoke("seek", { seconds: 0 });
  });
  // Abspielkopf außerhalb (Schlag 0): Play beginnt am Bereichsanfang
  await app.clickOn("kw-transport .btn[title^='Wiedergabe']");
  const seen = await watchBeats(1200);
  await app.waitFor(() => T.st.status.peek().playing, { what: "spielt", timeout: 2000 }).catch(() => {});
  await app.waitFor(() => !T.st.status.peek().playing, { what: "angehalten", timeout: 4000 });
  assert.ok(seen.filter((b) => b > 0.05).every((b) => b >= 3.9 && b <= 6.2), `nur der Bereich 4–6: ${seen.map((b) => b.toFixed(1))}`);
  const beat = await app.eval((bpm) => (T.st.status.peek().positionSecs * bpm) / 60, bpm);
  assert.ok(Math.abs(beat - 4) < 0.1, `zurück an den Bereichsanfang: Schlag ${beat.toFixed(2)}`);
});

test("Tempo im Feld ändern", async () => {
  await app.reset();
  await app.eval(() => {
    const i = T.$("kw-transport input.num");
    i.value = "90";
    i.dispatchEvent(new Event("change"));
  });
  await app.waitFor(() => T.st.snapshot.peek().project.tempoBpm === 90, { what: "Tempo 90" });
});

/** Tempo über das Feld setzen (wie ein Schritt mit der Pfeiltaste). */
const setTempoField = (bpm) =>
  app.eval((bpm) => {
    const i = T.$("kw-transport input.num");
    i.value = String(bpm);
    i.dispatchEvent(new Event("change"));
  }, bpm);

/** Größter Ausgangspegel über `ms` (gemessen wird auch stumm). */
async function peakOver(ms) {
  let peak = 0;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await sleep(40);
    peak = Math.max(peak, await app.eval(() => T.st.status.peek().peakOut));
  }
  return peak;
}

test("Tempo während der Wiedergabe mehrmals ändern: läuft weiter, Schlagposition bleibt", async () => {
  await app.reset();
  // Demo: Audio-Clips (werden neu gestreckt) und Noten (werden neu gerendert);
  // dahinter Noten bis Schlag 28, damit es während des ganzen Tests klingt.
  await app.eval(() => T.st.act(window.__TAURI__.core.invoke("create_demo")));
  for (const start of [16, 20, 24]) await oneBar(start);
  let bpm = await app.eval(() => T.st.snapshot.peek().project.tempoBpm);
  // ab Schlag 8: Ginge die Position in Schlägen verloren, spränge sie bei
  // jedem Wechsel um mehrere Schläge
  await app.eval(async (bpm) => {
    await window.__TAURI__.core.invoke("seek", { seconds: (8 * 60) / bpm });
    await window.__TAURI__.core.invoke("transport", { action: "play" });
  }, bpm);
  await app.waitFor(() => T.st.status.peek().playing, { what: "spielt" });
  assert.ok((await peakOver(300)) > 0.01, "es klingt");
  let last = { beat: await beatNow(), t: Date.now() };
  for (const next of [132, 100, 140, 90, 120]) {
    await setTempoField(next);
    await app.waitFor((bpm) => T.st.snapshot.peek().project.tempoBpm === bpm, { what: `Tempo ${next}` }, next);
    const peak = await peakOver(250);
    assert.ok(await app.eval(() => T.st.status.peek().playing), `spielt weiter nach ${next} BPM`);
    assert.ok(peak > 0.01, `klingt weiter nach ${next} BPM (Pegel ${peak})`);
    // vorangekommen um die vergangene Zeit, zwischen altem und neuem Tempo
    const now = { beat: await beatNow(), t: Date.now() };
    const secs = (now.t - last.t) / 1000;
    const [lo, hi] = [(secs * Math.min(bpm, next)) / 60 - 0.5, (secs * Math.max(bpm, next)) / 60 + 0.5];
    const d = now.beat - last.beat;
    assert.ok(d >= lo && d <= hi, `${bpm} → ${next} BPM: +${d.toFixed(2)} Schläge in ${secs.toFixed(2)} s (erwartet ${lo.toFixed(2)} bis ${hi.toFixed(2)})`);
    [last, bpm] = [now, next];
  }
  await app.eval(() => window.__TAURI__.core.invoke("transport", { action: "stop" }));
});

test("Schnelle Tempo-Schritte im Feld: der letzte Wert kommt an, ohne Stau", async () => {
  await app.reset();
  await app.eval(() => T.st.act(window.__TAURI__.core.invoke("create_demo")));
  await app.eval(() => window.__TAURI__.core.invoke("transport", { action: "play" }));
  await app.waitFor(() => T.st.status.peek().playing, { what: "spielt" });
  // 15 Schritte im Abstand einer Tastenwiederholung (~30 ms) über das Feld …
  const field = await app.eval(async () => {
    const i = T.$("kw-transport input.num");
    for (let v = 111; v <= 125; v++) {
      i.value = String(v);
      i.dispatchEvent(new Event("change"));
      await new Promise((r) => setTimeout(r, 30));
    }
    const sent = performance.now();
    while (T.st.snapshot.peek().project.tempoBpm !== 125) await new Promise((r) => setTimeout(r, 5));
    return performance.now() - sent;
  });
  await sleep(300);
  const core = await app.eval(async () => (await window.__TAURI__.core.invoke("get_state")).project.tempoBpm);
  assert.equal(core, 125, "im Kern gilt der letzte Wert");
  assert.ok(await app.eval(() => T.st.status.peek().playing), "spielt weiter");
  // … und zum Vergleich jeder Schritt als eigener Befehl (so schickte das Feld
  // früher): Jeder rendert neu, und die Befehle können sich dabei überholen.
  const each = await app.eval(async () => {
    const all = [];
    for (let v = 126; v <= 140; v++) {
      all.push(T.st.run({ type: "setProject", patch: { tempoBpm: v } }));
      await new Promise((r) => setTimeout(r, 30));
    }
    const sent = performance.now();
    await Promise.all(all);
    return { ms: performance.now() - sent, bpm: (await window.__TAURI__.core.invoke("get_state")).project.tempoBpm };
  });
  console.log(`# Nachlauf nach dem letzten Schritt: Feld ${field.toFixed(0)} ms; jeder Schritt einzeln ${each.ms.toFixed(0)} ms, Ende bei ${each.bpm} BPM (zuletzt geschickt: 140)`);
  // (seit das Neu-Rendern schnell ist, liegen beide nah beieinander)
  assert.ok(field < each.ms + 100, `das Feld staut nicht: ${field.toFixed(0)} ms gegen ${each.ms.toFixed(0)} ms`);
  await app.eval(() => window.__TAURI__.core.invoke("transport", { action: "stop" }));
});

test("Rückgängig und Wiederholen über die Knöpfe", async () => {
  await app.reset();
  await oneBar();
  assert.equal(await app.eval(() => T.st.snapshot.peek().project.tracks.length), 1);
  await app.clickOn("kw-transport .btn.icon[title^='Rückgängig']");
  await app.waitFor(() => T.st.snapshot.peek().project.tracks[0].clips.length === 0, { what: "Clip zurückgenommen" });
  await app.clickOn("kw-transport .btn.icon[title^='Wiederholen:']");
  await app.waitFor(() => T.st.snapshot.peek().project.tracks[0].clips.length === 1, { what: "Clip wiederhergestellt" });
});

test("keine Fehler im Fenster", () => {
  assert.deepEqual(app.errors, []);
});

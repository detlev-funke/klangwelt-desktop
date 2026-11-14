// Audio devices: The speaker button at the top opens the choice of output device,
// the microphone button next to it that of the recording device. "System default"
// is at the top; the choice takes effect immediately (playback continues on
// the new device), is saved in the settings and still applies after a restart. If
// the remembered device is missing at startup, the system default plays and a notice appears.
import { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startApp, makeTest, sleep } from "./harness.mjs";

let app;
const test = makeTest(() => app);
let errors = [];
before(async () => {
  app = await startApp();
});
after(async () => {
  await app?.close();
});

const settingsFile = () => join(app.tmp, "bibliothek", "einstellungen.json");
const settings = () => {
  try {
    return JSON.parse(readFileSync(settingsFile(), "utf8"));
  } catch {
    return {};
  }
};
const engine = () => app.eval(() => T.st.snapshot.peek().engine);
const devices = () => app.eval(() => window.__TAURI__.core.invoke("audio_devices"));

/** Restart with the same folder (settings are kept). */
async function restart() {
  errors.push(...app.errors);
  await app.stop();
  app = await startApp({ tmp: app.tmp });
}

/** Opens the menu (speaker or microphone) and reads its entries. */
async function openMenu(kind) {
  await app.eval(() => T.$$(".dev-menu.open").forEach((m) => m.classList.remove("open")));
  await app.clickOn(kind === "output" ? "kw-transport .chip.audio-out" : "kw-transport .btn.audio-in");
  await app.waitFor((k) => T.$(`.dev-menu.open[data-kind=${k}] .dev-option`), { what: `Gerätemenü ${kind}` }, kind);
  return app.eval((k) => {
    const menu = T.$(`.dev-menu.open[data-kind=${k}]`);
    return {
      title: menu.querySelector(".menu-title").textContent,
      items: [...menu.querySelectorAll(".dev-option")].map((b) => ({ device: b.dataset.device, label: b.querySelector("b").textContent, sub: b.querySelector("small")?.textContent ?? "", on: b.classList.contains("on") })),
      hints: [...menu.querySelectorAll(".menu-hint")].map((x) => x.textContent),
    };
  }, kind);
}

/** Clicks an entry in the open menu (device "" = system default). */
async function pick(kind, device) {
  await app.eval((k, d) => {
    T.$$("[data-e2e=wahl]").forEach((x) => x.removeAttribute("data-e2e"));
    const b = [...T.$$(`.dev-menu.open[data-kind=${k}] .dev-option`)].find((x) => x.dataset.device === d);
    b.setAttribute("data-e2e", "wahl");
  }, kind, device);
  await app.clickOn("[data-e2e=wahl]");
}

test("speaker button: list of output devices, “System default” on top and selected", async (t) => {
  // Bar does not overflow: speaker and microphone fully visible, without overlapping each other
  const geo = await app.eval(() => {
    const a = T.$("kw-transport .chip.audio-out").getBoundingClientRect();
    const m = T.$("kw-transport .btn.audio-in").getBoundingClientRect();
    return { chipLeft: a.left, chipRight: a.right, micLeft: m.left, micRight: m.right, width: innerWidth };
  });
  assert.ok(geo.chipRight <= geo.micLeft + 0.5 && geo.micRight <= geo.width && geo.chipRight - geo.chipLeft >= 30, JSON.stringify(geo));
  if (!(await engine()).available) return t.skip("kein Audiogerät auf dieser Maschine");
  const d = await devices();
  const m = await openMenu("output");
  assert.equal(m.title, "Ausgabegerät");
  assert.deepEqual(m.items[0], { device: "", label: "Systemstandard", sub: d.defaultOutput ? `zurzeit: ${d.defaultOutput}` : "Standardgerät des Systems", on: true });
  assert.deepEqual(m.items.slice(1).map((i) => i.device), d.outputs, "alle Geräte des Systems");
  assert.ok(m.items.slice(1).every((i) => !i.on));
  assert.ok(m.hints.some((h) => /gilt auch beim nächsten Start/.test(h)));
  // Tooltip names device and sample rate; clicking again closes the menu
  assert.match(await app.eval(() => T.$("kw-transport .chip.audio-out").title), /Ausgabegerät: .+ \(Systemstandard\) · \d+ Hz/);
  await app.clickOn("kw-transport .chip.audio-out");
  assert.equal(await app.eval(() => !!T.$(".dev-menu.open")), false, "zu");
});

test("microphone button: list of recording devices, “System default” on top", async (t) => {
  if (!(await engine()).available) return t.skip("kein Audiogerät auf dieser Maschine");
  const d = await devices();
  const m = await openMenu("input");
  assert.equal(m.title, "Aufnahmegerät");
  assert.equal(m.items[0].label, "Systemstandard");
  assert.equal(m.items[0].on, true);
  assert.deepEqual(m.items.slice(1).map((i) => i.device), d.inputs);
  if (!d.inputs.length) assert.ok(m.hints.includes("Kein Mikrofon gefunden."), m.hints.join(" | "));
  assert.match(await app.eval(() => T.$("kw-transport .btn.audio-in").title), /Aufnahmegerät: Systemstandard/);
  await app.clickOn("kw-transport .btn.audio-in");
});

test("choosing a device takes effect immediately – playback keeps running –, “System default” back; both in the settings", async (t) => {
  if (!(await engine()).available) return t.skip("kein Audiogerät auf dieser Maschine");
  const d = await devices();
  await app.reset();
  // explicitly choose "System default"
  await openMenu("output");
  await pick("output", "");
  await app.waitFor(() => T.$(".toast")?.textContent === "Ausgabe: Systemstandard", { what: "Meldung Systemstandard" });
  assert.equal((await engine()).outputChoice, null);
  assert.equal(settings().ausgabegeraet, null, "in den Einstellungen: Systemstandard");
  if (!d.outputs.length) return t.skip("kein weiteres Ausgabegerät");

  const name = d.outputs.at(-1);
  await app.eval(() => window.__TAURI__.core.invoke("transport", { action: "play" }));
  await app.waitFor(() => T.st.status.peek().playing && T.st.status.peek().positionSecs > 0.3, { what: "spielt" });
  const before = await app.eval(() => T.st.status.peek().positionSecs);
  await openMenu("output");
  await pick("output", name);
  await app.waitFor((n) => T.st.snapshot.peek().engine.outputChoice === n, { what: "Gerät gewählt" }, name);
  await app.waitFor((n) => T.$(".toast")?.textContent === `Ausgabe: ${n}`, { what: "Meldung" }, name);
  const e = await engine();
  assert.equal(e.outputDevice, name, "spielt über das gewählte Gerät");
  assert.equal(settings().ausgabegeraet, name, "gemerkt");
  // continues on the new device – without jumping to the start
  await sleep(400);
  const st = await app.eval(() => T.st.status.peek());
  assert.equal(st.playing, true, "spielt weiter");
  assert.ok(st.positionSecs > before, `Position läuft weiter (${before} → ${st.positionSecs})`);
  // marked as chosen in the menu
  const m = await openMenu("output");
  assert.deepEqual(m.items.filter((i) => i.on).map((i) => i.device), [name]);
  await pick("output", "");
  await app.waitFor(() => T.st.snapshot.peek().engine.outputChoice === null, { what: "zurück auf Systemstandard" });
  assert.equal(settings().ausgabegeraet, null);
  await app.eval(() => window.__TAURI__.core.invoke("transport", { action: "stop" }));
});

test("the choice survives a restart", async (t) => {
  if (!(await engine()).available) return t.skip("kein Audiogerät auf dieser Maschine");
  const d = await devices();
  if (!d.outputs.length && !d.inputs.length) return t.skip("keine Geräte zum Wählen");
  const out = d.outputs[0] ?? null;
  const inp = d.inputs[0] ?? null;
  if (out) {
    await openMenu("output");
    await pick("output", out);
    await app.waitFor((n) => T.st.snapshot.peek().engine.outputChoice === n, { what: "Ausgabe gewählt" }, out);
  }
  if (inp) {
    await openMenu("input");
    await pick("input", inp);
    await app.waitFor((n) => T.st.snapshot.peek().engine.inputChoice === n, { what: "Aufnahme gewählt" }, inp);
  }
  await restart();
  const e = await engine();
  assert.equal(e.outputChoice, out, "Ausgabegerät nach dem Neustart");
  assert.equal(e.inputChoice, inp, "Aufnahmegerät nach dem Neustart");
  assert.equal(e.outputNotice, null);
  assert.equal(e.inputNotice, null);
  if (out) {
    assert.equal(e.outputDevice, out);
    const m = await openMenu("output");
    assert.deepEqual(m.items.filter((i) => i.on).map((i) => i.device), [out], "im Menü gewählt");
    await app.clickOn("kw-transport .chip.audio-out");
  }
});

test("if the remembered device is missing at startup: system default and a short notice; the choice stays remembered", async (t) => {
  if (!(await engine()).available) return t.skip("kein Audiogerät auf dieser Maschine");
  errors.push(...app.errors);
  await app.stop();
  writeFileSync(settingsFile(), JSON.stringify({ ...settings(), ausgabegeraet: "Verschwundenes Interface", eingabegeraet: "Verschwundenes Mikrofon" }));
  app = await startApp({ tmp: app.tmp });
  const toast = await app.waitFor(() => T.$(".toast")?.textContent ?? null, { what: "Hinweis beim Start" });
  assert.match(toast, /Ausgabegerät „Verschwundenes Interface“ ist nicht angeschlossen – Klangwelt spielt über den Systemstandard/);
  assert.match(toast, /Aufnahmegerät „Verschwundenes Mikrofon“ ist nicht angeschlossen/);
  const e = await engine();
  assert.equal(e.outputChoice, null, "spielt über den Systemstandard");
  assert.equal(e.inputChoice, null);
  assert.match(e.outputNotice, /nicht angeschlossen/);
  assert.equal(await app.eval(() => T.$("kw-transport .chip.audio-out").classList.contains("warn")), true, "Knopf zeigt den Hinweis");
  const m = await openMenu("output");
  assert.equal(m.items[0].on, true, "Systemstandard gewählt");
  assert.ok(m.hints.some((h) => h.includes("Verschwundenes Interface")), "Hinweis im Menü");
  await app.clickOn("kw-transport .chip.audio-out");
  assert.equal(settings().ausgabegeraet, "Verschwundenes Interface", "steckt es wieder, gilt es wieder");
  // choose explicitly: notice gone
  await openMenu("output");
  await pick("output", "");
  await app.waitFor(() => T.st.snapshot.peek().engine.outputNotice === null, { what: "Hinweis weg" });
  assert.equal(settings().ausgabegeraet, null);
  assert.equal(await app.eval(() => T.$("kw-transport .chip.audio-out").classList.contains("warn")), false);
});

test("agent: audio_devices and set_audio_device", async (t) => {
  if (!(await engine()).available) return t.skip("kein Audiogerät auf dieser Maschine");
  const d = await app.mcp("audio_devices");
  assert.ok(Array.isArray(d.outputs) && Array.isArray(d.inputs));
  assert.equal(typeof d.outputDevice, "string");
  if (d.outputs.length) {
    const r = await app.mcp("set_audio_device", { kind: "ausgabe", name: d.outputs[0] });
    assert.equal(r.output, d.outputs[0]);
    await app.waitFor((n) => T.st.snapshot.peek().engine.outputChoice === n, { what: "Oberfläche zeigt die Wahl des Agenten" }, d.outputs[0]);
  }
  const back = await app.mcp("set_audio_device", { kind: "ausgabe", name: "Systemstandard" });
  assert.equal(back.output, null);
  await assert.rejects(app.mcp("set_audio_device", { kind: "eingabe", name: "Gibt es nicht" }), /nicht gefunden/);
  await assert.rejects(app.mcp("set_audio_device", { kind: "lautsprecher" }), /Unbekannte Geräteart/);
});

test("no errors in the window", () => {
  assert.deepEqual([...errors, ...app.errors], []);
});

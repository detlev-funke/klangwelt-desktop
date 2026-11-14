// Agent-Schnittstelle (MCP über HTTP) und Chat: Werkzeuge, Projekt lesen/ändern,
// Änderungen erscheinen sofort in der Oberfläche, Chat-Nachrichten hin und zurück.
import { before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startApp, makeTest } from "./harness.mjs";

let app;
const test = makeTest(() => app);
before(async () => {
  app = await startApp();
});
after(async () => {
  await app?.close();
});

/** JSON-RPC an den MCP-Server, optional mit Sitzung; liefert Antwort und Sitzungs-ID. */
async function rpc(method, params = {}, session = null) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (session) headers["mcp-session-id"] = session;
  const r = await fetch(`http://127.0.0.1:${app.mcpPort}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: ++app.id, method, params }) });
  return { body: await r.json(), session: r.headers.get("mcp-session-id") };
}

/** Prompt aus dem Verbinden-Kasten (der erste Test liest ihn, solange noch kein Agent zuhört). */
let prompt = "";

// Läuft vor dem Statustest und schickt selbst keine Anfrage an den Endpunkt.
test("Verbinden-Kasten: genau ein Prompt zum Kopieren statt Befehlen zur MCP-Einrichtung", async () => {
  await app.eval(() => T.st.showPanel("agent"));
  await app.waitFor(() => !!T.$(".chat-status .connect .connect-cmd"), { what: "Verbinden-Kasten" });
  const box = await app.eval(async () => {
    const copied = [];
    const clip = navigator.clipboard;
    const orig = clip.writeText;
    clip.writeText = (t) => (copied.push(t), Promise.resolve());
    const btns = T.$$(".chat-status .connect button");
    btns[0].click();
    await new Promise((r) => setTimeout(r, 50));
    clip.writeText = orig;
    return { buttons: btns.length, label: btns[0].textContent, shown: T.$(".chat-status .connect-cmd").textContent, copied };
  });
  assert.equal(box.buttons, 1, "genau ein Knopf: Kopieren");
  assert.equal(box.label, "Kopiert");
  assert.deepEqual(box.copied, [box.shown], "kopiert wird genau der gezeigte Prompt");
  prompt = box.shown;
  assert.ok(prompt.includes(`http://127.0.0.1:${app.mcpPort}/mcp`), "Prompt nennt den Endpunkt");
  assert.doesNotMatch(prompt, /claude mcp add/);
  for (const w of ["initialize", "result.instructions", "tools/list", "tools/call", "chat_poll", "chat_reply", "Subagent"]) assert.ok(prompt.includes(w), `${w} fehlt im Prompt`);
});

// Muss vor allen Tests laufen, die den Endpunkt anfragen: Jede MCP-Anfrage zählt als verbundener Agent.
test("Agent-Status: ohne Verbindung „Kein Agent verbunden“, mit Sitzung „Agent bereit“, abgemeldet wieder ohne, beim Zuhören „Agent hört zu“", async () => {
  const chip = () => app.eval(() => ({ text: T.$(".chip.agent").textContent, warn: T.$(".chip.agent").classList.contains("warn"), title: T.$(".chip.agent").title }));
  const panelStatus = () => app.eval(() => T.$(".chat-status .status-text")?.textContent ?? "");
  let c = await chip();
  assert.equal(c.text, "Kein Agent verbunden");
  assert.equal(c.warn, true, "grau, solange keiner verbunden ist");
  assert.match(c.title, /Noch kein Agent verbunden[\s\S]*http:\/\/127\.0\.0\.1:\d+\/mcp[\s\S]*Prompt kopieren/);
  assert.equal(await app.eval(() => T.st.chat.peek().agentConnected), false);
  await app.eval(() => T.st.showPanel("agent"));
  await app.waitFor(() => T.$(".chat-status .status-text")?.textContent.startsWith("Kein Agent verbunden"), { what: "Status im Agent-Fenster" });

  // Agent meldet sich an (wie Claude Code beim Start): initialize → Sitzung
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
  const sid = init.session;
  assert.ok(sid, "Sitzungs-ID");
  await rpc("tools/list", {}, sid);
  await app.waitFor(() => T.$(".chip.agent").textContent === "Agent bereit", { what: "„Agent bereit“" });
  c = await chip();
  assert.equal(c.warn, false);
  assert.match(c.title, /Ein Agent ist verbunden/);
  assert.match(await panelStatus(), /Ein Agent ist verbunden, hört aber nicht zu/);

  // Sitzung beenden (DELETE, wie beim Schließen des Clients) → wieder ohne
  const del = await fetch(`http://127.0.0.1:${app.mcpPort}/mcp`, { method: "DELETE", headers: { "mcp-session-id": sid } });
  assert.equal(del.status, 200);
  await app.waitFor(() => T.$(".chip.agent").textContent === "Kein Agent verbunden", { what: "nach dem Abmelden wieder „Kein Agent verbunden“" });
  assert.equal(await app.eval(() => T.st.chat.peek().agentConnected), false);

  // Wie Claude Code: Ereignisstrom (GET /mcp) offen halten – verbunden, solange er offen ist
  const sb = (await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} })).session;
  const ctl = new AbortController();
  const res = await fetch(`http://127.0.0.1:${app.mcpPort}/mcp`, { headers: { accept: "text/event-stream", "mcp-session-id": sb }, signal: ctl.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/event-stream/);
  const reading = res.body.getReader().read().catch(() => null); // erstes Lebenszeichen
  assert.ok(await reading, "Strom liefert ein Lebenszeichen");
  await app.waitFor(() => T.$(".chip.agent").textContent === "Agent bereit", { what: "„Agent bereit“ mit offenem Strom" });
  // Client beendet sich (Strom zu) – die Anzeige springt nach wenigen Sekunden zurück,
  // obwohl seine letzte Anfrage eben erst war
  const closedAt = Date.now();
  ctl.abort();
  await app.waitFor(() => T.$(".chip.agent").textContent === "Kein Agent verbunden", { what: "„Kein Agent verbunden“ nach dem Schließen des Stroms", timeout: 10000 });
  assert.ok(Date.now() - closedAt < 8000, `nach ${Date.now() - closedAt} ms`);

  // Neue Sitzung, Agent hört zu (chat_poll wartet) → „Agent hört zu“
  const s2 = (await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} })).session;
  const poll = rpc("tools/call", { name: "chat_poll", arguments: { timeoutSeconds: 2 } }, s2);
  await app.waitFor(() => T.$(".chip.agent").textContent === "Agent hört zu", { what: "„Agent hört zu“" });
  assert.equal(await app.eval(() => T.$(".chip.agent").classList.contains("listening")), true);
  await poll;
});

test("Verbinden per Prompt: die curl-Aufrufe daraus funktionieren wörtlich, Werkzeuge gehen ohne Sitzung", async () => {
  assert.ok(prompt, "Prompt aus dem ersten Test");
  const url = `http://127.0.0.1:${app.mcpPort}/mcp`;
  // Jede curl-Zeile des Prompts ausführen (Argumente ohne Shell, damit kein Quoting stört)
  const lines = prompt.split("\n").filter((l) => l.startsWith("curl "));
  assert.equal(lines.length, 2, "initialize und chat_poll");
  const curl = async (line, patch = (b) => b) => {
    assert.ok(line.includes(url) && line.includes(`-H "Content-Type: application/json"`), line);
    const body = patch(line.slice(line.indexOf("-d '") + 4, line.lastIndexOf("'")));
    JSON.parse(body);
    const extra = line.includes("--max-time") ? ["--max-time", "295"] : [];
    const { stdout } = await promisify(execFile)("curl", ["-s", ...extra, url, "-H", "Content-Type: application/json", "-d", body]);
    return JSON.parse(stdout);
  };
  const init = await curl(lines[0]);
  assert.equal(init.result.serverInfo.name, "klangwelt");
  assert.match(init.result.instructions, /chat_poll/);
  // chat_poll wie im Prompt, nur mit 1 s statt 280 s Wartezeit
  assert.match(lines[1], /"timeoutSeconds":280/);
  const polled = await curl(lines[1], (b) => b.replace('"timeoutSeconds":280', '"timeoutSeconds":1'));
  assert.ok(!polled.result.isError, JSON.stringify(polled));
  assert.deepEqual(polled.result.structuredContent.auftraege, []);

  // So wie der Prompt es beschreibt: nur Content-Type, keine Sitzung – Werkzeuge gehen trotzdem
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_project", arguments: {} } }) });
  assert.equal(r.status, 200);
  const res = await r.json();
  assert.ok(!res.result.isError, JSON.stringify(res));
  assert.ok(Array.isArray(JSON.parse(res.result.content[0].text).tracks), "Projekt mit Spuren");
});

test("Werkzeugliste: alle Kernwerkzeuge da", async () => {
  const r = await app.mcpRaw("tools/list");
  const names = r.tools.map((t) => t.name);
  for (const n of ["get_project", "execute", "undo", "redo", "transport", "set_metronome", "audio_devices", "set_audio_device", "export_project", "chat_poll", "chat_reply", "create_instrument_track",
    "search_melody", "analyze_harmony", "suggest_chords", "write_chords", "preview_chords", "fugue_subject", "write_fugue", "check_counterpoint"]) {
    assert.ok(names.includes(n), `${n} fehlt`);
  }
});

test("execute legt eine Spur an – die Oberfläche zeigt sie sofort", async () => {
  await app.reset();
  await app.mcp("execute", { commands: [{ type: "addTrack", track: { id: 0, name: "Vom Agenten", kind: "instrument" } }], label: "Test" });
  await app.waitFor(() => T.st.snapshot.peek().project.tracks.some((t) => t.name === "Vom Agenten"), { what: "Spur in der Oberfläche" });
  const p = await app.mcp("get_project");
  assert.ok(JSON.stringify(p).includes("Vom Agenten"));
  await app.mcp("undo");
  await app.waitFor(() => T.st.snapshot.peek().project.tracks.length === 0, { what: "rückgängig" });
});

test("Instrumentspur anlegen und Akkorde schreiben", async () => {
  await app.reset();
  await app.mcp("write_chords", { key: "C-Dur", chords: ["C", "F", "G7", "C"] });
  const t = await app.waitFor(() => T.st.snapshot.peek().project.tracks.find((t) => t.name === "Akkorde") ?? null, { what: "Spur Akkorde" });
  assert.equal(t.clips[0].source.notes.length, 16, "4 Akkorde × 4 Stimmen");
  const a = await app.mcp("analyze_harmony", {});
  assert.match(JSON.stringify(a), /C-Dur/);
});

test("Transport und Metronom über den Agenten", async () => {
  await app.mcp("transport", { action: "play" });
  await app.waitFor(() => T.st.status.peek().playing, { what: "spielt" });
  await app.mcp("transport", { action: "stop" });
  await app.waitFor(() => !T.st.status.peek().playing, { what: "gestoppt" });
  const m = await app.eval(() => T.st.snapshot.peek().engine.metronome);
  await app.mcp("set_metronome", { enabled: !m });
  await app.waitFor((m) => T.st.snapshot.peek().engine.metronome === !m, { what: "Metronom" }, m);
});

test("Chat: Nachricht aus dem Fenster kommt beim Agenten an, Antwort erscheint im Fenster", async () => {
  await app.eval(() => T.st.showPanel("agent"));
  await app.waitFor(() => !!T.$("textarea.chat-input"), { what: "Chatfeld" });
  await app.eval(async () => {
    const ta = T.$("textarea.chat-input");
    ta.value = "Mach die Kick tiefer";
    ta.dispatchEvent(new Event("input"));
    T.$(".chat-compose .btn").click();
  });
  await app.waitFor(() => T.$$(".msg-text").some((m) => m.textContent === "Mach die Kick tiefer"), { what: "eigene Nachricht im Chat" });
  const polled = await app.mcp("chat_poll", { timeoutSeconds: 3 });
  assert.equal(polled.auftraege.length, 1, JSON.stringify(polled));
  assert.equal(polled.auftraege[0].text, "Mach die Kick tiefer");
  await app.mcp("chat_reply", { replyTo: polled.auftraege[0].id, text: "Erledigt: Kick tiefer." });
  await app.waitFor(() => T.$$(".msg-text").some((m) => m.textContent === "Erledigt: Kick tiefer."), { what: "Antwort im Chat" });
});

test("Chat: jede Nachricht trägt die Lage – hörbare, stumme, Solo-Spuren und den markierten Zeitraum", async () => {
  await app.reset();
  const ids = await app.eval(async () => {
    for (const name of ["Bass", "Melodie", "Pad"]) await T.st.run({ type: "addTrack", track: { id: 0, name, kind: "instrument" } });
    const t = T.st.snapshot.peek().project.tracks;
    await T.st.run({ type: "setTrack", trackId: t[2].id, patch: { mute: true } });
    await window.__TAURI__.core.invoke("set_loop_range", { range: [8, 16] });
    await T.st.act(window.__TAURI__.core.invoke("get_state"));
    return t.map((x) => x.id);
  });
  const send = (text) => app.eval(async (text) => {
    const ta = T.$("textarea.chat-input");
    ta.value = text;
    ta.dispatchEvent(new Event("input"));
    T.$(".chat-compose .btn").click();
  }, text);
  await app.eval(() => T.st.showPanel("agent"));
  await app.waitFor(() => !!T.$("textarea.chat-input"), { what: "Chatfeld" });
  await send("Mach den Bass wärmer");
  let polled = await app.mcp("chat_poll", { timeoutSeconds: 3 });
  const k = polled.auftraege[0].kontext;
  assert.match(k, new RegExp(`Hörbare Spuren: „Bass“ \\(${ids[0]}\\), „Melodie“ \\(${ids[1]}\\)`), k);
  assert.match(k, new RegExp(`Stumm: „Pad“ \\(${ids[2]}\\)`), k);
  assert.match(k, /Markierter Zeitraum: Takt 3–4 \(Schlag 8 bis 16\)/, k);
  assert.doesNotMatch(k, /Solo/);
  // im Chat sichtbar unter der eigenen Nachricht
  await app.waitFor(() => T.$$(".msg-context").some((e) => e.textContent.includes("Markierter Zeitraum")), { what: "Kontext im Chat" });
  await app.mcp("chat_reply", { replyTo: polled.auftraege[0].id, text: "ok" });
  // Solo und kein Zeitraum
  await app.eval(async (id) => {
    await T.st.run({ type: "setTrack", trackId: id, patch: { solo: true } });
    await window.__TAURI__.core.invoke("set_loop_range", { range: null });
  }, ids[1]);
  await send("Nur die Melodie lauter");
  polled = await app.mcp("chat_poll", { timeoutSeconds: 3 });
  const k2 = polled.auftraege[0].kontext;
  assert.match(k2, new RegExp(`Hörbare Spuren: „Melodie“ \\(${ids[1]}\\)`), k2);
  assert.match(k2, /Solo: „Melodie“/, k2);
  assert.match(k2, /Kein Zeitraum markiert/, k2);
  await app.mcp("chat_reply", { replyTo: polled.auftraege[0].id, text: "ok" });
});

test("keine Fehler im Fenster", () => {
  assert.deepEqual(app.errors, []);
});

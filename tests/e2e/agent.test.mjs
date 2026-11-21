// Agent interface (MCP over HTTP) and chat: tools, reading/changing the project,
// changes appear in the UI immediately, chat messages back and forth.
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

/** JSON-RPC to the MCP server, optionally with a session; returns response and session ID. */
async function rpc(method, params = {}, session = null) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (session) headers["mcp-session-id"] = session;
  const r = await fetch(`http://127.0.0.1:${app.mcpPort}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: ++app.id, method, params }) });
  return { body: await r.json(), session: r.headers.get("mcp-session-id") };
}

/** Prompt from the connect box (the first test reads it while no agent is listening yet). */
let prompt = "";

// Runs before the status test and sends no request to the endpoint itself.
test("connect box: exactly one prompt to copy instead of MCP setup commands", async () => {
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

// Must run before all tests that query the endpoint: every MCP request counts as a connected agent.
test("agent status: without a connection “No agent connected”, with a session “Agent ready”, signed off again without, while listening “Agent listening”", async () => {
  const chip = () => app.eval(() => ({ text: T.$(".chip.agent").textContent, warn: T.$(".chip.agent").classList.contains("warn"), title: T.$(".chip.agent").title }));
  const panelStatus = () => app.eval(() => T.$(".chat-status .status-text")?.textContent ?? "");
  let c = await chip();
  assert.equal(c.text, "Kein Agent verbunden");
  assert.equal(c.warn, true, "grau, solange keiner verbunden ist");
  assert.match(c.title, /Noch kein Agent verbunden[\s\S]*http:\/\/127\.0\.0\.1:\d+\/mcp[\s\S]*Prompt kopieren/);
  assert.equal(await app.eval(() => T.st.chat.peek().agentConnected), false);
  await app.eval(() => T.st.showPanel("agent"));
  await app.waitFor(() => T.$(".chat-status .status-text")?.textContent.startsWith("Kein Agent verbunden"), { what: "Status im Agent-Fenster" });

  // Agent connects (like Claude Code at startup): initialize → session
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
  const sid = init.session;
  assert.ok(sid, "Sitzungs-ID");
  await rpc("tools/list", {}, sid);
  await app.waitFor(() => T.$(".chip.agent").textContent === "Agent bereit", { what: "„Agent bereit“" });
  c = await chip();
  assert.equal(c.warn, false);
  assert.match(c.title, /Ein Agent ist verbunden/);
  assert.match(await panelStatus(), /Ein Agent ist verbunden, hört aber nicht zu/);

  // End the session (DELETE, as when the client closes) → back to without
  const del = await fetch(`http://127.0.0.1:${app.mcpPort}/mcp`, { method: "DELETE", headers: { "mcp-session-id": sid } });
  assert.equal(del.status, 200);
  await app.waitFor(() => T.$(".chip.agent").textContent === "Kein Agent verbunden", { what: "nach dem Abmelden wieder „Kein Agent verbunden“" });
  assert.equal(await app.eval(() => T.st.chat.peek().agentConnected), false);

  // Like Claude Code: keep the event stream (GET /mcp) open – connected as long as it is open
  const sb = (await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} })).session;
  const ctl = new AbortController();
  const res = await fetch(`http://127.0.0.1:${app.mcpPort}/mcp`, { headers: { accept: "text/event-stream", "mcp-session-id": sb }, signal: ctl.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/event-stream/);
  const reading = res.body.getReader().read().catch(() => null); // first sign of life
  assert.ok(await reading, "Strom liefert ein Lebenszeichen");
  await app.waitFor(() => T.$(".chip.agent").textContent === "Agent bereit", { what: "„Agent bereit“ mit offenem Strom" });
  // Client exits (stream closed) – the indicator jumps back after a few seconds,
  // although its last request was only just now
  const closedAt = Date.now();
  ctl.abort();
  await app.waitFor(() => T.$(".chip.agent").textContent === "Kein Agent verbunden", { what: "„Kein Agent verbunden“ nach dem Schließen des Stroms", timeout: 10000 });
  assert.ok(Date.now() - closedAt < 8000, `nach ${Date.now() - closedAt} ms`);

  // New session, agent is listening (chat_poll waits) → "Agent listening"
  const s2 = (await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} })).session;
  const poll = rpc("tools/call", { name: "chat_poll", arguments: { timeoutSeconds: 2 } }, s2);
  await app.waitFor(() => T.$(".chip.agent").textContent === "Agent hört zu", { what: "„Agent hört zu“" });
  assert.equal(await app.eval(() => T.$(".chip.agent").classList.contains("listening")), true);
  await poll;
});

test("connecting via prompt: the curl calls from it work verbatim, tools work without a session", async () => {
  assert.ok(prompt, "Prompt aus dem ersten Test");
  const url = `http://127.0.0.1:${app.mcpPort}/mcp`;
  // Run every curl line of the prompt (arguments without a shell, so no quoting gets in the way)
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
  // chat_poll as in the prompt, only with 1 s instead of 280 s wait time
  assert.match(lines[1], /"timeoutSeconds":280/);
  const polled = await curl(lines[1], (b) => b.replace('"timeoutSeconds":280', '"timeoutSeconds":1'));
  assert.ok(!polled.result.isError, JSON.stringify(polled));
  assert.deepEqual(polled.result.structuredContent.auftraege, []);

  // As the prompt describes it: only Content-Type, no session – tools work anyway
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_project", arguments: {} } }) });
  assert.equal(r.status, 200);
  const res = await r.json();
  assert.ok(!res.result.isError, JSON.stringify(res));
  assert.ok(Array.isArray(JSON.parse(res.result.content[0].text).tracks), "Projekt mit Spuren");
});

test("tool list: all core tools present", async () => {
  const r = await app.mcpRaw("tools/list");
  const names = r.tools.map((t) => t.name);
  for (const n of ["get_project", "execute", "undo", "redo", "transport", "set_metronome", "audio_devices", "set_audio_device", "export_project", "chat_poll", "chat_reply", "create_instrument_track",
    "search_melody", "analyze_harmony", "suggest_chords", "write_chords", "preview_chords", "fugue_subject", "write_fugue", "check_counterpoint",
    "history", "checkpoint", "goto", "variant_new", "variant_switch", "variant_list", "combine"]) {
    assert.ok(names.includes(n), `${n} fehlt`);
  }
});

test("execute creates a track – the UI shows it immediately", async () => {
  await app.reset();
  await app.mcp("execute", { commands: [{ type: "addTrack", track: { id: 0, name: "Vom Agenten", kind: "instrument" } }], label: "Test" });
  await app.waitFor(() => T.st.snapshot.peek().project.tracks.some((t) => t.name === "Vom Agenten"), { what: "Spur in der Oberfläche" });
  const p = await app.mcp("get_project");
  assert.ok(JSON.stringify(p).includes("Vom Agenten"));
  await app.mcp("undo");
  await app.waitFor(() => T.st.snapshot.peek().project.tracks.length === 0, { what: "rückgängig" });
});

test("create an instrument track and write chords", async () => {
  await app.reset();
  await app.mcp("write_chords", { key: "C-Dur", chords: ["C", "F", "G7", "C"] });
  const t = await app.waitFor(() => T.st.snapshot.peek().project.tracks.find((t) => t.name === "Akkorde") ?? null, { what: "Spur Akkorde" });
  assert.equal(t.clips[0].source.notes.length, 16, "4 Akkorde × 4 Stimmen");
  const a = await app.mcp("analyze_harmony", {});
  assert.match(JSON.stringify(a), /C-Dur/);
});

test("transport and metronome via the agent", async () => {
  await app.mcp("transport", { action: "play" });
  await app.waitFor(() => T.st.status.peek().playing, { what: "spielt" });
  await app.mcp("transport", { action: "stop" });
  await app.waitFor(() => !T.st.status.peek().playing, { what: "gestoppt" });
  const m = await app.eval(() => T.st.snapshot.peek().engine.metronome);
  await app.mcp("set_metronome", { enabled: !m });
  await app.waitFor((m) => T.st.snapshot.peek().engine.metronome === !m, { what: "Metronom" }, m);
});

test("chat: message from the window reaches the agent, reply appears in the window", async () => {
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

test("chat: every message carries the situation – audible, muted, solo tracks and the selected time range", async () => {
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
  // visible in the chat below the user's own message
  await app.waitFor(() => T.$$(".msg-context").some((e) => e.textContent.includes("Markierter Zeitraum")), { what: "Kontext im Chat" });
  await app.mcp("chat_reply", { replyTo: polled.auftraege[0].id, text: "ok" });
  // Solo and no time range
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

/** Tool call that must fail; returns the error text. */
async function mcpError(name, args = {}) {
  const r = await app.mcpRaw("tools/call", { name, arguments: args });
  assert.equal(r.isError, true, `${name} sollte fehlschlagen: ${JSON.stringify(r).slice(0, 300)}`);
  return r.content[0].text;
}
/** Sends a task through the chat window's input; returns its message. */
async function sendTask(text) {
  await app.eval(() => T.st.showPanel("agent"));
  await app.waitFor(() => !!T.$("textarea.chat-input"), { what: "Chatfeld" });
  await app.eval(async (text) => {
    const ta = T.$("textarea.chat-input");
    ta.value = text;
    ta.dispatchEvent(new Event("input"));
    T.$(".chat-compose .btn").click();
  }, text);
  return app.waitFor((text) => T.st.chat.peek().messages.findLast((m) => m.from === "user" && m.text === text) ?? null, { what: `Auftrag „${text}“` }, text);
}
const meta = (id) => app.eval((i) => T.$(`.chat-list .msg[data-id="${i}"] .meta`)?.textContent ?? "", id);

test("prompts and instructions describe the roles listener, dispatcher and worker", async () => {
  for (const w of ["Zuhörer", "\"zuhoeren\"", "\"arbeiten\"", "\"client\":\"zuhoerer\"", "batch", "SendMessage"]) assert.ok(prompt.includes(w), `${w} fehlt im Prompt`);
  const list = (await app.mcpRaw("prompts/list")).prompts.map((p) => p.name);
  assert.deepEqual(list.sort(), ["arbeiten", "zuhoeren"]);
  const listener = (await app.mcpRaw("prompts/get", { name: "zuhoeren" })).messages[0].content.text;
  assert.match(listener, /client "zuhoerer"/);
  assert.match(listener, /done=false/);
  assert.match(listener, /to: "main"/);
  const worker = (await app.mcpRaw("prompts/get", { name: "arbeiten" })).messages[0].content.text;
  for (const w of ["ifRevision", "batch", "cancelRequested", "chat_peek", "C4 1"]) assert.ok(worker.includes(w), `${w} fehlt beim Arbeiter`);
  const init = await app.mcpRaw("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  assert.match(init.instructions, /Roles/);
  assert.match(init.instructions, /At most one worker per track/);
  const tools = (await app.mcpRaw("tools/list")).tools.map((t) => t.name);
  for (const t of ["chat_peek", "batch"]) assert.ok(tools.includes(t), `${t} fehlt`);
});

test("chat: chat_poll reserves for its client, offers again after the lease, chat_peek doesn't take", async () => {
  const task = await sendTask("Bass wärmer");
  const got = await app.mcp("chat_poll", { timeoutSeconds: 3, client: "test", leaseSeconds: 10 });
  assert.deepEqual(got.auftraege.map((a) => a.id), [task.id]);
  await app.waitFor((i) => T.$(`.chat-list .msg[data-id="${i}"] .meta`)?.textContent.includes("angenommen von test"), { what: "angenommen von test" }, task.id);
  await app.waitFor((i) => T.$(".chip.agent").textContent.includes(`arbeitet an #${i}`), { what: "Agent … arbeitet an #n" }, task.id);
  // a second poller doesn't get it; peek sees it without taking it
  assert.deepEqual((await app.mcp("chat_poll", { timeoutSeconds: 1, client: "zuhoerer" })).auftraege, []);
  const peek = await app.mcp("chat_peek", { sinceId: task.id - 1 });
  assert.deepEqual(peek.messages.map((m) => [m.id, m.status, m.claimedBy]), [[task.id, "inProgress", "test"]]);
  // no reply within the lease → offered again (the waiting poll wakes up by itself)
  const t0 = Date.now();
  const again = await app.mcp("chat_poll", { timeoutSeconds: 20, client: "zuhoerer" });
  assert.deepEqual(again.auftraege.map((a) => [a.id, a.redelivered]), [[task.id, 1]]);
  assert.ok(Date.now() - t0 < 15000, `${Date.now() - t0} ms`);
  assert.match(await meta(task.id), /angenommen von zuhoerer/);
  // a reply confirms it – then it stays with the worker
  await app.mcp("chat_reply", { replyTo: task.id, text: "Bin dran.", done: false, client: "zuhoerer" });
  assert.deepEqual((await app.mcp("chat_poll", { timeoutSeconds: 1, client: "test" })).auftraege, []);
  await app.mcp("chat_reply", { replyTo: task.id, text: "Bass ist wärmer." });
  await app.waitFor((i) => T.st.chat.peek().messages.find((m) => m.id === i)?.status === "erledigt", { what: "erledigt" }, task.id);
});

test("chat: stop button and \"Stopp\" – cancelRequested in every tool response, waiting tasks cancelled", async () => {
  const task = await sendTask("Bau ein Jazz-Stück");
  await app.mcp("chat_poll", { timeoutSeconds: 3, client: "zuhoerer" });
  await app.mcp("chat_reply", { replyTo: task.id, text: "Bin dran.", done: false });
  await app.waitFor((i) => T.$(`.chat-list .msg[data-id="${i}"] .stop-task`), { what: "Stopp-Knopf" }, task.id);
  await app.eval((i) => T.$(`.chat-list .msg[data-id="${i}"] .stop-task`).click(), task.id);
  await app.waitFor((i) => T.$(`.chat-list .msg[data-id="${i}"] .meta`)?.textContent.includes("Stopp angefordert"), { what: "Stopp angefordert" }, task.id);
  assert.deepEqual((await app.mcp("get_project", { fields: ["name"] })).cancelRequested, [task.id]);
  assert.match(await mcpError("execute", { commands: [{ type: "removeTrack", trackId: 999999 }] }), /cancelRequested/);
  const stop = (await app.mcp("chat_poll", { timeoutSeconds: 3, client: "zuhoerer" })).auftraege;
  assert.equal(stop.length, 1);
  assert.deepEqual(stop[0].cancels, [task.id]);
  await app.mcp("chat_reply", { replyTo: task.id, text: "Gestoppt." });
  await app.mcp("chat_reply", { replyTo: stop[0].id, text: "Ok." });
  assert.equal((await app.mcp("get_project", { fields: ["name"] })).cancelRequested, undefined);
  // typed "Stopp": a task nobody picked up is cancelled and not offered
  const waiting = await sendTask("Danach Tempo 90");
  const typed = await sendTask("Stopp");
  assert.deepEqual(typed.cancels, [waiting.id]);
  await app.waitFor((i) => T.$(`.chat-list .msg[data-id="${i}"] .meta`)?.textContent.includes("abgebrochen"), { what: "abgebrochen" }, waiting.id);
  assert.deepEqual((await app.mcp("chat_poll", { timeoutSeconds: 1, client: "zuhoerer" })).auftraege.map((a) => a.id), [typed.id]);
  await app.mcp("chat_reply", { replyTo: typed.id, text: "Nichts mehr offen." });
});

test("write tools: revision/ifRevision, placeholders, compact notes, get_project filters", async () => {
  await app.reset();
  const rev = (await app.mcp("get_project", { fields: ["tempoBpm"] })).revision;
  const r = await app.mcp("execute", { ifRevision: rev, label: "Bass", commands: [
    { type: "addTrack", track: { ref: "$bass", name: "Bass", kind: "instrument" } },
    { type: "addClip", trackId: "$bass", clip: { ref: "$riff", startBeats: 0, source: { type: "notes", lengthBeats: 4, notes: "A2 1 · C3+E3 .5 v90 · r .5 · G3 2" } } },
  ] });
  const bass = r.ids.$bass;
  assert.deepEqual(r.created.tracks, [bass]);
  assert.deepEqual(r.created.clips, [{ trackId: bass, clipId: r.ids.$riff }]);
  assert.ok(r.revision > rev, "neue Revision");
  assert.match(r.change, /Agent · Bass/);
  const notes = await app.waitFor((id) => T.st.snapshot.peek().project.tracks.find((t) => t.id === id)?.clips[0]?.source.notes ?? null, { what: "Noten in der Oberfläche" }, bass);
  assert.deepEqual(notes.map((n) => [n.pitch, n.startBeats, n.lengthBeats, n.velocity]), [[45, 0, 1, 100], [48, 1, 0.5, 90], [52, 1, 0.5, 90], [55, 2, 2, 90]]);
  // stale revision: refused, nothing changes
  assert.match(await mcpError("execute", { ifRevision: rev, commands: [{ type: "removeTrack", trackId: bass }] }), /changed in the meantime/);
  assert.equal(await app.eval(() => T.st.snapshot.peek().project.tracks.length), 1);
  const p = await app.mcp("get_project", { trackIds: [bass], fields: ["tracks.name", "tracks.clips"], includeNotes: false });
  assert.deepEqual(Object.keys(p).sort(), ["revision", "tracks"]);
  assert.deepEqual(Object.keys(p.tracks[0]).sort(), ["clips", "id", "name"]);
  assert.equal(p.tracks[0].clips[0].source.noteCount, 4);
});

test("batch: several tools as one undo step, reverted at the first error", async () => {
  await app.reset();
  const r = await app.mcp("batch", { label: "Schlagzeug", calls: [
    { tool: "create_instrument_track", args: { kind: "drums" } },
    { tool: "execute", args: { commands: [{ type: "setTrack", trackId: "$0.trackId", patch: { gainDb: -5, name: "Drums" } }] } },
    { tool: "write_drum_pattern", args: { genre: "House", trackId: "$0.trackId", bars: 1 } },
  ] });
  assert.equal(r.undoLabel, "Agent · Schlagzeug");
  assert.deepEqual(r.created.tracks, [r.results[0].trackId]);
  await app.waitFor(() => T.st.snapshot.peek().project.tracks.some((t) => t.name === "Drums" && t.clips.length >= 2), { what: "Drums mit Beat" });
  assert.equal(await app.eval(() => T.st.snapshot.peek().undoLabel), "Agent · Schlagzeug");
  await app.mcp("undo");
  await app.waitFor(() => T.st.snapshot.peek().project.tracks.length === 0, { what: "ein Schritt zurück nimmt alles" });
  const e = await mcpError("batch", { calls: [
    { tool: "create_instrument_track", args: { kind: "synth" } },
    { tool: "set_sound", args: { trackId: 999999, params: { filter: 0.5 } } },
  ] });
  assert.match(e, /Call 2 \(set_sound\)/);
  await app.waitFor(() => T.st.snapshot.peek().project.tracks.length === 0, { what: "zurückgerollt" });
  assert.equal(await app.eval(() => T.st.snapshot.peek().canRedo), true, "the undone batch stays redoable");
});

test("change history: checkpoint, variant, combine with a conflict to decide, goto – the History window follows", async () => {
  await app.reset();
  await app.eval(() => T.st.showPanel("historie"));
  // one note per bar (8 bars); `changed` replaces some of them
  const bars = (changed = {}) => [0, 1, 2, 3, 4, 5, 6, 7].map((i) => `${changed[i] ?? "C4"} 1 @${i * 4}`).join(" · ");
  const r = await app.mcp("execute", { label: "Lead", commands: [{ type: "addTrack", track: { ref: "$lead", name: "Lead", kind: "instrument",
    clips: [{ ref: "$a", startBeats: 0, source: { type: "notes", lengthBeats: 32, notes: bars() } }] } }] });
  const [lead, clip] = [r.ids.$lead, r.ids.$a];
  const setNotes = (changed) => app.mcp("execute", { commands: [{ type: "setClipNotes", trackId: lead, clipId: clip, notes: bars(changed) }] });
  const pitches = (want) => app.waitFor((id, w) => T.st.snapshot.peek().project.tracks.find((t) => t.id === id)?.clips[0].source.notes.map((n) => n.pitch).join() === w,
    { what: `Lead-Noten ${want}` }, lead, want);
  const activeVariant = (name) => app.waitFor((n) => T.$(".hist-var.on")?.childNodes[1].textContent === n, { what: `Variante „${name}“ aktiv` }, name);

  const cp = await app.mcp("checkpoint", { name: "Rohfassung" });
  await app.waitFor(() => T.$(".hist-row.current .hist-flag")?.textContent.trim() === "Rohfassung", { what: "Checkpoint des Agenten in der Historie" });
  await setNotes({ 4: "D4", 5: "D4" });
  const v = await app.mcp("variant_new", { name: "Refrain", checkpoint: "Rohfassung" });
  assert.equal(v.step, cp.step);
  await activeVariant("Refrain");
  await pitches("60,60,60,60,60,60,60,60");
  await setNotes({ 5: "G4", 6: "G4", 7: "G4" });
  const main = (await app.mcp("variant_list")).variants.find((x) => x.name === "Hauptversion");
  assert.ok(main && !main.active, "Hauptversion");
  const h = await app.mcp("history");
  assert.deepEqual(h.steps.map((s) => s.step).slice(0, 2), [1, cp.step]);
  assert.deepEqual(h.steps[1].checkpoints, ["Rohfassung"]);
  assert.equal(h.steps.at(-1).current, true);
  assert.equal(h.variant.name, "Refrain");

  // the conflict in bar 6 comes back open with the notes of each version; nothing changes
  const conflict = `track ${lead} bar 6`;
  const c = await app.mcp("combine", { others: [main.id] });
  assert.deepEqual([c.combined, c.open], [false, [conflict]]);
  assert.deepEqual(c.decisions.find((d) => d.id === conflict).options.map((o) => o.notes), ["C4 1 @20", "G4 1 @20", "D4 1 @20"]);
  assert.equal((await app.mcp("variant_list")).variants.length, 2);
  // decided: a new variant, the window shows it active
  const done = await app.mcp("combine", { others: ["Hauptversion"], choices: { [conflict]: "Hauptversion" }, name: "Beides" });
  assert.deepEqual([done.combined, done.variant.name, done.label], [true, "Beides", "Kombiniert: Hauptversion"]);
  await activeVariant("Beides");
  await pitches("60,60,60,60,62,62,67,67");

  // back to the checkpoint, forward to the combined step
  await app.mcp("goto", { checkpoint: "Rohfassung" });
  await pitches("60,60,60,60,60,60,60,60");
  await app.waitFor(() => T.$(".hist-row.current .hist-flag")?.textContent.trim() === "Rohfassung", { what: "zurück am Checkpoint" });
  await app.mcp("goto", { step: done.step });
  await pitches("60,60,60,60,62,62,67,67");
  assert.match(await mcpError("batch", { calls: [{ tool: "goto", args: { step: cp.step } }] }), /not allowed/);
  assert.match(await mcpError("variant_switch", { variant: "Gibt es nicht" }), /Refrain/);
});

test("no errors in the window", () => {
  assert.deepEqual(app.errors, []);
});

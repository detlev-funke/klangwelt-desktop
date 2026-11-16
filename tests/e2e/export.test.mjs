// Export: "Export" button (Ctrl+E) with dialog – WAV and FLAC (16/24 bit),
// Opus (selectable bitrate, default 160 kbit/s), stems (one WAV per track) and
// MIDI; whole piece or selected range. The files themselves are checked:
// header, length – FLAC and Opus are decoded independently by the browser.
import { before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { startApp, makeTest } from "./harness.mjs";

let app;
const test = makeTest(() => app);
before(async () => {
  app = await startApp();
});
after(async () => {
  await app?.close();
});

const dir = () => join(app.tmp, "bibliothek", "Exporte");
const file = (name) => join(dir(), name);

async function content() {
  await app.reset();
  await app.mcp("create_instrument_track", { kind: "pluck" });
  await app.mcp("create_instrument_track", { kind: "drums" });
  await app.eval(() => T.st.act(window.__TAURI__.core.invoke("get_state")));
}

async function openDialog() {
  // Export lives in the File menu
  await app.clickOn("kw-transport .file-btn");
  await app.clickOn(".file-menu.open .mi-export");
  await app.waitFor(() => T.$(".export-modal"), { what: "Export-Dialog" });
}

const closeDialog = async () => {
  await app.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await app.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await app.waitFor(() => !T.$(".export-modal"), { what: "Dialog zu" });
};

/** Reads a WAV header (own writer: 44 bytes). */
function wavInfo(path) {
  const b = readFileSync(path);
  return {
    riff: b.toString("ascii", 0, 4),
    wave: b.toString("ascii", 8, 12),
    channels: b.readUInt16LE(22),
    rate: b.readUInt32LE(24),
    bits: b.readUInt16LE(34),
    frames: b.readUInt32LE(40) / (b.readUInt16LE(32)),
    peak: (() => {
      let m = 0;
      const bytes = b.readUInt16LE(34) / 8;
      for (let i = 44; i + bytes <= b.length; i += bytes * 50) m = Math.max(m, Math.abs(bytes === 3 ? b.readIntLE(i, 3) / 8388608 : b.readInt16LE(i) / 32768));
      return m;
    })(),
  };
}

/** Opens a file in the window with the browser's decoder. */
const decode = (path) => app.eval(async (b64) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const buf = await new OfflineAudioContext(2, 48000, 48000).decodeAudioData(bytes.buffer);
  let peak = 0;
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i += 7) peak = Math.max(peak, Math.abs(d[i]));
  return { channels: buf.numberOfChannels, duration: buf.duration, peak };
}, readFileSync(path).toString("base64"));

test("empty project: dialog with five formats, nothing to export", async () => {
  await app.reset();
  await openDialog();
  assert.deepEqual(await app.eval(() => T.$$(".ex-format .seg-btn").map((b) => b.textContent)), ["WAV", "FLAC", "Opus", "Stems", "MIDI"]);
  assert.equal(await app.eval(() => T.$(".ex-format .seg-btn.on").textContent), "WAV", "Standard WAV");
  assert.equal(await app.eval(() => T.$(".ex-bits .seg-btn.on").textContent), "24 Bit");
  assert.equal(await app.eval(() => T.$(".ex-go").disabled), true, "leer: Exportieren gesperrt");
  assert.match(await app.eval(() => T.$(".ex-size").textContent), /leer/);
  assert.equal(await app.eval(() => T.$('.ex-format [data-format="midi"]').disabled), true, "MIDI ohne Noten gesperrt");
  assert.equal(await app.eval(() => T.$(".ex-range").disabled), true, "kein Bereich markiert");
  await closeDialog();
});

test("Opus: bitrate selectable, default 160 kbit/s; note on location and size", async () => {
  await content();
  await openDialog();
  await app.clickOn(".ex-format .seg-btn", { text: "Opus" });
  assert.equal(await app.eval(() => T.$(".ex-bitrate").value), "160");
  assert.deepEqual(await app.eval(() => [...T.$(".ex-bitrate").options].map((o) => Number(o.value))), [64, 96, 128, 160, 192, 256, 320]);
  assert.equal(await app.eval(() => T.$(".ex-bits").closest(".ex-row").hidden), true, "keine Bittiefe bei Opus");
  assert.equal(await app.eval(() => T.$(".ex-bitrate").closest(".ex-row").hidden), false);
  assert.match(await app.eval(() => T.$(".ex-hint").textContent), /\.opus“ in .*Exporte/);
  assert.match(await app.eval(() => T.$(".ex-size").textContent), /etwa \d/);
  await app.clickOn(".ex-format .seg-btn", { text: "FLAC" });
  assert.equal(await app.eval(() => T.$(".ex-bits").closest(".ex-row").hidden), false);
  await closeDialog();
});

test("WAV via the dialog: file written, header and length are correct, “Show in folder”", async () => {
  await content();
  await openDialog();
  await app.clickOn(".ex-format .seg-btn", { text: "WAV" });
  await app.eval(() => {
    const n = T.$(".ex-name");
    n.value = "Probe";
    n.dispatchEvent(new Event("input"));
  });
  await app.clickOn(".ex-go");
  await app.waitFor(() => T.$(".ex-done"), { what: "fertig", timeout: 30000 });
  assert.match(await app.eval(() => T.$(".ex-done").textContent), /Probe\.wav/);
  assert.ok(await app.eval(() => !!T.$(".ex-reveal")), "Knopf „Im Ordner zeigen“");
  const w = wavInfo(file("Probe.wav"));
  assert.deepEqual([w.riff, w.wave, w.channels, w.rate, w.bits], ["RIFF", "WAVE", 2, 48000, 24]);
  // Length: up to the end of the piece, plus at most one bar and 6 s of tail
  const p = await app.eval(() => T.st.snapshot.peek().project);
  const endBeats = Math.max(...p.tracks.flatMap((t) => t.clips.map((c) => c.startBeats + c.source.lengthBeats)));
  const endSecs = endBeats * 60 / p.tempoBpm;
  assert.ok(w.frames / 48000 >= endSecs - 0.01 && w.frames / 48000 <= endSecs + 2 + 6, `${w.frames / 48000} s für ${endSecs} s`);
  assert.ok(w.peak > 0.02, `hörbar: Spitze ${w.peak}`);
  await app.clickOn(".ex-close");
  await app.waitFor(() => !T.$(".export-modal"), { what: "Dialog zu" });
  // same name again: warning before overwriting, format remembered
  await openDialog();
  await app.eval(() => {
    const n = T.$(".ex-name");
    n.value = "Probe";
    n.dispatchEvent(new Event("input"));
  });
  assert.equal(await app.eval(() => T.$(".ex-format .seg-btn.on").textContent), "WAV");
  assert.match(await app.eval(() => T.$(".ex-hint").textContent), /schon – wird überschrieben/);
  await closeDialog();
});

test("FLAC and Opus: the browser decodes both, length matches the WAV", async () => {
  await content();
  const wav = await app.mcp("export_project", { format: "wav", name: "Vergleich", bits: 16 });
  const flac = await app.mcp("export_project", { format: "flac", name: "Vergleich" });
  const opus = await app.mcp("export_project", { format: "opus", name: "Vergleich", bitrate: 96 });
  assert.equal(wavInfo(wav.path).bits, 16);
  const raw = readFileSync(flac.path);
  assert.equal(raw.toString("ascii", 0, 4), "fLaC");
  assert.ok(flac.bytes < wavInfo(wav.path).frames * 6 * 0.92, `FLAC kleiner als WAV (24 Bit): ${flac.bytes}`);
  const o = readFileSync(opus.path);
  assert.equal(o.toString("ascii", 0, 4), "OggS");
  assert.ok(o.includes(Buffer.from("OpusHead")) && o.includes(Buffer.from("OpusTags")));
  // 96 kbit/s ≈ 12 kB per second (variable rate: generous)
  assert.ok(opus.bytes < opus.seconds * 12000 * 2 + 4000, `${opus.bytes} Bytes für ${opus.seconds} s`);
  const df = await decode(flac.path);
  const dop = await decode(opus.path);
  assert.equal(df.channels, 2);
  assert.equal(dop.channels, 2);
  assert.ok(Math.abs(df.duration - wav.seconds) < 0.01, `FLAC ${df.duration} s, WAV ${wav.seconds} s`);
  assert.ok(Math.abs(dop.duration - wav.seconds) < 0.05, `Opus ${dop.duration} s, WAV ${wav.seconds} s`);
  assert.ok(df.peak > 0.02 && dop.peak > 0.02, `hörbar: ${df.peak}, ${dop.peak}`);
});

test("stems: one folder, one equally long WAV per audible track; muted ones are missing", async () => {
  await content();
  const r = await app.mcp("export_project", { format: "stems", name: "Teile" });
  assert.ok(r.path.endsWith("Teile – Stems"), r.path);
  const names = readdirSync(r.path).sort();
  assert.equal(names.length, 2, names.join(", "));
  assert.match(names[0], /^01 /);
  const lens = names.map((n) => wavInfo(join(r.path, n)).frames);
  assert.equal(lens[0], lens[1], "gleich lang");
  // one track muted: only one file left
  const p = await app.eval(() => T.st.snapshot.peek().project);
  await app.mcp("execute", { commands: [{ type: "setTrack", trackId: p.tracks[1].id, patch: { mute: true } }] });
  const r2 = await app.mcp("export_project", { format: "stems", name: "Teile ohne" });
  assert.equal(readdirSync(r2.path).length, 1);
});

test("selected range: WAV exactly that long, MIDI only the notes in it", async () => {
  await content();
  await app.eval(() => T.st.act(window.__TAURI__.core.invoke("set_loop_range", { range: [0, 4] })));
  const w = await app.mcp("export_project", { format: "wav", name: "Bereich", range: true });
  const tempo = await app.eval(() => T.st.snapshot.peek().project.tempoBpm);
  assert.equal(wavInfo(w.path).frames, Math.round(4 * 60 / tempo * 48000), "genau vier Schläge");
  const m = await app.mcp("export_project", { format: "midi", name: "Bereich", range: true });
  const b = readFileSync(m.path);
  assert.equal(b.toString("ascii", 0, 4), "MThd");
  assert.equal(b.readUInt16BE(8), 1, "Typ 1");
  assert.equal(b.readUInt16BE(10), 3, "Tempo-Spur + 2 Instrumente");
  assert.equal(b.readUInt16BE(12), 480);
  // In the dialog: checkbox for the range, with bar numbers
  await openDialog();
  assert.equal(await app.eval(() => T.$(".ex-range").disabled), false);
  assert.match(await app.eval(() => T.$(".ex-range").closest("label").textContent), /Takt 1/);
  assert.equal(await app.eval(() => T.$('.ex-format [data-format="midi"]').disabled), false);
  await closeDialog();
});

test("agent: export_project reports an empty project and a missing range", async () => {
  await app.reset();
  await assert.rejects(app.mcp("export_project", { format: "wav" }), /leer/);
  await content();
  await assert.rejects(app.mcp("export_project", { format: "wav", range: true }), /Kein Zeitraum/);
  await assert.rejects(app.mcp("export_project", { format: "mp3" }), /Unbekanntes Exportformat|mp3/);
  // Ctrl+E opens the dialog
  await app.key("e", { mods: 2 });
  await app.waitFor(() => T.$(".export-modal"), { what: "Dialog per Strg+E" });
  await closeDialog();
  assert.ok(existsSync(dir()));
});

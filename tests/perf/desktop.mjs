// Leistungsmessung der Desktop-App (Release-Build) über das echte IPC –
// zum Vergleich vor und nach Umbauten am Kern. Kein Test mit Grenzwerten,
// sondern eine Tabelle mit Medianen.
//
// Aufruf (in ui/ vorher `npm run release`):
//   KLANGWELT_EXE=target/release/klangwelt.exe node tests/perf/desktop.mjs [Durchläufe]
//
// Gemessen wird im Fenster mit performance.now(): die Zeit vom Aufruf bis zur
// Antwort, also IPC + Befehl + Antwort-JSON.
import { startApp } from "../e2e/harness.mjs";

const runs = Number(process.argv[2] ?? 5);
const app = await startApp();
const result = {};

/** Führt `body` (Text, im Fenster; `call` steht bereit) `n`-mal aus, nach `prep`; Median in ms. */
async function measure(name, body, { n = runs, prep = "" } = {}) {
  const xs = [];
  for (let i = 0; i < n; i++) {
    xs.push(
      await app.eval(`(async () => {
        const call = (cmd, args) => window.__TAURI__.core.invoke(cmd, args);
        ${prep}
        const t0 = performance.now();
        ${body}
        return performance.now() - t0;
      })()`),
    );
  }
  xs.sort((a, b) => a - b);
  result[name] = Math.round(xs[Math.floor(xs.length / 2)] * 100) / 100;
}

const run = (code) => app.eval(`(async () => { const call = (cmd, args) => window.__TAURI__.core.invoke(cmd, args); ${code} })()`);

try {
  await run(`await call("project_new"); await call("set_metronome", { enabled: false });`);
  // kleine Befehle: reiner IPC- und Ablaufaufwand
  await measure("get_state (leer) ×100", `for (let i = 0; i < 100; i++) await call("get_state");`);
  await run(`await call("create_demo");`);
  await measure("get_state (Demo) ×100", `for (let i = 0; i < 100; i++) await call("get_state");`);
  const tid = await run(`return (await call("get_state")).project.tracks.find((t) => t.kind === "instrument").id;`);
  await measure(
    "execute Lautstärke (merge) ×50",
    `for (let i = 0; i < 50; i++) await call("execute", { command: { type: "setTrack", trackId: ${tid}, patch: { gainDb: -(i % 6) } }, merge: i > 0 });`,
  );
  await measure("undo+redo ×20", `for (let i = 0; i < 20; i++) { await call("undo"); await call("redo"); }`);
  // große Abläufe
  await measure("create_demo", `await call("create_demo");`, { prep: `await call("project_new");` });
  const plan = `(await call("song_templates"))[0]`;
  await measure("song_write (Trance)", `await call("song_write", { plan, replace: false });`, { prep: `await call("project_new"); const plan = ${plan};` });
  await measure("harmony_timeline (Song)", `await call("harmony_timeline", { key: null });`);
  await measure("harmony_view (Song)", `await call("harmony_view", { key: null });`);
  await measure("export_info (Song)", `await call("export_info");`);
  await measure("export WAV 16 Bit (Song)", `await call("export_run", { options: { format: "wav", bits: 16, name: "leistung" } });`, { n: Math.min(runs, 3) });
  await measure("transport play/stop ×20", `for (let i = 0; i < 20; i++) { await call("transport", { action: "play" }); await call("transport", { action: "stop" }); }`);

  const width = Math.max(...Object.keys(result).map((k) => k.length));
  console.log(`Median über ${runs} Durchläufe (ms):`);
  for (const [k, v] of Object.entries(result)) console.log(`  ${k.padEnd(width)}  ${String(v).padStart(9)}`);
  console.log(JSON.stringify(result));
} finally {
  await app.close();
}

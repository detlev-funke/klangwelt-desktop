// Live playback on the desktop: note clips are synthesized in the audio
// callback while playing. The callback measures how much of its real-time
// budget it needs; when it can't keep up, the core pre-renders the clips
// around the playback position step by step and they play from buffers.
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

/** Generates the first song template and starts playing it. */
async function playSong() {
  await app.eval(async () => {
    await T.st.act(window.__TAURI__.core.invoke("project_new"));
    const plans = await window.__TAURI__.core.invoke("song_templates");
    await window.__TAURI__.core.invoke("song_write", { plan: plans[0], replace: true });
    await T.st.act(window.__TAURI__.core.invoke("get_state"));
    await window.__TAURI__.core.invoke("transport", { action: "play" });
  });
  await app.waitFor(() => T.st.status.peek().playing, { what: "playing" });
}

test("A generated song is there at once and the mixer reports its load", async () => {
  const ms = await app.eval(async () => {
    const t0 = performance.now();
    await T.st.act(window.__TAURI__.core.invoke("project_new"));
    const plans = await window.__TAURI__.core.invoke("song_templates");
    await window.__TAURI__.core.invoke("song_write", { plan: plans[0], replace: true });
    await T.st.act(window.__TAURI__.core.invoke("get_state"));
    return performance.now() - t0;
  });
  assert.ok(ms < 1500, `song generated in ${Math.round(ms)} ms (nothing is rendered beforehand)`);
  await app.eval(() => window.__TAURI__.core.invoke("transport", { action: "play" }));
  await app.waitFor(() => T.st.status.peek().playing, { what: "playing" });
  await sleep(1000);
  const load = await app.eval(() => T.st.status.peek().load);
  assert.ok(load > 0 && load < 1, `load while playing: ${load}`);
  assert.equal(await app.eval(() => T.st.status.peek().prerendered), 0, "nothing pre-rendered while it keeps up");
  await app.eval(() => window.__TAURI__.core.invoke("transport", { action: "stop" }));
});

test("When live playback can't keep up, clips are pre-rendered and play on; a new tempo plays them live again", async () => {
  await playSong();
  await app.eval(() => window.__TAURI__.core.invoke("simulate_load", { load: 0.95 }));
  await app.waitFor(() => T.st.status.peek().prerendered >= 2, { timeout: 30000, what: "two clips pre-rendered" });
  assert.ok(await app.eval(() => T.st.status.peek().playing), "keeps playing");
  await app.eval(() => window.__TAURI__.core.invoke("simulate_load", { load: 0 }));
  await sleep(500);
  const settled = await app.eval(() => T.st.status.peek().prerendered);
  await sleep(1500);
  assert.ok((await app.eval(() => T.st.status.peek().prerendered)) <= settled, "no more pre-rendering once relieved");
  await app.eval(async () => {
    const bpm = T.st.snapshot.peek().project.tempoBpm;
    await T.st.run({ type: "setProject", patch: { tempoBpm: bpm + 6 } });
  });
  await app.waitFor(() => T.st.status.peek().prerendered === 0, { timeout: 5000, what: "live again" });
  await app.eval(() => window.__TAURI__.core.invoke("transport", { action: "stop" }));
});

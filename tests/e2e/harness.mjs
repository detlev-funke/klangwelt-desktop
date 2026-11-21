// Test harness for end-to-end tests of the real desktop app – without third-party packages:
// node:test as the runner, the app (Tauri, WebView2) is started with an open
// debug port and driven through the Chrome DevTools Protocol (CDP):
// real mouse and keyboard events, evaluation in the window, screenshots.
//
// Each test file starts its own, isolated app instance:
//  * own temp folder for library (KLANGWELT_BIBLIOTHEK) and WebView profile,
//  * free ports for CDP and MCP – a running Klangwelt is left untouched.
// `close()` ends the app with its WebView2 processes and removes the folder; folders of
// killed runs are swept on the next start (klangwelt/tests/tempdirs.mjs).
// Program: KLANGWELT_EXE or target/debug/klangwelt.exe.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { makeTempDir, removeTempDir, stopProcess, waitUntilUnused } from "../../klangwelt/tests/tempdirs.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
/** Screenshots of failed tests. */
export const OUT = join(ROOT, "tests", "e2e", "out");

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.unref();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

/**
 * Tests run in the background: Klangwelt then puts its window off screen,
 * without a taskbar entry and without focus (KLANGWELT_HINTERGRUND). So that
 * WebView2 does not classify such a window as occluded and stop rendering,
 * the browser switches turn throttling off.
 * `KLANGWELT_TESTS_SICHTBAR=1` shows the windows so you can watch.
 * Test instances are muted (`KLANGWELT_STUMM`: playback and levels run,
 * nothing is audible); `KLANGWELT_TESTS_LAUT=1` makes them audible.
 */
const STUMM = process.env.KLANGWELT_TESTS_LAUT ? {} : { KLANGWELT_STUMM: "1" };
export const BACKGROUND_ENV = process.env.KLANGWELT_TESTS_SICHTBAR
  ? { ...STUMM, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "" }
  : {
      ...STUMM,
      KLANGWELT_HINTERGRUND: "1",
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
        "--disable-features=CalculateNativeWinOcclusion --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling",
    };

/** Modifier bits in CDP. */
export const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

const KEYS = {
  " ": ["Space", 32, " "], Enter: ["Enter", 13, "\r"], Escape: ["Escape", 27], Delete: ["Delete", 46], Backspace: ["Backspace", 8],
  Home: ["Home", 36], ArrowUp: ["ArrowUp", 38], ArrowDown: ["ArrowDown", 40], ArrowLeft: ["ArrowLeft", 37], ArrowRight: ["ArrowRight", 39],
  F1: ["F1", 112],
};

class App {
  constructor(child, ws, tmp, mcpPort, cdpPort) {
    this.child = child;
    this.ws = ws;
    this.tmp = tmp;
    this.mcpPort = mcpPort;
    this.cdpPort = cdpPort;
    this.id = 0;
    this.pending = new Map();
    /** Errors in the window (exceptions, console.error) – tests check that none occur. */
    this.errors = [];
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id) {
        this.pending.get(m.id)?.(m);
        this.pending.delete(m.id);
      } else if (m.method === "Runtime.exceptionThrown") {
        const d = m.params.exceptionDetails;
        this.errors.push(d.exception?.description ?? d.text);
      } else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
        this.errors.push(m.params.args.map((a) => a.value ?? a.description).join(" "));
      }
    };
  }

  send(method, params = {}) {
    return new Promise((res, rej) => {
      const i = ++this.id;
      const timer = setTimeout(() => rej(new Error(`CDP ${method}: keine Antwort`)), 30000);
      this.pending.set(i, (m) => {
        clearTimeout(timer);
        m.error ? rej(new Error(`CDP ${method}: ${m.error.message}`)) : res(m.result);
      });
      this.ws.send(JSON.stringify({ id: i, method, params }));
    });
  }

  /**
   * Evaluates in the window. `fn` is a function (called with `args`, may be
   * async) or an expression as text. Available in the window:
   * `T.st` (store.js), `T.pr` (pianoroll.js), `T.sleep`, `T.waitFor`, `T.$`, `T.$$`.
   */
  async eval(fn, ...args) {
    const expression = typeof fn === "function" ? `(${fn.toString()})(...${JSON.stringify(args)})` : fn;
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`Im Fenster: ${d.exception?.description ?? d.text}`);
    }
    return r.result.value;
  }

  /** Waits until `fn` returns a truthy value in the window; returns it. */
  async waitFor(fn, { timeout = 8000, interval = 60, what = "Bedingung" } = {}, ...args) {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
      last = await this.eval(fn, ...args);
      if (last) return last;
      await sleep(interval);
    }
    throw new Error(`Zeitüberschreitung beim Warten auf ${what} (zuletzt: ${JSON.stringify(last)})`);
  }

  // ---------------------------------------------------------------- Input
  mouse(type, x, y, { mods = 0, buttons = type === "mouseReleased" || type === "mouseMoved" ? 0 : 1, button = "left" } = {}) {
    return this.send("Input.dispatchMouseEvent", { type, x, y, button, buttons, clickCount: 1, modifiers: mods });
  }

  /** Drag with the mouse button held; `during` runs before release (e.g. to check state). */
  async drag([x0, y0], [x1, y1], { mods = 0, steps = 8, during } = {}) {
    await this.mouse("mouseMoved", x0, y0, { mods });
    await this.mouse("mousePressed", x0, y0, { mods });
    for (let k = 1; k <= steps; k++) {
      await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x0 + ((x1 - x0) * k) / steps, y: y0 + ((y1 - y0) * k) / steps, button: "left", buttons: 1, modifiers: mods });
    }
    let seen;
    if (during) seen = await during();
    await this.mouse("mouseReleased", x1, y1, { mods });
    await sleep(200);
    return seen;
  }

  async click(x, y, { mods = 0, button = "left" } = {}) {
    await this.mouse("mouseMoved", x, y, { mods });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, buttons: button === "right" ? 2 : 1, clickCount: 1, modifiers: mods });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, buttons: 0, clickCount: 1, modifiers: mods });
    await sleep(200);
  }

  /** Center of an element (CSS selector) – scrolled into view first. */
  async center(selector) {
    const r = await this.eval((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      el.scrollIntoView({ block: "center", inline: "nearest" });
      const b = el.getBoundingClientRect();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height };
    }, selector);
    if (!r) throw new Error(`Element nicht gefunden: ${selector}`);
    return r;
  }

  /** Clicks an element with the real mouse (selector, optionally with a text filter). */
  async clickOn(selector, { text, mods = 0 } = {}) {
    const sel = text == null ? selector : await this.eval((s, t) => {
      const el = [...document.querySelectorAll(s)].find((e) => e.textContent.includes(t));
      if (!el) return null;
      el.setAttribute("data-e2e", "ziel");
      return "[data-e2e=ziel]";
    }, selector, text);
    if (!sel) throw new Error(`Element nicht gefunden: ${selector} mit „${text}“`);
    const c = await this.center(sel);
    await this.click(c.x, c.y, { mods });
    if (text != null) await this.eval(() => document.querySelector("[data-e2e=ziel]")?.removeAttribute("data-e2e"));
  }

  async key(key, { mods = 0 } = {}) {
    await this.eval(() => (document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement.blur() : 0));
    const [code, vk, text] = KEYS[key] ?? [`Key${key.toUpperCase()}`, key.toUpperCase().charCodeAt(0), key];
    const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods };
    await this.send("Input.dispatchKeyEvent", { type: text && !mods ? "keyDown" : "rawKeyDown", ...base, ...(text && !mods ? { text } : {}) });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    await sleep(150);
  }

  // ---------------------------------------------------------------- Miscellaneous
  async shot(name) {
    mkdirSync(OUT, { recursive: true });
    const r = await this.send("Page.captureScreenshot", { format: "png" });
    const file = join(OUT, `${name.replace(/[^\wäöüÄÖÜß-]+/g, "_").slice(0, 80)}.png`);
    writeFileSync(file, Buffer.from(r.data, "base64"));
    return file;
  }

  /** Calls an MCP tool (JSON-RPC over HTTP). */
  async mcp(name, args = {}) {
    const r = await fetch(`http://127.0.0.1:${this.mcpPort}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method: "tools/call", params: { name, arguments: args } }),
    });
    const res = (await r.json()).result;
    if (res.isError) throw new Error(`MCP ${name}: ${res.content?.[0]?.text}`);
    return res.structuredContent ?? JSON.parse(res.content?.[0]?.text ?? "null");
  }

  async mcpRaw(method, params = {}) {
    const r = await fetch(`http://127.0.0.1:${this.mcpPort}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
    });
    return (await r.json()).result;
  }

  /** Clears the project (new project, no selection, view at the start). */
  async reset() {
    await this.eval(async () => {
      // Without an audio device there is no engine – tests that play nothing still run.
      const noEngine = (e) => {
        if (!/Audio/i.test(String(e))) throw e;
      };
      const call = (cmd, args) => window.__TAURI__.core.invoke(cmd, args).catch(noEngine);
      await T.st.act(window.__TAURI__.core.invoke("project_new"));
      await call("transport", { action: "stop" });
      await call("transport", { action: "rewind" });
      await call("set_loop", { enabled: false });
      await call("set_loop_range", { range: null });
      await T.st.act(window.__TAURI__.core.invoke("get_state"));
      T.st.selection.value = null;
      T.pr.noteSel.value = null;
      T.st.viewport.value = { ...T.st.viewport.peek(), scrollX: 0, scrollY: 0 };
    });
    await sleep(150);
  }

  /** Quits the app but keeps its folder – restart with `startApp({ tmp: app.tmp })`.
   *  Returns once its WebView2 processes are gone too, so the next instance gets the
   *  profile to itself. */
  async stop() {
    try {
      this.ws.close();
    } catch {
      /* never mind */
    }
    if (this.child.exitCode == null) {
      this.child.kill();
      await new Promise((r) => {
        const t = setTimeout(r, 4000);
        this.child.once("exit", () => {
          clearTimeout(t);
          r();
        });
      });
    }
    await waitUntilUnused(this.tmp);
  }

  /** Quits the app with all its processes (WebView2) and removes its folder. */
  async close() {
    try {
      this.ws.close();
    } catch {
      /* never mind */
    }
    await stopProcess(this.child);
    await removeTempDir(this.tmp);
  }
}

async function connectPage(port, timeout) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = list.find((p) => p.type === "page" && p.webSocketDebuggerUrl);
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => {
          ws.onopen = res;
          ws.onerror = rej;
        });
        return ws;
      }
    } catch {
      /* not ready yet */
    }
    await sleep(250);
  }
  throw new Error(`App nicht erreichbar (CDP-Port ${port})`);
}

/** Starts an isolated app instance and waits until the UI is up.
 *  `tmp`: folder of a stopped instance (restart with library and settings);
 *  `prepare(bibliothek)`: puts something into its library folder before the start.
 *  `languages`: the WebView's preferred languages (navigator.languages) – German by
 *  default, because the tests check German texts (language: klangwelt/ui/src/i18n.ts).
 *  `env`: more environment variables, e.g. KLANGWELT_FAKE_MIC (a WAV instead of the microphone).
 *  `autosave`: seconds between autosaves (klangwelt/ui/src/autosave.ts) – off by default, so it
 *  never saves (and clears "unsaved changes") in the middle of other tests; null keeps what's set. */
export async function startApp({ tmp, prepare, languages = "de-DE,de", env: extra = {}, autosave = 0 } = {}) {
  const exe = process.env.KLANGWELT_EXE ?? join(ROOT, "target", "debug", "klangwelt.exe");
  if (!existsSync(exe)) throw new Error(`Programm fehlt: ${exe} – erst „cargo build -p klangwelt“ (vorher „npm run build“ in ui/)`);
  const ownTmp = !tmp;
  tmp ??= makeTempDir("klangwelt-e2e-");
  prepare?.(join(tmp, "bibliothek"));
  const [cdpPort, mcpPort] = [await freePort(), await freePort()];
  const env = {
    ...process.env,
    ...BACKGROUND_ENV,
    KLANGWELT_BIBLIOTHEK: join(tmp, "bibliothek"),
    KLANGWELT_MCP_PORT: String(mcpPort),
    WEBVIEW2_USER_DATA_FOLDER: join(tmp, "webview"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `${BACKGROUND_ENV.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS} --remote-debugging-port=${cdpPort} --accept-lang=${languages}`,
    ...extra,
  };
  const child = spawn(exe, [], { env, stdio: "ignore", windowsHide: false });
  let ws;
  try {
    ws = await connectPage(cdpPort, 40000);
  } catch (e) {
    await stopProcess(child);
    if (ownTmp) await removeTempDir(tmp);
    throw e;
  }
  const app = new App(child, ws, tmp, mcpPort, cdpPort);
  await app.send("Runtime.enable");
  await app.send("Page.enable");
  // Page behaves as in the foreground, even without window focus
  await app.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  // fixed window size for identical runs
  await app.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await injectHelpers(app);
  if (autosave != null) await app.eval(async (s) => (await import("./autosave.js")).setAutosaveSeconds(s), autosave);
  return app;
}

/** Waits for the UI and provides the helpers `T` in the page (also after a reload). */
export async function injectHelpers(app) {
  await app.waitFor(() => !!window.__TAURI__ && !!document.querySelector("kw-transport"), { timeout: 20000, what: "Oberfläche" });
  await app.eval(async () => {
    const st = await import("./store.js");
    const pr = await import("./pianoroll.js");
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.T = {
      st,
      pr,
      sleep,
      $: (s) => document.querySelector(s),
      $$: (s) => [...document.querySelectorAll(s)],
      async waitFor(fn, timeout = 5000) {
        const end = performance.now() + timeout;
        while (performance.now() < end) {
          const v = await fn();
          if (v) return v;
          await sleep(40);
        }
        throw new Error("waitFor: Zeitüberschreitung");
      },
    };
    await T.waitFor(() => !!st.snapshot.peek());
  });
}

/**
 * Test with a screenshot on failure. `getApp` returns the file's instance.
 */
export function makeTest(getApp) {
  return (name, fn, opts = {}) =>
    test(name, opts, async (t) => {
      try {
        await fn(t);
      } catch (e) {
        const app = getApp();
        if (app) {
          try {
            const file = await app.shot(`${name}`);
            e.message += `\n  Bildschirmfoto: ${file}`;
          } catch {
            /* without screenshot */
          }
        }
        throw e;
      }
    });
}

// ---------------------------------------------------------------- Timeline

/**
 * Screen coordinates (window pixels) for beat + pitch in a track of the
 * score view – computed from the app's modules (track heights, pitch lanes, zoom).
 */
export async function noteGeo(app, trackId) {
  return app.eval((id) => {
    const p = T.st.snapshot.peek().project;
    const i = p.tracks.findIndex((t) => t.id === id);
    const t = p.tracks[i];
    const g = T.pr.geoFor(t);
    const v = T.st.viewport.peek();
    const c = document.querySelector("kw-timeline canvas").getBoundingClientRect();
    const lanes = {};
    for (let m = 0; m < 128; m++) if (T.pr.inView(g.view, m)) lanes[m] = T.pr.laneY(g, m);
    return { cx: c.x, cy: c.y, cw: c.width, ch: c.height, rowY: c.y + T.st.RULER_H + T.pr.rowTops(p.tracks)[i] - v.scrollY, laneH: g.laneH, lanes, ppb: v.pxPerBeat, scrollX: v.scrollX, rulerH: T.st.RULER_H };
  }, trackId);
}

export function geoFns(geo) {
  return {
    X: (beat) => geo.cx + beat * geo.ppb - geo.scrollX,
    Y: (pitch) => {
      if (geo.lanes[pitch] == null) throw new Error(`Tonhöhe ${pitch} nicht im sichtbaren Bereich`);
      return geo.rowY + geo.lanes[pitch] + geo.laneH / 2;
    },
    rulerY: geo.cy + geo.rulerH / 2,
  };
}

// Command line of klangwelt.exe: help, version, "index" (library),
// "--mcp" (stdio bridge, also with self-start of the app) and opening a project file.
import { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { startApp, makeTest, ROOT, sleep, BACKGROUND_ENV } from "./harness.mjs";
import { killTree, makeTempDir, removeTempDir } from "../../klangwelt/tests/tempdirs.mjs";
import { writePieces } from "./fixtures.mjs";

const EXE = process.env.KLANGWELT_EXE ?? join(ROOT, "target", "debug", "klangwelt.exe");
let app;
let work;
const test = makeTest(() => app);
before(async () => {
  app = await startApp();
  work = makeTempDir("klangwelt-cli-");
});
after(async () => {
  await app?.close();
  await removeTempDir(work);
});

/** Runs the program, collects output. */
function exec(args, { env = {}, input, timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(EXE, args, { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    const t = setTimeout(() => {
      p.kill();
      reject(new Error(`Zeitüberschreitung: klangwelt ${args.join(" ")}\n${out}\n${err}`));
    }, timeout);
    p.on("exit", (code) => {
      clearTimeout(t);
      resolve({ code, out, err });
    });
    if (input != null) p.stdin.end(input);
    else p.stdin.end();
  });
}

const rpc = (id, method, params = {}) => JSON.stringify({ jsonrpc: "2.0", id, method, params });
const replies = (out) => out.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));

function freePort() {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

/** The app version: Klangwelt's, from the submodule (klangwelt/changelog/README.md). */
const VERSION = JSON.parse(readFileSync(join(ROOT, "klangwelt", "ui", "package.json"), "utf8")).version;

test("--help lists all invocations, --version the version", async () => {
  const h = await exec(["--help"]);
  assert.equal(h.code, 0);
  for (const s of ["klangwelt --mcp", "klangwelt index build", "klangwelt index query", "klangwelt <file.klangwelt>"]) assert.ok(h.out.includes(s), s);
  const v = await exec(["--version"]);
  assert.equal(v.out.trim(), `Klangwelt ${VERSION}`);
});

test("the exe carries the version: product version as written, file version from date and time", async () => {
  const script = `$v = (Get-Item -LiteralPath '${EXE}').VersionInfo; "$($v.ProductVersion)|$($v.FileMajorPart).$($v.FileMinorPart).$($v.FileBuildPart).$($v.FilePrivatePart)"`;
  const info = await new Promise((res, rej) => {
    const p = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("error", rej);
    p.on("close", () => res(out.trim()));
  });
  // 2026.11.21+1430 → 2026.11.21.1430: tauri-build takes numeric build metadata as the fourth part
  const [core, build = "0"] = VERSION.split("+");
  assert.equal(info, `${VERSION}|${core}.${Number(build)}`);
});

test("unknown invocation: error message with help, exit code 2 – no window", async () => {
  const r = await exec(["indx"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /Unknown command: klangwelt indx/);
});

test("index build / query / analyze / chords", async () => {
  const src = writePieces(join(work, "noten"));
  const kwix = join(work, "test.kwix");
  const b = await exec(["index", "build", src, kwix]);
  assert.equal(b.code, 0, b.err);
  assert.ok(existsSync(kwix));
  assert.match(b.out, /2 scores, 5 voices/);

  const q = await exec(["index", "query", kwix, "60:1 62:1 64:1 65:1 67:2 67:2 69:1"]);
  assert.equal(q.code, 0, q.err);
  assert.match(q.out, /Test Komponist – Testchoral \[Sopran/);

  const a = await exec(["index", "analyze", join(src, "testchoral.musicxml")]);
  assert.equal(a.code, 0, a.err);
  const json = JSON.parse(a.out);
  assert.ok(JSON.stringify(json).includes("Sopran"));

  const c = await exec(["index", "chords", kwix, "C-Dur", "C", "G7"]);
  assert.equal(c.code, 0, c.err);
  assert.match(c.out, /After G7/);

  const bad = await exec(["index", "query"]);
  assert.equal(bad.code, 2);
});

test("--mcp connects MCP clients to the running app over stdio", async () => {
  const input = [rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } }),
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    rpc(2, "tools/list"),
    rpc(3, "tools/call", { name: "get_project", arguments: {} })].join("\n") + "\n";
  const r = await exec(["--mcp"], { env: { KLANGWELT_MCP_URL: `http://127.0.0.1:${app.mcpPort}/mcp` }, input });
  assert.equal(r.code, 0, r.err);
  const got = replies(r.out);
  assert.deepEqual(got.map((m) => m.id), [1, 2, 3], "Benachrichtigung ohne Antwort");
  assert.equal(got[0].result.serverInfo.name.toLowerCase().includes("klangwelt"), true);
  const tools = got[1].result.tools.map((t) => t.name);
  assert.ok(tools.includes("open_project") && tools.includes("execute"));
  assert.ok(!got[2].result.isError);
});

test("--mcp starts Klangwelt itself if it is not running", async () => {
  const port = await freePort();
  const iso = makeTempDir("klangwelt-selbst-");
  let pid = null;
  try {
    const r = await exec(["--mcp"], {
      env: {
        // the window it started itself inherits the background mode
        ...BACKGROUND_ENV,
        KLANGWELT_MCP_URL: `http://127.0.0.1:${port}/mcp`,
        KLANGWELT_BIBLIOTHEK: join(iso, "bib"),
        WEBVIEW2_USER_DATA_FOLDER: join(iso, "wv"),
      },
      input: rpc(1, "tools/list") + "\n",
      timeout: 90000,
    });
    pid = Number(r.err.match(/Klangwelt started \(PID (\d+)\)/)?.[1] ?? 0) || null;
    assert.ok(pid, `PID gemeldet: ${r.err}`);
    const got = replies(r.out);
    assert.ok(got[0].result?.tools?.length > 10, JSON.stringify(got[0]).slice(0, 300));
    // The started window keeps running even when the bridge exits
    await sleep(500);
    const alive = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: rpc(9, "ping") }).then((x) => x.ok).catch(() => false);
    assert.ok(alive, "App läuft nach dem Ende der Brücke weiter");
  } finally {
    // the window together with its WebView2 processes, which hold files in iso
    if (pid) await killTree(pid);
    await removeTempDir(iso);
  }
});

test("opening a project file: if Klangwelt is already running, it opens there (no second window)", async () => {
  const file = join(work, "Mein Lied.klangwelt");
  await app.reset();
  await app.eval(async (f) => {
    await T.st.run({ type: "addTrack", track: { id: 0, name: "Aus der Datei", kind: "instrument" } });
    await T.st.act(window.__TAURI__.core.invoke("project_save", { path: f }));
    await T.st.act(window.__TAURI__.core.invoke("project_new"));
  }, file);
  assert.equal(await app.eval(() => T.st.snapshot.peek().project.tracks.length), 0);
  const r = await exec([file], { env: { KLANGWELT_MCP_PORT: String(app.mcpPort) }, timeout: 15000 });
  assert.equal(r.code, 0, r.err);
  await app.waitFor(() => T.st.snapshot.peek().project.tracks.some((t) => t.name === "Aus der Datei"), { what: "Projekt geöffnet" });
  assert.match(await app.eval(() => T.st.snapshot.peek().file ?? ""), /Mein Lied\.klangwelt$/);
});

test("opening a project file with unsaved changes: ask first", async () => {
  const file = join(work, "Mein Lied.klangwelt");
  await app.eval(() => T.st.run({ type: "addTrack", track: { id: 0, name: "Ungespeichert", kind: "instrument" } }));
  const r = await exec([file], { env: { KLANGWELT_MCP_PORT: String(app.mcpPort) }, timeout: 15000 });
  assert.equal(r.code, 0);
  const title = await app.waitFor(() => T.$(".modal")?.textContent ?? null, { what: "Rückfrage" });
  assert.match(title, /Ungespeicherte Änderungen/);
  assert.ok(await app.eval(() => T.st.snapshot.peek().project.tracks.some((t) => t.name === "Ungespeichert")), "noch nichts verworfen");
  await app.eval(() => T.$$(".modal .btn").find((b) => /Abbrechen/.test(b.textContent))?.click());
});

test("no errors in the window", () => {
  assert.deepEqual(app.errors, []);
});

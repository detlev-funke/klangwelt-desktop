// PDMX-Download über eine wackelige Verbindung: Ein lokaler Server bricht jede
// Antwort nach einem Stück ab. Die App setzt an derselben Stelle fort
// (HTTP-Range), entpackt lückenlos und übernimmt alles in die Bibliothek.
import { before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startApp, makeTest } from "./harness.mjs";
import { musicXml } from "./fixtures.mjs";

const SCALE = ["C4", "D4", "E4", "F4", "G4", "A4", "B4", "C5", "D5", "E5", "F5", "G5"];
const COUNT = 30;

/** Minimales tar (ustar) aus { name, data } – reicht für reguläre Dateien. */
function tar(files) {
  const blocks = [];
  for (const { name, data } of files) {
    const h = Buffer.alloc(512);
    h.write(name, 0, 100, "utf8");
    h.write("0000644\0", 100);
    h.write("0000000\0", 108);
    h.write("0000000\0", 116);
    h.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
    h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, "0") + "\0", 136);
    h.write("        ", 148);
    h.write("0", 156);
    h.write("ustar\0", 257);
    h.write("00", 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

const files = Array.from({ length: COUNT }, (_, i) => {
  const notes = Array.from({ length: 9 + (i % 5) }, (_, k) => `${SCALE[(i * 7 + k * k + k) % SCALE.length]}:${(i >> k) & 1 ? 2 : 1}`);
  return { name: `mxl/${i % 4}/wackel-${i}.musicxml`, data: Buffer.from(musicXml({ title: `Wackelstück ${i}`, composer: "Wackel", parts: [{ name: "Stimme", notes }] })) };
});
const archive = gzipSync(tar(files));
const CUT = Math.ceil(archive.length / 4);

let server;
let requests = [];
let app;
const test = makeTest(() => app);
before(async () => {
  // liefert das Archiv (auch ab einer Range), bricht aber jede Antwort nach CUT Bytes ab
  server = createServer((req, res) => {
    const m = /bytes=(\d+)-/.exec(req.headers.range ?? "");
    const from = m ? Number(m[1]) : 0;
    requests.push(from);
    const body = archive.subarray(from);
    res.writeHead(from ? 206 : 200, {
      "content-length": body.length,
      ...(from ? { "content-range": `bytes ${from}-${archive.length - 1}/${archive.length}` } : {}),
    });
    if (body.length <= CUT) res.end(body);
    else res.write(body.subarray(0, CUT), () => res.socket.end());
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  process.env.KLANGWELT_PDMX_URL = `http://127.0.0.1:${server.address().port}/mxl.tar.gz`;
  app = await startApp();
});
after(async () => {
  await app?.close();
  server?.close();
  delete process.env.KLANGWELT_PDMX_URL;
});

const info = () => app.eval(() => window.__TAURI__.core.invoke("library_info"));

test("Abgerissene Verbindungen werden fortgesetzt – alle Partituren kommen an und werden übernommen", async () => {
  await app.waitFor(async () => {
    const i = await window.__TAURI__.core.invoke("library_info");
    return i.id && !i.loading && !i.building;
  }, { timeout: 30000, what: "Bibliothek bereit" });
  const start = await app.eval(() => window.__TAURI__.core.invoke("library_download", { id: "pdmx-kostprobe", folder: null, withMeta: false }));
  assert.equal(start.currentPack, "pdmx-kostprobe");
  // Während es läuft, meldet die App das Fortsetzen
  const resumeMsg = await app.waitFor(async () => {
    const i = await window.__TAURI__.core.invoke("library_info");
    return i.message && /Verbindung unterbrochen/.test(i.message) ? i.message : null;
  }, { timeout: 30000, interval: 20, what: "Meldung „Verbindung unterbrochen“" });
  assert.match(resumeMsg, /mache bei \d+ MB weiter \(Verbindung 2\)/);
  const done = await app.waitFor(async () => {
    const i = await window.__TAURI__.core.invoke("library_info");
    return !i.currentPack && !i.download && !i.building && i.merging == null ? i : null;
  }, { timeout: 60000, what: "Download und Übernehmen fertig" });
  assert.equal(done.scores, COUNT, done.message);
  // Anfragen: von vorn, dann jeweils ab der Abrissstelle (weiter hinten)
  assert.ok(requests.length >= 3, `mehrfach abgerissen: ${requests}`);
  assert.equal(requests[0], 0);
  for (let i = 1; i < requests.length; i++) assert.ok(requests[i] > requests[i - 1], `fortgesetzt statt von vorn: ${requests}`);
  assert.match(done.message, new RegExp(`Die Verbindung riss ${requests.length - 1}-mal ab und wurde jeweils fortgesetzt`));
  // Dateien lückenlos und unverändert
  const dir = join(app.tmp, "bibliothek", "PDMX-Kostprobe");
  for (const f of files) {
    const p = join(dir, f.name.replace(/^mxl\//, ""));
    assert.ok(existsSync(p), p);
    assert.ok(readFileSync(p).equals(f.data), `${p} unverändert`);
  }
  assert.ok(!readdirSync(join(dir, "0")).some((n) => n.endsWith(".teil")), "keine halben Dateien");
  // gefunden wird auch
  const hits = await app.eval(async () => (await window.__TAURI__.core.invoke("library_search", { text: "Wackelstück 7" })).map((h) => h.title));
  assert.ok(hits.includes("Wackelstück 7"), JSON.stringify(hits));
});

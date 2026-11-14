// Download queue of the library: while one package is being imported, further
// ones land in the queue and start by themselves afterwards. Ordering the same
// one twice is rejected, × removes a package, "Cancel" stops only
// the running job. Without network: the packages already lie in their folders
// (then they are only imported); a large one makes sure it runs for a while.
import { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startApp, makeTest } from "./harness.mjs";
import { musicXml } from "./fixtures.mjs";

const SCALE = ["C4", "D4", "E4", "F4", "G4", "A4", "B4", "C5", "D5", "E5", "F5", "G5"];

/** `n` small, different scores in `dir`. */
function pieces(dir, prefix, n) {
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < n; i++) {
    const len = 8 + (i % 7);
    const notes = Array.from({ length: len }, (_, k) => `${SCALE[(i * 5 + k * k * 3 + k + Math.floor(i / 12)) % SCALE.length]}:${(i >> k) & 1 ? 2 : 1}`);
    writeFileSync(join(dir, `${prefix}-${i}.musicxml`), musicXml({ title: `${prefix} ${i}`, composer: prefix, parts: [{ name: "Stimme", notes }] }));
  }
}

const BIG = 1200;

let app;
const test = makeTest(() => app);
before(async () => {
  app = await startApp({
    prepare: (root) => {
      pieces(join(root, "DCML-Klassik"), "Gross", BIG);
      pieces(join(root, "DCML-Barock"), "Barock", 3);
      pieces(join(root, "KernScores-Barock"), "Kern", 2);
      pieces(join(root, "DCML-Romantik"), "Romantik", BIG);
      pieces(join(root, "DCML-20Jh"), "Neu", 2);
    },
  });
});
after(async () => {
  await app?.close();
});

const registry = () => JSON.parse(readFileSync(join(app.tmp, "bibliothek", "bibliotheken.json"), "utf8"));
const packsOf = (name) => registry().libraries.find((l) => l.name === name)?.packs ?? [];
/** Nothing is running and nothing is waiting any more. */
const idle = (what, timeout = 120000) =>
  app.waitFor(async () => {
    const i = await window.__TAURI__.core.invoke("library_info");
    return i.id && !i.loading && !i.adding && !i.building && i.merging == null && !i.download && !i.currentPack && !i.queue?.length ? i : null;
  }, { timeout, what });
const download = (id) => app.eval((id) => window.__TAURI__.core.invoke("library_download", { id, folder: null, withMeta: false }), id);
/** Error text when ordering is rejected (otherwise null). */
const refused = (id) =>
  app.eval((id) => window.__TAURI__.core.invoke("library_download", { id, folder: null, withMeta: false }).then(() => null, (e) => String(e)), id);
const queueIds = () => app.eval(() => T.$$(".lib-queue:not([hidden]) .lib-queue-item").map((x) => x.dataset.id));
const cardButton = (id) => app.eval((id) => T.$(`.lib-card[data-id="${id}"] .lib-card-foot .btn`)?.textContent.trim() ?? null, id);

test("more packages wait while one is being adopted and are processed by themselves afterwards", async () => {
  await idle("Bibliothek bereit", 30000);
  // open the catalog: the cards show the state
  await app.eval(() => T.st.showPanel("bibliothek"));
  await app.waitFor(() => !!T.$("[data-help=lib-herunterladen]"), { what: "Herunterladen-Knopf" });
  if (await app.eval(() => !T.$(".lib-catalog:not([hidden])"))) await app.clickOn("[data-help=lib-herunterladen]");
  await app.waitFor(() => !!T.$('.lib-card[data-id="dcml-barock"]'), { what: "Katalogkarten" });
  assert.equal(await cardButton("dcml-barock"), "Übernehmen", "nichts läuft: gewohnter Knopf");

  const a = await download("dcml-klassik");
  assert.equal(a.currentPack, "dcml-klassik", "das erste startet sofort");
  assert.deepEqual(a.queue, []);
  const b = await download("dcml-barock");
  assert.equal(b.currentPack, "dcml-klassik", "das erste läuft noch");
  assert.deepEqual(b.queue.map((q) => [q.id, q.libraryName]), [["dcml-barock", "Standard"]], "das zweite wartet");
  // ordering twice does not work
  assert.match(await refused("dcml-barock"), /„DCML – Barock, analysiert“ wartet schon in der Warteschlange\./);
  assert.match(await refused("dcml-klassik"), /wird gerade geladen\./);
  // via agent: arrives at the back
  const r = await app.mcp("download_library", { id: "kern-barock" });
  assert.equal(r.warteschlange, 2);

  // bar: the queue; cards: loading, waiting, "Add to queue"
  await app.waitFor(() => T.$$(".lib-queue:not([hidden]) .lib-queue-item").length === 2, { what: "Warteschlange in der Leiste" });
  assert.deepEqual(await queueIds(), ["dcml-barock", "kern-barock"]);
  await app.waitFor(() => T.$('.lib-card[data-id="kern-barock"] .lib-card-foot .btn')?.textContent.includes("Platz 2"), { what: "Karte: Platz 2" });
  assert.equal(await cardButton("dcml-klassik"), "Wird geladen …");
  assert.equal(await cardButton("dcml-barock"), "Wartet · Platz 1");
  assert.equal(await cardButton("kern-romantik"), "Einreihen", "noch nicht beauftragt: Einreihen");

  // × removes one
  await app.eval(() => T.$$(".lib-queue-item").find((x) => x.dataset.id === "kern-barock").querySelector(".lib-queue-x").click());
  await app.waitFor(async () => (await window.__TAURI__.core.invoke("library_info")).queue.length === 1, { what: "herausgenommen" });
  await app.waitFor(() => T.$$(".lib-queue-item").length === 1, { what: "Leiste aktualisiert" });
  assert.deepEqual(await queueIds(), ["dcml-barock"]);

  const info = await idle("alles übernommen");
  assert.equal(info.scores, BIG + 3);
  const packs = packsOf("Standard");
  assert.ok(packs.includes("dcml-klassik") && packs.includes("dcml-barock"), `beide übernommen: ${packs}`);
  assert.ok(!packs.includes("kern-barock"), "herausgenommenes nicht");
  await app.waitFor(() => !!T.$(".lib-queue[hidden]"), { what: "Leiste ohne Warteschlange" });
  await app.waitFor(() => T.$('.lib-card[data-id="dcml-barock"] .lib-card-foot .btn')?.disabled === true, { what: "Karte: enthalten" });
});

test("“Remove all” empties the queue; “Cancel” stops only the running task", async () => {
  await download("dcml-romantik");
  await download("dcml-20jh");
  await download("kern-barock");
  await app.waitFor(() => T.$$(".lib-queue-item").length === 2, { what: "zwei wartend" });
  await app.eval(() => T.$(".lib-queue-clear").click());
  await app.waitFor(() => !!T.$(".lib-queue[hidden]"), { what: "Warteschlange leer" });
  let i = await app.eval(() => window.__TAURI__.core.invoke("library_info"));
  assert.equal(i.currentPack, "dcml-romantik", "der laufende Auftrag läuft weiter");
  assert.deepEqual(i.queue, []);

  // queue one again, then cancel the running one: the waiting one gets its turn
  await download("dcml-20jh");
  await app.waitFor(() => T.$$(".lib-queue-item").length === 1, { what: "eines wartend" });
  assert.match(await app.eval(() => T.$(".lib-bar .btn:not([hidden])[title*=Warteschlange]")?.title ?? ""), /danach geht es mit der Warteschlange weiter/);
  await app.eval(() => window.__TAURI__.core.invoke("library_cancel"));
  i = await idle("abgebrochen, das wartende übernommen");
  const packs = packsOf("Standard");
  assert.ok(packs.includes("dcml-20jh"), `wartendes übernommen: ${packs}`);
  assert.ok(!packs.includes("dcml-romantik"), "abgebrochenes nicht");
  assert.ok(!packs.includes("kern-barock"), "herausgenommenes nicht");
  assert.equal(i.scores, BIG + 3 + 2);
});

test("if nothing is running, a package starts immediately – without a queue", async () => {
  const r = await download("kern-barock");
  assert.equal(r.currentPack, "kern-barock");
  assert.deepEqual(r.queue, []);
  await idle("übernommen");
  assert.ok(packsOf("Standard").includes("kern-barock"));
});

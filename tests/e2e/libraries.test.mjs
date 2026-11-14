// Libraries: migrating the old per-package-folder indexes into "Standard", creating
// libraries of your own, switching (separate indexes – no shared search),
// renaming, deleting, importing a package from the folder, restart keeps the
// active library, the same via the agent.
import { before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startApp, makeTest, ROOT } from "./harness.mjs";
import { CHORAL_MELODY, musicXml, writePieces } from "./fixtures.mjs";

const EXE = process.env.KLANGWELT_EXE ?? join(ROOT, "target", "debug", "klangwelt.exe");
const OLD = "klangwelt-bibliothek.kwix";

const OWN_PIECE = {
  title: "Eigenes Lied",
  composer: "Ich",
  parts: [{ name: "Gesang", notes: ["E4:1", "G4:1", "C5:2", "B4:1", "A4:1", "G4:2", "F4:1", "E4:1", "D4:2", "C4:4"] }],
};

/** Library folder as before the library list: one index of its own per package folder. */
function oldLayout(root) {
  const build = (dir) => execFileSync(EXE, ["index", "build", dir, join(dir, OLD)], { stdio: "ignore" });
  build(writePieces(join(root, "PDMX")));
  build(writePieces(join(root, "PDMX-Kostprobe")));
  const own = join(root, "Eigene");
  mkdirSync(own, { recursive: true });
  writeFileSync(join(own, "eigenes-lied.musicxml"), musicXml(OWN_PIECE));
  build(own);
  // a package that is in the folder but not yet in any library
  writePieces(join(root, "DCML-Klassik"));
}

let app;
const test = makeTest(() => app);
before(async () => {
  app = await startApp({ prepare: oldLayout });
});
after(async () => {
  await app?.close();
});

const root = () => join(app.tmp, "bibliothek");
const registry = () => JSON.parse(readFileSync(join(root(), "bibliotheken.json"), "utf8"));
const libInfo = () => app.eval(() => window.__TAURI__.core.invoke("library_info"));
const idle = (what, timeout = 60000) =>
  app.waitFor(async () => {
    const i = await window.__TAURI__.core.invoke("library_info");
    return i.id && !i.loading && !i.adding && !i.building && i.merging == null && !i.download ? i : null;
  }, { timeout, what });
/** Melody search in the active library: titles of the hits. */
const melodyHits = () => app.eval(async (melody) => (await window.__TAURI__.core.invoke("library_search", { melody })).map((h) => h.title), CHORAL_MELODY);
const openManage = async () => {
  await app.eval(() => T.st.showPanel("bibliothek"));
  if (await app.eval(() => !!T.$(".lib-manage[hidden]") || !T.$(".lib-manage"))) await app.clickOn(".lib-name");
  await app.waitFor(() => T.$$(".lib-manage:not([hidden]) .lib-lib").length > 0, { what: "Dialog „Bibliotheken“" });
};
const rows = () => app.eval(() => T.$$(".lib-lib").map((r) => ({ id: r.dataset.id, text: r.textContent, active: r.classList.contains("active") })));
const clickRow = (id, label) => app.eval((id, label) => {
  const r = T.$$(".lib-lib").find((x) => x.dataset.id === id);
  [...r.querySelectorAll(".btn")].find((b) => b.textContent.includes(label)).click();
}, id, label);

test("migration: “Standard” is created from the old indexes, sample becomes its own library", async () => {
  const info = await idle("Bibliothek eingerichtet", 30000);
  assert.equal(info.name, "Standard");
  assert.equal(info.scores, 3, "PDMX (2) + Eigene (1)");
  // made at start, before the UI hands its language to the core – so in English (the pack name is an identifier)
  assert.match(info.message, /Libraries set up: "Standard" with 3 scores \(from (PDMX, Eigene|Eigene, PDMX)\); separate libraries: PDMX – Kostprobe/);
  const reg = registry();
  assert.deepEqual(reg.libraries.map((l) => l.name), ["Standard", "PDMX – Kostprobe"]);
  const std = reg.libraries[0];
  assert.deepEqual(std.packs, ["pdmx-voll"]);
  assert.equal(std.paths.length, 1);
  assert.match(std.paths[0], /Eigene$/);
  assert.equal(reg.libraries[1].scores, 2);
  // old index files are gone (or moved), scores remain
  for (const f of ["PDMX", "Eigene", "PDMX-Kostprobe"]) assert.equal(existsSync(join(root(), f, OLD)), false, `${f}: alter Index weg`);
  assert.ok(existsSync(join(root(), "Eigene", "eigenes-lied.musicxml")));
  assert.ok(existsSync(join(root(), "Indizes", "Standard.kwix")));
  // found from both parts
  assert.ok((await melodyHits()).includes("Testchoral"));
  const own = await app.eval(async () => (await window.__TAURI__.core.invoke("library_search", { text: "Eigenes Lied" })).map((h) => h.title));
  assert.deepEqual([...new Set(own)], ["Eigenes Lied"]);
});

test("“Libraries” dialog shows all, the active one marked", async () => {
  await openManage();
  const r = await rows();
  assert.deepEqual(r.map((x) => x.id), ["standard", "pdmx-kostprobe"]);
  assert.ok(r[0].active && !r[1].active);
  assert.match(r[0].text, /3 Partituren · Paket: PDMX – vollständig · 1 Ordner\/Datei/);
  // Standard cannot be deleted, the other one can
  const del = await app.eval(() => T.$$(".lib-lib").map((x) => [...x.querySelectorAll(".btn")].some((b) => b.textContent.includes("Löschen"))));
  assert.deepEqual(del, [false, true]);
});

test("creating new makes the empty library active – its search is separate", async () => {
  await app.eval(() => {
    T.$(".lib-new input").value = "Versuch";
    T.$$(".lib-new .btn").find((b) => b.textContent.includes("Neu anlegen")).click();
  });
  const info = await app.waitFor(async () => {
    const i = await window.__TAURI__.core.invoke("library_info");
    return i.name === "Versuch" ? i : null;
  }, { what: "neue Bibliothek aktiv" });
  assert.equal(info.scores, 0);
  await app.waitFor(() => T.$(".lib-name b").textContent === "Versuch", { what: "Name in der Leiste" });
  await app.waitFor(() => T.$$(".lib-lib").some((r) => r.dataset.id === "versuch" && r.classList.contains("active")), { what: "Liste aktualisiert" });
  assert.deepEqual(await melodyHits(), [], "keine Treffer aus „Standard“");
  assert.equal(registry().active, "versuch");
  assert.ok(existsSync(join(root(), "Indizes", "Versuch.kwix")));
});

test("adding lands in the active library, “Standard” stays unchanged", async () => {
  await app.mcp("add_to_library", { paths: [join(root(), "Eigene", "eigenes-lied.musicxml")] });
  const info = await idle("übernommen");
  assert.equal(info.name, "Versuch");
  assert.equal(info.scores, 1);
  assert.equal(registry().libraries.find((l) => l.id === "standard").scores, 3);
});

test("switching: back to “Standard” – hits are back", async () => {
  await openManage();
  await clickRow("standard", "Wechseln");
  await app.waitFor(async () => (await window.__TAURI__.core.invoke("library_info")).name === "Standard", { what: "gewechselt" });
  assert.ok((await melodyHits()).includes("Testchoral"));
  assert.equal((await libInfo()).scores, 3);
  assert.equal(registry().active, "standard");
});

test("rename and delete (click twice) – scores remain", async () => {
  await openManage();
  await clickRow("versuch", "Umbenennen");
  await app.eval(() => {
    const i = T.$(".lib-lib-name input");
    i.value = "Versuch 2";
    i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  await app.waitFor(() => T.$$(".lib-lib").some((r) => r.dataset.id === "versuch" && r.textContent.includes("Versuch 2")), { what: "umbenannt" });
  assert.equal(registry().libraries.find((l) => l.id === "versuch").name, "Versuch 2");
  await clickRow("versuch", "Löschen");
  assert.match(await app.eval(() => T.$$(".lib-lib").find((r) => r.dataset.id === "versuch").textContent), /Wirklich löschen\?/);
  await clickRow("versuch", "Wirklich");
  await app.waitFor(() => !T.$$(".lib-lib").some((r) => r.dataset.id === "versuch"), { what: "gelöscht" });
  assert.equal(existsSync(join(root(), "Indizes", "Versuch.kwix")), false, "Index weg");
  assert.ok(existsSync(join(root(), "Eigene", "eigenes-lied.musicxml")), "Partitur bleibt");
  await app.eval(() => T.$(".lib-manage .lib-catalog-head .btn").click());
});

test("catalog: a package in the folder is adopted, afterwards “to Standard”", async () => {
  await app.eval(() => {
    T.st.showPanel("bibliothek");
    if (!T.$(".lib-catalog:not([hidden])")) T.$$(".lib-bar .btn").find((b) => b.textContent.includes("Herunterladen")).click();
  });
  const card = () => app.eval(() => {
    const c = T.$$(".lib-card").find((x) => x.querySelector(".lib-card-title").textContent.startsWith("Klassik, analysiert"));
    return c ? { tag: c.querySelector(".tag")?.textContent ?? null, btn: c.querySelector(".lib-card-foot .btn").textContent, disabled: c.querySelector(".lib-card-foot .btn").disabled } : null;
  });
  await app.waitFor(() => T.$$(".lib-card").length > 3, { what: "Katalog" });
  assert.deepEqual(await card(), { tag: "im Ordner", btn: "Übernehmen", disabled: false });
  // PDMX – the full one is included, so are sample and selection
  const pdmx = await app.eval(() => T.$$(".lib-card").filter((x) => x.querySelector(".lib-card-title").textContent.startsWith("PDMX")).map((x) => x.querySelector(".tag")?.textContent));
  assert.deepEqual(pdmx, ["in „Standard“", "in „Standard“", "in „Standard“"]);
  await app.eval(() => {
    const c = T.$$(".lib-card").find((x) => x.querySelector(".lib-card-title").textContent.startsWith("Klassik, analysiert"));
    c.querySelector(".lib-card-foot .btn").click();
  });
  // two pieces from the DCML folder (different paths than in PDMX)
  const info = await app.waitFor(async () => {
    const i = await window.__TAURI__.core.invoke("library_info");
    return i.scores === 5 && !i.building && i.merging == null ? i : null;
  }, { timeout: 60000, what: "übernommen" });
  assert.match(info.message, /2 Partituren übernommen – „Standard“ hat jetzt 5 Partituren/);
  await app.waitFor(async () => {
    const c = T.$$(".lib-card").find((x) => x.querySelector(".lib-card-title").textContent.startsWith("Klassik, analysiert"));
    return c?.querySelector(".tag")?.textContent === "in „Standard“" && c.querySelector(".lib-card-foot .btn").disabled;
  }, { what: "Karte zeigt „in Standard“" });
  assert.deepEqual(registry().libraries[0].packs, ["pdmx-voll", "dcml-klassik"]);
  assert.equal(existsSync(join(root(), "DCML-Klassik", "klangwelt-auftrag.json")), false, "Auftrag erledigt");
  await app.eval(() => T.$(".lib-catalog-head .btn").click());
  // already included: is not imported again
  await assert.rejects(app.mcp("download_library", { id: "dcml-klassik" }), /„DCML – Klassik, analysiert“ ist in „Standard“ schon enthalten/);
  await assert.rejects(app.mcp("download_library", { id: "pdmx-kostprobe" }), /schon enthalten \(über „PDMX – vollständig“\)/);
});

test("agent: list, create, switch, delete", async () => {
  const list = await app.mcp("list_libraries", {});
  assert.deepEqual(list.map((l) => [l.name, l.active]), [["Standard", true], ["PDMX – Kostprobe", false]]);
  const made = await app.mcp("create_library", { name: "Agent-Versuch" });
  assert.equal(made.id, "agent-versuch");
  assert.equal((await app.mcp("library_status", {})).name, "Agent-Versuch");
  const sw = await app.mcp("switch_library", { library: "PDMX – Kostprobe" });
  assert.equal(sw.aktiv, "PDMX – Kostprobe");
  assert.equal(sw.partituren, 2);
  await app.mcp("delete_library", { library: "agent-versuch" });
  await assert.rejects(app.mcp("delete_library", { library: "Standard" }), /lässt sich nicht löschen/);
  await assert.rejects(app.mcp("switch_library", { library: "Gibt es nicht" }), /Keine Bibliothek „Gibt es nicht“/);
  assert.deepEqual((await app.mcp("list_libraries", {})).map((l) => l.name), ["Standard", "PDMX – Kostprobe"]);
});

test("restart: the active library stays active (without parameter, without UI)", async () => {
  assert.equal((await libInfo()).name, "PDMX – Kostprobe");
  const errors = app.errors;
  await app.stop();
  app = await startApp({ tmp: app.tmp });
  app.errors.push(...errors);
  const info = await idle("nach dem Neustart geladen", 20000);
  assert.equal(info.name, "PDMX – Kostprobe");
  assert.equal(info.scores, 2);
  assert.equal(info.message, null, "kein erneuter Umzug");
  await app.mcp("switch_library", { library: "standard" });
  assert.equal((await libInfo()).scores, 5);
});

test("no errors in the window", () => {
  assert.deepEqual(app.errors, []);
});

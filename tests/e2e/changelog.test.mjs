// "What's new" in the desktop app (klangwelt/ui/src/components/whatsnew.ts): the gear
// menu opens the changes of every version from klangwelt/changelog/, in German and
// without browser-only entries; the app's version is Klangwelt's (klangwelt/ui/package.json,
// app/tauri.conf.json points to it). A first start shows nothing; after an update a note
// with a button and a dot on the gear point to the window until it was opened.
import { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, sleep, startApp, makeTest, injectHelpers } from "./harness.mjs";

const { appData } = await import(pathToFileURL(join(ROOT, "klangwelt", "ui", "scripts", "changelog.mjs")).href);
const VERSION = JSON.parse(readFileSync(join(ROOT, "klangwelt", "ui", "package.json"), "utf8")).version;
const SEEN = "klangwelt.changelog.seen";

/** What the desktop app should show in German: no internal and no browser-only entries. */
function expected() {
  const d = appData("de");
  const keep = (e) => e.platform !== "browser";
  return {
    releases: d.releases.map((r) => ({ ...r, entries: r.entries.filter(keep) })).filter((r) => r.entries.length),
    unreleased: d.unreleased.filter(keep),
  };
}

let app;
const test = makeTest(() => app);
after(async () => {
  await app?.close();
});

/** The open "What's new" window: sections with their entries. */
const dialog = () =>
  app.eval(() => {
    const box = document.querySelector(".modal .whatsnew-list")?.closest(".modal");
    if (!box) return null;
    return {
      title: box.querySelector(".modal-title")?.textContent,
      build: box.querySelector(".whatsnew-build")?.textContent,
      sections: [...box.querySelectorAll(".whatsnew-release")].map((s) => ({
        unreleased: s.classList.contains("unreleased"),
        version: s.dataset.version ?? null,
        fresh: !!s.querySelector(".whatsnew-fresh"),
        ids: [...s.querySelectorAll(".whatsnew-entry")].map((e) => e.dataset.change),
        titles: [...s.querySelectorAll(".whatsnew-title")].map((e) => e.textContent),
        texts: [...s.querySelectorAll(".whatsnew-text")].map((e) => e.textContent),
        images: [...s.querySelectorAll(".whatsnew-entry")].map((e) => e.querySelector("img.whatsnew-image")?.getAttribute("src") ?? null),
      })),
    };
  });

const state = () =>
  app.eval((key) => ({
    seen: localStorage.getItem(key),
    gearDot: document.querySelector('[data-help="einstellungen"]').classList.contains("unread"),
    note: document.querySelector("kw-toast .toast.has-action")?.textContent ?? null,
  }), SEEN);

test("the app's version is Klangwelt's; a first start shows no note and remembers the newest release", async () => {
  app = await startApp();
  assert.equal(await app.eval(() => window.__TAURI__.app.getVersion()), VERSION);
  await app.waitFor((key) => !!localStorage.getItem(key), { what: "remembered release" }, SEEN);
  await sleep(500);
  const s = await state();
  assert.equal(s.seen, expected().releases[0].date);
  assert.equal(s.gearDot, false);
  assert.equal(s.note, null);
});

test("gear menu → What's new: every release in German with bold titles and screenshots, without browser-only entries", async () => {
  await app.clickOn('[data-help="einstellungen"]');
  await app.waitFor(() => /Version \S+/.test(document.querySelector(".set-menu.open [data-whatsnew]")?.textContent ?? ""), { what: "menu entry with version" });
  assert.equal(await app.eval(() => document.querySelector(".set-menu.open [data-whatsnew]").textContent), `NeuigkeitenVersion ${VERSION}`);
  await app.clickOn(".set-menu.open [data-whatsnew]");
  await app.waitFor(() => !!document.querySelector(".modal .whatsnew-list"), { what: "What's new window" });
  const d = await dialog();
  const want = expected();
  assert.equal(d.title, "Neuigkeiten");
  assert.match(d.build, new RegExp(`^Version ${VERSION.replace(/[.+]/g, "\\$&")}`));
  const releases = d.sections.filter((s) => !s.unreleased);
  assert.deepEqual(releases.map((s) => s.version), want.releases.map((r) => r.version));
  for (const [i, r] of want.releases.entries()) {
    assert.deepEqual(releases[i].ids, r.entries.map((e) => e.id), r.version);
    assert.deepEqual(releases[i].texts, r.entries.map((e) => e.text), r.version);
    assert.deepEqual(releases[i].titles, r.entries.map((e) => `${e.title}:`), r.version);
    assert.deepEqual(releases[i].images, r.entries.map((e) => e.image ?? null), r.version);
  }
  const open = d.sections.find((s) => s.unreleased);
  assert.deepEqual(open?.ids ?? [], want.unreleased.map((e) => e.id));
  assert.deepEqual(open?.titles ?? [], want.unreleased.map((e) => `${e.title}:`));
  assert.deepEqual(open?.images ?? [], want.unreleased.map((e) => e.image ?? null));
  // the screenshots come out of the exe (CSP img-src 'self') and load when scrolled into view
  const pictures = await app.eval(async () => {
    const out = [];
    for (const img of document.querySelectorAll(".modal img.whatsnew-image")) {
      img.scrollIntoView({ block: "center" });
      const t0 = performance.now();
      while (!(img.complete && img.naturalWidth) && performance.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 50));
      out.push({ src: img.getAttribute("src"), loaded: img.naturalWidth > 0, bold: Number(getComputedStyle(img.closest(".whatsnew-entry").querySelector(".whatsnew-title")).fontWeight) >= 600 });
    }
    return out;
  });
  const withImage = d.sections.flatMap((s) => s.images).filter(Boolean);
  assert.deepEqual(pictures.map((p) => p.src), withImage);
  for (const p of pictures) {
    assert.ok(p.loaded, `${p.src} loads`);
    assert.ok(p.bold, "title in bold");
  }
  // the browser's own entries stay out
  const all = d.sections.flatMap((s) => s.ids);
  const browserOnly = [...appData("de").releases.flatMap((r) => r.entries), ...appData("de").unreleased].filter((e) => e.platform === "browser").map((e) => e.id);
  for (const id of browserOnly) assert.ok(!all.includes(id), `${id} is browser-only`);
  await app.key("Escape");
  await app.waitFor(() => !document.querySelector(".modal"), { what: "window closed" });
});

test("after an update: note with a button and the dot on the gear, gone once the window was opened", async () => {
  const [newest, before] = expected().releases;
  assert.ok(before, "two releases to step back");
  await app.eval((key, date) => localStorage.setItem(key, date), SEEN, before.date);
  await app.send("Page.reload", {});
  await app.waitFor(() => !window.T, { timeout: 15000, what: "reload" });
  await injectHelpers(app);
  await app.waitFor(() => !!document.querySelector("kw-toast .toast.has-action"), { timeout: 10000, what: "update note" });
  let s = await state();
  const n = newest.entries.length;
  assert.equal(s.note, `Klangwelt wurde aktualisiert: ${n === 1 ? "eine Änderung" : `${n} Änderungen`} in Version ${newest.version}Neuigkeiten ansehen`);
  assert.equal(s.gearDot, true);

  await app.clickOn("kw-toast .toast-action");
  await app.waitFor(() => !!document.querySelector(".modal .whatsnew-list"), { what: "What's new window" });
  const d = await dialog();
  assert.deepEqual(d.sections.filter((x) => x.fresh).map((x) => x.version), [newest.version]);
  s = await state();
  assert.equal(s.gearDot, false);
  assert.equal(s.seen, newest.date);
  await app.key("Escape");
});

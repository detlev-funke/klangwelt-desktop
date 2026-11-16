// Narrow desktop windows: the toolbar shrinks in steps (Save moves into the File
// menu, where Export always is; the gear always stays), and a window too small for
// the docking layout shows the compact view. At the usual sizes the layout stays.
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

async function size(width, height) {
  await app.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
}

const bar = () =>
  app.eval(() => {
    const tr = T.$("kw-transport");
    const shown = (sel) => !!T.$(sel)?.getClientRects().length;
    const g = T.$('kw-transport [data-help="einstellungen"]').getBoundingClientRect();
    return {
      fit: Number(tr.dataset.fit),
      gear: g.width > 0 && g.left >= 0 && g.right <= innerWidth,
      right: Math.max(...[...tr.children].map((c) => c.getBoundingClientRect()).filter((b) => b.width).map((b) => b.right)),
      save: shown("kw-transport .save-btn"),
      more: shown("kw-transport .more-btn"),
      mode: T.$("#dock").dataset.mode,
      width: innerWidth,
    };
  });

test("usual window sizes: full toolbar with Save (Export only in the File menu), the docking layout", async () => {
  for (const [w, h] of [[1600, 1000], [1440, 900]]) {
    await size(w, h);
    const b = await bar();
    assert.ok(b.right <= w, `${w} px: a control ends at ${b.right}`);
    assert.ok(b.gear && b.save && !b.more, `${w} px: ${JSON.stringify(b)}`);
    assert.equal(await app.eval(() => T.$("kw-transport .export-btn")), null, "no Export button");
    assert.equal(b.mode, "dock");
  }
  await size(1600, 1000);
  assert.equal((await bar()).fit, 0, "1600 px: nothing left out");
});

test("narrow window: Save and Export in the File menu, the gear stays, nothing sticks out", async () => {
  await size(520, 800);
  const b = await bar();
  assert.ok(b.right <= 520 && b.gear, JSON.stringify(b));
  assert.ok(!b.save && b.more, JSON.stringify(b));
  await app.clickOn("kw-transport .file-btn");
  const items = await app.eval(() => T.$$(".file-menu.open .menu-item").map((i) => i.firstChild.textContent));
  assert.ok(items.includes("Speichern") && items.includes("Exportieren …"), items.join(", "));
  await app.eval(() => T.$$(".menu.open").forEach((m) => m.classList.remove("open")));
  await size(1600, 1000);
});

test("window too small for the layout: compact view, \"Dock windows freely\" brings the layout back", async () => {
  await size(600, 800);
  assert.equal((await bar()).mode, "sheet");
  const stacks = await app.eval(() => T.$$("#dock .dk-stack").map((s) => [...s.querySelectorAll(".dk-tab")].map((t) => t.dataset.panel)));
  assert.deepEqual(stacks[0], ["spuren"]);
  await app.clickOn("kw-transport .win-btn");
  await app.clickOn(".win-menu.open .free-layout");
  await app.waitFor(() => T.$("#dock").dataset.mode === "dock", { what: "docking layout" });
  await app.clickOn("kw-transport .win-btn");
  await app.clickOn(".win-menu.open .free-layout");
  await app.waitFor(() => T.$("#dock").dataset.mode === "sheet", { what: "compact view" });
  // large again: the arranged layout as before
  await size(1600, 1000);
  assert.equal((await bar()).mode, "dock");
  assert.ok((await app.eval(() => T.$$("#dock .dk-stack").length)) >= 3);
  assert.deepEqual(app.errors ?? [], []);
});

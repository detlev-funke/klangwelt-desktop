// Languages in the desktop app (klangwelt/ui/src/i18n.ts): the WebView's
// preferred languages pick the language, the settings menu switches it, the
// choice survives a restart, and the Rust core – including this shell's own
// messages (app/src) – speaks the same language.
import { after, test as plainTest } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, startApp, makeTest, injectHelpers } from "./harness.mjs";

let app;
const test = makeTest(() => app);
after(async () => {
  await app?.close();
});

const keysScript = pathToFileURL(join(ROOT, "klangwelt", "ui", "scripts", "i18n-keys.mjs")).href;

plainTest("every message of the desktop shell is in every dictionary", async () => {
  const { collectKeys, checkDict, keysFor, loadDict } = await import(keysScript);
  const { keys, problems } = collectKeys([join(ROOT, "app", "src")]);
  assert.deepEqual(problems, []);
  assert.ok(keys.size > 50, `only ${keys.size} keys in app/src`);
  for (const code of ["en", "de", "fr", "it", "es", "nl", "pl"]) {
    const { missing, badVars } = checkDict(await loadDict(code), keysFor(code, keys));
    assert.deepEqual(missing, [], `missing in ${code}`);
    assert.deepEqual(badVars, [], `placeholders in ${code}`);
  }
});

/** Language, the settings button's tooltip and what the dictionary gives for it. */
const ui = () =>
  app.eval(async () => {
    const i18n = await import("./i18n.js");
    return {
      lang: document.documentElement.lang,
      settings: document.querySelector('[data-help="einstellungen"]')?.title,
      expected: i18n.t("Settings"),
      stored: localStorage.getItem(i18n.STORAGE_KEY),
    };
  });

/** Error of the core (unknown track) and what the dictionary says for it. */
const coreError = () =>
  app.eval(async () => {
    const i18n = await import("./i18n.js");
    const { backend } = await import("./bridge.js");
    let text = null;
    try {
      await backend.execute({ type: "removeTrack", trackId: 424242 });
    } catch (e) {
      text = T.st.errorText(e);
    }
    return { text, expected: i18n.t("Track {id} not found", { id: 424242 }) };
  });

test("French WebView: UI and core in French", async () => {
  app = await startApp({ languages: "fr-FR,fr" });
  const u = await ui();
  assert.equal(u.lang, "fr");
  assert.equal(u.settings, u.expected);
  assert.notEqual(u.settings, "Settings");
  assert.equal(u.stored, null);
  const err = await coreError();
  assert.equal(err.text, err.expected);
  assert.notEqual(err.text, "Track 424242 not found");
  await app.close();
  app = null;
});

test("switch to English in the settings menu; the choice survives a restart", async () => {
  app = await startApp();
  assert.equal((await ui()).settings, "Einstellungen");
  await app.clickOn('[data-help="einstellungen"]');
  await app.waitFor(() => document.querySelectorAll(".set-menu.open [data-lang]").length === 7, { what: "language menu" });
  await app.clickOn('.set-menu.open [data-lang="en"]');
  // the UI reloads; the core keeps running and gets the new dictionary
  await app.waitFor(() => !window.T, { timeout: 15000, what: "reload" });
  await injectHelpers(app);
  let u = await ui();
  assert.equal(u.lang, "en");
  assert.equal(u.settings, "Settings");
  assert.equal(u.stored, "en");
  assert.equal((await coreError()).text, "Track 424242 not found");

  await app.stop();
  app = await startApp({ tmp: app.tmp });
  u = await ui();
  assert.equal(u.lang, "en");
  assert.equal(u.settings, "Settings");
  assert.equal((await coreError()).text, "Track 424242 not found");
});

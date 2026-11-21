// Temporary folders of the tests (klangwelt/tests/tempdirs.mjs): close() ends the app
// together with its WebView2 processes and leaves neither its folder (library, WebView
// profile) nor a process behind – also after a restart in the same folder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { startApp } from "./harness.mjs";
import { processesNaming } from "../../klangwelt/tests/tempdirs.mjs";

test("close() ends the app with its WebView2 processes and removes its folder", async () => {
  let app = await startApp();
  const { tmp } = app;
  try {
    assert.ok(existsSync(join(tmp, "webview")), "WebView profile in the temp folder");
    assert.ok((await processesNaming(tmp)).length > 0, "WebView2 names its profile on the command line");
    await app.stop();
    assert.ok(existsSync(tmp), "stop() keeps the folder for a restart");
    app = await startApp({ tmp });
  } finally {
    await app.close();
  }
  assert.equal(existsSync(tmp), false, `folder removed: ${tmp}`);
  assert.deepEqual(await processesNaming(tmp), [], "no WebView2 process left");
});

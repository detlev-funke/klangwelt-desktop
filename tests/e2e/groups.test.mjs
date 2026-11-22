// Track groups on the desktop: the agent groups tracks over MCP (addGroup with a placeholder,
// setTrack group), the track list shows the group's row with its tracks indented; the group's
// mute and level reach the mix (chat context, project), folding hides the tracks; dragging a
// track by its icon takes it out of the group; Ctrl+click picks tracks and Ctrl+G groups them;
// the sound window changes every picked track with the same instrument.
import { before, after } from "node:test";
import assert from "node:assert/strict";
import { startApp, makeTest, MOD, sleep } from "./harness.mjs";

let app;
const test = makeTest(() => app);
before(async () => {
  app = await startApp();
  await app.reset();
});
after(async () => {
  await app?.close();
});

const project = () => app.eval(() => T.st.snapshot.peek().project);
const rowOf = (name) =>
  app.eval((n) => `.track-row[data-track-id="${T.st.snapshot.peek().project.tracks.find((t) => t.name === n).id}"]`, name);
const listed = () =>
  app.eval(() => {
    const p = T.st.snapshot.peek().project;
    return T.$$(".tracks-body > *").map((el) => (el.classList.contains("group-row") ? `G:${el.querySelector("input.text").value}` : p.tracks.find((t) => t.id === Number(el.dataset.trackId))?.name));
  });

test("the agent groups tracks: a group row with its tracks, level and mute of the group in the mix", async () => {
  const r = await app.mcp("execute", { commands: [
    { type: "addTrack", track: { ref: "$v1", name: "Violin 1", kind: "instrument" } },
    { type: "addTrack", track: { ref: "$va", name: "Viola", kind: "instrument" } },
    { type: "addTrack", track: { ref: "$v2", name: "Violin 2", kind: "instrument" } },
    { type: "addGroup", group: { ref: "$violins", name: "Violins", gainDb: -3 } },
    { type: "setTrack", trackId: "$v1", patch: { group: "$violins" } },
    { type: "setTrack", trackId: "$v2", patch: { group: "$violins" } },
    { type: "moveTrack", trackId: "$v2", index: 1 },
  ] });
  const g = r.ids.$violins;
  await app.waitFor(() => T.$$(".group-row").length === 1, { what: "group row" });
  assert.deepEqual(await listed(), ["G:Violins", "Violin 1", "Violin 2", "Viola"]);
  assert.equal(await app.eval(() => T.$(".group-row .group-db").textContent), "-3.0 dB");

  await app.clickOn(".group-row .toggle.m");
  await app.waitFor(() => T.st.snapshot.peek().project.groups[0].mute, { what: "group muted" });
  const p = await app.mcp("get_project", { fields: ["groups", "tracks.name", "tracks.group"] });
  assert.equal(p.groups[0].mute, true);
  assert.deepEqual(p.tracks.filter((t) => t.group === g).map((t) => t.name), ["Violin 1", "Violin 2"]);
  await app.clickOn(".group-row .toggle.m");

  await app.clickOn(".group-row .group-fold");
  await app.waitFor(() => T.$$(".track-row").length === 1, { what: "folded" });
  await app.clickOn(".group-row .group-fold");
  await app.waitFor(() => T.$$(".track-row").length === 3, { what: "unfolded" });
});

test("dragging a track by its icon below the group takes it out; Ctrl+click and Ctrl+G group again", async () => {
  const v2 = await rowOf("Violin 2");
  const grip = await app.center(`${v2} .kind`);
  const viola = await app.center(`${await rowOf("Viola")} .stripe`);
  // onto the lower half of the viola (outside the group): after it, without a group
  await app.drag([grip.x, grip.y], [grip.x, viola.y + viola.h / 4], { steps: 10 });
  await app.waitFor(() => !T.st.snapshot.peek().project.tracks.find((t) => t.name === "Violin 2").group, { what: "out of the group" });
  assert.deepEqual(await listed(), ["G:Violins", "Violin 1", "Viola", "Violin 2"]);

  const a = await app.center(`${await rowOf("Viola")} .stripe`);
  await app.click(a.x, a.y);
  const b = await app.center(`${await rowOf("Violin 2")} .stripe`);
  await app.click(b.x, b.y, { mods: MOD.ctrl });
  await app.key("g", { mods: MOD.ctrl });
  await app.waitFor(() => (T.st.snapshot.peek().project.groups ?? []).length === 2, { what: "second group" });
  assert.deepEqual(await listed(), ["G:Violins", "Violin 1", "G:Gruppe 1", "Viola", "Violin 2"]);
});

test("the sound window changes every picked track with the same instrument", async () => {
  // (grouping cleared the pick: pick the two again)
  const a = await app.center(`${await rowOf("Viola")} .stripe`);
  await app.click(a.x, a.y);
  const b = await app.center(`${await rowOf("Violin 2")} .stripe`);
  await app.click(b.x, b.y, { mods: MOD.ctrl });
  await app.eval(() => T.st.showPanel("klang"));
  await app.waitFor(() => !!T.$(".snd-multi") && !T.$(".snd-multi").hidden, { what: "note: two tracks" });
  const ids = await app.eval(() => ["Viola", "Violin 2"].map((n) => T.st.snapshot.peek().project.tracks.find((t) => t.name === n).id));
  const before = await project();
  await app.eval(() => {
    T.$(".snd-fine").open = true;
    const r = T.$(".snd-fine input[type=range]");
    r.value = r.min;
    r.dispatchEvent(new Event("input"));
    r.dispatchEvent(new Event("change"));
  });
  await sleep(400);
  const after = await project();
  const params = (p, id) => p.tracks.find((t) => t.id === id).instrument.params;
  const changed = Object.keys(params(after, ids[1])).filter((k) => params(after, ids[1])[k] !== params(before, ids[1])[k]);
  assert.ok(changed.length > 0, "the selected track changed");
  for (const k of changed) assert.equal(params(after, ids[0])[k], params(after, ids[1])[k], `the other picked track follows ${k}`);
  assert.deepEqual(app.errors ?? [], []);
});

// The desktop app's side of a release (klangwelt/changelog/README.md): after
// `npm run changelog -- release` in klangwelt, this moves the klangwelt/ submodule to
// the release commit (if it isn't there yet), commits that pointer and sets the same
// tag here. Pushing the tag lets .github/workflows/release.yml build and publish the exe.
// Nothing is pushed. Node built-ins only.
//
//   npm run release:tag                     the newest release of klangwelt
//   npm run release:tag -- 2026.11.21+1430  a given one
//   --trailer="Co-Authored-By: …"           added to the commit message

import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SUB = join(ROOT, "klangwelt");
const TAG_RE = /^v(\d{4})\.(\d{1,2})\.(\d{1,2})\+(\d{2})(\d{2})$/;

function git(cwd, args, opts = {}) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: [opts.input == null ? "ignore" : "pipe", "pipe", "pipe"], ...opts }).trim();
}

/** Sort key of a release tag (date and time), -1 for other tags. */
function when(tag) {
  const m = TAG_RE.exec(tag);
  return m ? (((+m[1] * 100 + +m[2]) * 100 + +m[3]) * 100 + +m[4]) * 100 + +m[5] : -1;
}

function main(args) {
  const wanted = args.find((a) => !a.startsWith("--"));
  const trailers = args.filter((a) => a.startsWith("--trailer=")).map((a) => a.slice(10));

  try {
    git(SUB, ["fetch", "--quiet", "--tags", "origin"]);
  } catch (e) {
    console.warn(`klangwelt/: fetching tags failed, using the ones it has (${e.stderr?.trim() || e.message})`);
  }
  const tags = git(SUB, ["tag", "--list", "v*"]).split("\n").filter((t) => when(t) >= 0);
  const tag = wanted ? `v${wanted.replace(/^v/, "")}` : tags.sort((a, b) => when(b) - when(a))[0];
  if (!tag) throw new Error("klangwelt has no release tag yet – first `npm run changelog -- release` in klangwelt/ui");
  if (!tags.includes(tag)) throw new Error(`klangwelt has no tag ${tag}`);
  const version = tag.slice(1);
  if (git(ROOT, ["tag", "--list", tag])) throw new Error(`tag ${tag} exists here already`);

  const target = git(SUB, ["rev-parse", `${tag}^{commit}`]);
  const pkg = JSON.parse(git(SUB, ["show", `${target}:ui/package.json`])).version;
  if (pkg !== version) throw new Error(`${tag} has version ${pkg} in ui/package.json`);

  // the submodule's working tree: at the release commit, without changes of its own
  if (git(SUB, ["status", "--porcelain", "--untracked-files=no"])) throw new Error("klangwelt/ has uncommitted changes – commit or discard them first");
  const current = git(SUB, ["rev-parse", "HEAD"]);
  if (current !== target) {
    try {
      git(SUB, ["merge-base", "--is-ancestor", current, target]);
    } catch {
      throw new Error(`klangwelt/ is at ${current.slice(0, 7)}, which ${tag} doesn't contain – make a new release in klangwelt that includes it`);
    }
    let branch = null;
    try {
      branch = git(SUB, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    } catch {
      /* detached */
    }
    if (branch) git(SUB, ["merge", "--quiet", "--ff-only", target]);
    else git(SUB, ["checkout", "--quiet", "--detach", target]);
  }

  // the pointer in this repo's HEAD
  const pointer = git(ROOT, ["ls-tree", "HEAD", "klangwelt"]).split(/\s+/)[2];
  if (pointer !== target) {
    const message = [`Release ${version}`, "", `klangwelt ${version} (${target.slice(0, 7)}).`, ...(trailers.length ? ["", ...trailers] : [])].join("\n");
    git(ROOT, ["commit", "--quiet", "--only", "-F", "-", "--", "klangwelt"], { input: message });
  }
  git(ROOT, ["tag", "-a", tag, "-m", `Klangwelt ${version}`]);
  console.log(`Tagged ${tag} locally${pointer !== target ? " (with a commit moving klangwelt/ to it)" : ""} – nothing was pushed.`);
}

try {
  main(process.argv.slice(2));
} catch (e) {
  console.error(`release:tag: ${e.message}`);
  process.exit(1);
}

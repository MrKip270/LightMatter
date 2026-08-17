// Tests for backend/sources/lightpollutiongrid.js's error paths.
//
// The grid loads synchronously at require() time and Node caches modules —
// there's no seam to re-trigger a load with a different path from within a
// single process, and touching the real 23 MB data file (even temporarily)
// to simulate "missing" isn't acceptable. LIGHTPOLLUTION_GRID_PATH exists
// specifically so a spawned child process can point at a different (missing
// or wrong) file, exercising the real catch branches without any of that.

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

function loadErrorWithPath(gridPath) {
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `console.log(require(${JSON.stringify(
        path.join(__dirname, "..", "backend", "sources", "lightpollutiongrid")
      )}).loadError)`,
    ],
    {
      env: { ...process.env, LIGHTPOLLUTION_GRID_PATH: gridPath },
      encoding: "utf8",
    }
  );
  return result.stdout.trim();
}

test("a missing grid file produces the ENOENT-specific message", () => {
  const message = loadErrorWithPath("/definitely/does/not/exist.bin");
  assert.match(message, /Light pollution grid not built/);
  assert.match(message, /tools\/build-lightpollution\.js/);
});

test("a real but wrong file produces the generic corrupt-file message", () => {
  // Any real, readable, non-grid file exercises the non-ENOENT catch branch
  // — the header-length parse or the JSON.parse of the header will fail.
  const message = loadErrorWithPath(path.join(__dirname, "..", "package.json"));
  assert.match(message, /Could not load light pollution grid/);
});

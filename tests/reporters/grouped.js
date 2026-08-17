// LightMatter — grouped test reporter
//
// Node's default 'spec' reporter prints every single test name, which is
// fine at 20 tests and noisy at 170+. This reporter prints ONE line per test
// FILE ("✔ tests/moon.test.js — 23 passed") instead, with full failure
// detail printed underneath any file that had one — so a green run stays
// scannable, and a red run still tells you exactly what broke and why.
//
// Node's test runner already emits a per-file rollup (a `test:summary` event
// with `data.file` set) and one more at the very end with `data.file`
// absent, holding the grand total. This reporter reads those directly rather
// than hand-counting passes/fails itself, so its counts can never drift from
// what Node itself considers true.
//
// Contract: a custom reporter is an async generator that consumes Node's
// test-event stream and yields strings to print. It must consume the WHOLE
// stream and must never call process.exit() — the test runner sets the exit
// code itself once the stream ends, independent of what a reporter prints.

const path = require("path");

module.exports = async function* groupedReporter(source) {
  // Buffered per file, keyed by the absolute path Node reports. Printed only
  // once that file's summary event arrives, so failure detail stays grouped
  // with the file it belongs to rather than interleaved with other files
  // running concurrently.
  const failuresByFile = new Map();

  for await (const event of source) {
    if (event.type === "test:fail") {
      const { file, name, details } = event.data;
      if (!failuresByFile.has(file)) failuresByFile.set(file, []);
      failuresByFile.get(file).push({ name, error: details?.error });
      continue;
    }

    if (event.type === "test:summary") {
      const { file, counts, duration_ms } = event.data;

      // The file-less summary is the grand total, printed last.
      if (!file) {
        const bits = [`${counts.passed} passed`, `${counts.failed} failed`];
        if (counts.skipped) bits.push(`${counts.skipped} skipped`);
        if (counts.cancelled) bits.push(`${counts.cancelled} cancelled`);
        yield `\n— ${bits.join(", ")} (${(duration_ms / 1000).toFixed(2)}s) —\n`;
        continue;
      }

      const relFile = path.relative(process.cwd(), file);
      const mark = counts.failed > 0 ? "✖" : "✔";
      const bits = [];
      if (counts.failed) bits.push(`${counts.failed} failed`);
      bits.push(`${counts.passed} passed`);
      if (counts.skipped) bits.push(`${counts.skipped} skipped`);
      yield `${mark} ${relFile} — ${bits.join(", ")}\n`;

      const failures = failuresByFile.get(file);
      if (failures) {
        for (const { name, error } of failures) {
          yield `    ✖ ${name}\n`;
          const detail = error?.stack || error?.message || String(error);
          for (const line of String(detail).split("\n")) yield `      ${line}\n`;
          // The AssertionError under .cause carries the real throw site and,
          // for assert.equal-style failures, the actual/expected diff — the
          // top-level error's own stack is usually just "did not match".
          if (error?.cause?.stack && error.cause.stack !== error.stack) {
            yield `      ---\n`;
            for (const line of String(error.cause.stack).split("\n")) yield `      ${line}\n`;
          }
        }
      }
      continue;
    }

    // test:start, test:pass, test:diagnostic, test:stdout/stderr,
    // test:enqueue/dequeue — exactly the per-test noise this reporter exists
    // to suppress. Deliberately ignored.
  }
};

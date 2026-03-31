import assert from "node:assert/strict";
import {
  cycleSearchIndex,
  findTextMatches,
  splitTextForHighlights,
} from "./textSearch";

const caseInsensitiveMatches = findTextMatches("Alpha beta ALPHA", "alpha");
assert.deepEqual(caseInsensitiveMatches, [
  { start: 0, end: 5 },
  { start: 11, end: 16 },
]);

const segments = splitTextForHighlights("Alpha beta", [{ start: 6, end: 10 }]);
assert.deepEqual(segments, [
  { text: "Alpha ", match: false },
  { text: "beta", match: true },
]);

assert.equal(cycleSearchIndex(-1, 3, "next"), 0);
assert.equal(cycleSearchIndex(0, 3, "previous"), 2);
assert.equal(cycleSearchIndex(2, 3, "next"), 0);
assert.equal(cycleSearchIndex(1, 0, "next"), -1);

console.log("textSearch.extreme.spec.ts passed");

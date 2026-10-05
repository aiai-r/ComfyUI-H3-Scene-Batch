import assert from "node:assert/strict";
import { readPlan, updateCut } from "./web/director_plan.js";

const original = {
  id: "cut01", prompt: "Keep this exact text.\n", length: 362,
  seed: "18446744073709551615", steps: 4, continuation: "previous", custom: { note: "keep" },
};
const fields = { id: original.id, prompt: original.prompt, seconds: "", seed: original.seed };
assert.deepEqual(updateCut(original, fields), original);
const changed = updateCut(original, { ...fields, seconds: "8.5", prompt: "Changed action." });
assert.equal(changed.duration_seconds, 8.5);
assert.equal(changed.length, undefined);
assert.equal(changed.seed, "18446744073709551615");
assert.deepEqual(changed.custom, original.custom);
assert.equal(original.length, 362, "Cancel can discard edits without mutating the source");
assert.equal(updateCut(original, { ...fields, seed: "" }).seed, undefined);
assert.equal(updateCut({}, { id: "cut02", prompt: "Next", seconds: "15", seed: "0" }).seed, "0");
assert.throws(() => updateCut(original, { ...fields, seed: "18446744073709551616" }), /seed/);
assert.throws(() => updateCut(original, { ...fields, seconds: "NaN" }), /生成秒数/);
const imported = readPlan(JSON.stringify({ prompt_prefix: "Shared", defaults: { duration_seconds: 10 }, shots: [original] }));
assert.deepEqual(imported.shots[0], original);
assert.deepEqual(imported.defaults, { duration_seconds: 10 });
assert.throws(() => readPlan('{"shots":[{"seed":18446744073709551615}]}'), /引用符/);
assert.throws(() => readPlan('{"shots":[]}'), /shots/);
assert.throws(() => readPlan('[{"prompt":"not a plan"}]'), /shots/);
console.log("PASS: Plan import, exact uint64 seeds, frame preservation, seconds edits, unknown fields, and non-mutating edits.");

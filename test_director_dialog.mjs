import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { draftGraph, readDraft, sceneAssets, referenceDescriptions, imageAnalysisKey } from "./web/director_llm.js";

const calls = [], history = new Map(), bytes = new Map([["one.png", "one"], ["two.png", "two"]]);
let failed = false, pending;
const api = { async fetchApi(path, options) {
  if (path.startsWith("/view?")) return { ok: true, arrayBuffer: async () => new TextEncoder().encode(bytes.get(new URL(path, "http://localhost").searchParams.get("filename"))).buffer };
  if (path.startsWith("/history/")) { const id = path.split("/").pop(); return { ok: true, json: async () => ({ [id]: history.get(id) }) }; }
  if (path === "/prompt") {
    const graph = JSON.parse(options.body).prompt; calls.push(graph); const id = String(calls.length);
    history.set(id, failed ? { status: { status_str: "error", messages: [["execution_error", { exception_message: "LLM failed" }]] } }
      : { status: { completed: true }, outputs: { result: { text: ["Observations " + id] } } });
    if (pending) return new Promise(resolve => { pending.resolve = () => resolve({ ok: true, json: async () => ({ prompt_id: id }) }); });
    return { ok: true, json: async () => ({ prompt_id: id }) };
  }
  assert.ok(["/queue", "/interrupt"].includes(path));
  return { ok: true, json: async () => ({}) };
} };
const source = (await readFile(new URL("./web/director_dialog.js", import.meta.url), "utf8")).replace(/^import .*;\r?\n/gm, "").replaceAll("export ", "");
let nextSeed = 1000;
const LLM = new Function("api", "draftGraph", "readDraft", "sceneAssets", "referenceDescriptions", "imageAnalysisKey", "crypto", source + "\nreturn DirectorLLM;")(
  api, draftGraph, readDraft, sceneAssets, referenceDescriptions, imageAnalysisKey, { getRandomValues: values => { values[0] = ++nextSeed; return values; } });
const node = { properties: { h3_llm: { loader: { model: "existing" }, story: { inputs: {}, parameters: {} }, prompt: { inputs: {}, parameters: {} } } }, graph: { change() {} } };
const scene = { mode: "R2V", assets: [{ kind: "image", file: "one.png" }, { kind: "image", file: "two.png" }] };
const llm = new LLM(node, () => {});
await llm.analyze(scene);
assert.equal(calls.length, 2);
assert.ok(calls.every(g => JSON.parse(g.images.inputs.scene_json).assets.length === 1));
llm.imageRecord(scene.assets[0]).text = "手動の観察結果";
const reused = await llm.analyze(scene);
assert.equal(calls.length, 2);
assert.match(reused, /<Picture 1>\n手動の観察結果/);
bytes.set("two.png", "replacement at same filename");
await llm.analyze(scene);
assert.equal(calls.length, 3);
assert.equal(JSON.parse(calls.at(-1).images.inputs.scene_json).assets[0].file, "two.png");
await llm.analyze(scene, [scene.assets[0]], true);
assert.equal(calls.length, 4);
const swapped = { ...scene, assets: [...scene.assets].reverse() };
assert.match(await llm.analyze(swapped), /^<Picture 1>\nObservations 3/);
assert.equal(calls.length, 4, "Slot order changes labels without reanalyzing images");
assert.equal(await llm.analyze({ ...scene, mode: "T2V" }), "");
assert.equal(calls.length, 4);

bytes.set("copy.png", "one");
const copy = { kind: "image", file: "another-folder/copy.png", role: "first", note: "New note" };
await llm.matchImage(copy);
assert.equal(llm.imageRecord(copy), llm.imageRecord(scene.assets[0]), "Same bytes under a new name share the analysis immediately after import");
for (const [mode, role, label] of [["R2V", "reference", "<Picture 1>"], ["I2V", "first", "first frame"], ["L2V", "last", "<Picture 1>"]]) {
  assert.equal(await llm.analyze({ mode, assets: [{ ...copy, role }] }), `${label}\nObservations 4`);
}
const paired = { mode: "FL2V", assets: [{ ...copy, role: "first" }, { ...scene.assets[0], role: "last" }] };
assert.equal(await llm.analyze(paired), "first frame\nObservations 4\n\nlast frame\nObservations 4");
assert.equal(calls.length, 4, "Modes and duplicate first/last images reuse one analysis");
node.properties = JSON.parse(JSON.stringify(node.properties));
const restored = new LLM(node, () => {});
restored.imageRecord(copy).text = "Edited after reload";
assert.equal(restored.imageRecord(scene.assets[0]).text, "Edited after reload");
assert.match(await restored.analyze(paired), /first frame\nEdited after reload/);
assert.equal(calls.length, 4, "Workflow reload preserves content aliases and edits");
node.properties.h3_llm.loader.model = "changed";
await llm.analyze(paired);
assert.equal(calls.length, 5, "A changed model runs once for duplicate images");
node.properties.h3_llm.prompt.parameters.temperature = 0.2;
await llm.analyze(paired);
assert.equal(calls.length, 6, "Changed analysis settings invalidate reuse");
node.properties.h3_llm.loader.model = "existing";
delete node.properties.h3_llm.prompt.parameters.temperature;
assert.match(await llm.analyze(paired), /Edited after reload/);
assert.equal(calls.length, 6);

const legacyId = JSON.stringify(["one.png", "reference", ""]);
const legacyNode = { properties: { h3_llm: structuredClone(node.properties.h3_llm), h3_image_analyses: { [legacyId]: { text: "以前の日本語解析", key: "old-key" } } } };
const legacy = new LLM(legacyNode, () => {});
await legacy.analyze({ mode: "R2V", assets: [scene.assets[0]] });
assert.equal(calls.length, 7, "Old Japanese analysis is replaced with a fresh English analysis once");
assert.equal(legacyNode.properties.h3_image_analyses[legacyId].text, "以前の日本語解析");
assert.match(legacy.imageRecord(scene.assets[0]).text, /^Observations/);
await legacy.analyze({ mode: "I2V", assets: [{ ...scene.assets[0], role: "first" }] });
assert.equal(calls.length, 7);

failed = true;
const record = structuredClone(llm.imageRecord(scene.assets[0]));
await assert.rejects(llm.analyze(scene, [scene.assets[0]], true), /LLM failed/);
assert.deepEqual(llm.imageRecord(scene.assets[0]), record, "Failure retains previous analysis");
failed = false;
pending = {};
const running = llm.analyze(scene, [scene.assets[0]], true);
while (!pending.resolve) await new Promise(resolve => setImmediate(resolve));
await llm.stop(); pending.resolve(); pending = null;
await assert.rejects(running, /中止/);
assert.deepEqual(llm.imageRecord(scene.assets[0]), record);
assert.equal(llm.promptId, null);
llm.cancelled = false;
for (const change of [() => bytes.set("one.png", "changed during inference"), () => { node.properties.h3_llm.loader.model = "changed during inference"; }]) {
  pending = {};
  const running = llm.analyze(scene, [scene.assets[0]], true);
  while (!pending.resolve) await new Promise(resolve => setImmediate(resolve));
  const previous = { ...llm.imageRecord(scene.assets[0]) };
  change(); pending.resolve(); pending = null;
  await assert.rejects(running, /処理中に画像またはLLM設定が変わりました/);
  assert.deepEqual(llm.imageRecord(scene.assets[0]), previous, "Changed inputs must not receive mismatched analysis");
}
console.log("Director LLM: content reuse across modes/names, persistence, edits, settings, legacy analysis, replacement, T2V, failure, cancellation and input races passed.");

await llm.analyze(scene);
const analysisCalls = calls.length;
const originalConfig = structuredClone(node.properties.h3_llm);
const originalAnalyses = structuredClone(node.properties.h3_image_analyses);
const plan = { shots: [{ id: 'cut1', prompt: 'Original', seed: '18446744073709551615', duration_seconds: 5 }] };
const originalPlan = structuredClone(plan);
const state = { story: 'Walk through a garden.', instruction: 'Keep walking.', includePrevious: false };
const generated = [];
let reply = '{"shots":[{"prompt":"Walk slowly."}]}';
llm.execute = async graph => { generated.push(graph); return reply; };
for (const action of ['story', 'story', 'prompt', 'prompt']) {
  await llm.create(plan, scene, 0, state, action, () => {});
}
assert.equal(new Set(generated.map(g => g.writer.inputs.seed)).size, 4);
for (const [first, second] of [[0, 1], [2, 3]]) {
  const before = structuredClone(generated[first]), after = structuredClone(generated[second]);
  delete before.writer.inputs.seed; delete after.writer.inputs.seed;
  assert.deepEqual(before, after, 'Only the LLM seed changes on repeated creation');
}
reply = '{"shots":[{"prompt":"incomplete';
await assert.rejects(llm.create(plan, scene, 0, state, 'prompt', () => {}), /Prompt|返答/);
const failedSeed = generated.at(-1).writer.inputs.seed;
reply = '{"shots":[{""prompt":"Recovered complete prompt."}]}';
const repaired = await llm.create(plan, scene, 0, state, 'prompt', () => {});
assert.notEqual(generated.at(-1).writer.inputs.seed, failedSeed, 'Retry must bypass the cached malformed reply');
assert.equal(repaired[0].prompt, 'Recovered complete prompt.');
await llm.create(plan, scene, 0, state, 'all', () => {});
assert.notEqual(generated.at(-1).writer.inputs.seed, generated.at(-2).writer.inputs.seed);
assert.equal(calls.length, analysisCalls, 'Repeated writing must reuse image analyses');
assert.deepEqual(node.properties.h3_llm, originalConfig, 'Transient LLM seeds must not invalidate analysis settings');
assert.deepEqual(node.properties.h3_image_analyses, originalAnalyses);
assert.deepEqual(plan, originalPlan, 'Video seeds and existing prompts remain unchanged');
console.log('Director LLM regeneration: fresh writing seeds, malformed-reply retry, JSON repair, image reuse and unchanged video seeds passed.');

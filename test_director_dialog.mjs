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
      : { status: { completed: true }, outputs: { result: { text: ["観察結果 " + id] } } });
    if (pending) return new Promise(resolve => { pending.resolve = () => resolve({ ok: true, json: async () => ({ prompt_id: id }) }); });
    return { ok: true, json: async () => ({ prompt_id: id }) };
  }
  assert.ok(["/queue", "/interrupt"].includes(path));
  return { ok: true, json: async () => ({}) };
} };
const source = (await readFile(new URL("./web/director_dialog.js", import.meta.url), "utf8")).replace(/^import .*;\r?\n/gm, "").replaceAll("export ", "");
const LLM = new Function("api", "draftGraph", "readDraft", "sceneAssets", "referenceDescriptions", "imageAnalysisKey", source + "\nreturn DirectorLLM;")(
  api, draftGraph, readDraft, sceneAssets, referenceDescriptions, imageAnalysisKey);
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
assert.match(await llm.analyze(swapped), /^<Picture 1>\n観察結果 3/);
assert.equal(calls.length, 4, "Slot order changes labels without reanalyzing images");
assert.equal(await llm.analyze({ ...scene, mode: "T2V" }), "");
assert.equal(calls.length, 4);

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
console.log("Director LLM: per-image analysis, manual edits, reorder, same-path replacement, T2V, failure and pending-registration cancellation passed.");

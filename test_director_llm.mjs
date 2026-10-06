import assert from "node:assert/strict";
import { draftGraph, readDraft, applyDraft, referenceDescriptions, imageAnalysisKey } from "./web/director_llm.js";

const config = { loader: { model: "existing.gguf", n_ctx: 32768 },
  story: { inputs: { seed: 42, cache_image_analysis: true, force_offload: true }, parameters: { temperature: 0.6 } },
  prompt: { inputs: { seed: 42, cache_image_analysis: true, force_offload: true }, parameters: { temperature: 0.5 } } };
const plan = { prompt_prefix: "Shared", custom: "preserve", shots: [
  { id: "a", prompt: "Original A", seed: "18446744073709551615", duration_seconds: 15, length: 362 },
  { id: "b", prompt: "Original B", seed: "0", duration_seconds: 15 },
] };
const scene = { mode: "R2V", assets: [
  { kind: "image", file: "one.png", note: "Actor" },
  { kind: "image", file: "off.png", enabled: false },
  { kind: "audio", file: "sound.wav", note: "Ambient" },
  { kind: "image", role: "last", file: "last.png" },
] };
const before = structuredClone({ config, plan, scene });
// ComfyUI exposes node properties through reactive proxies in the browser.
const reactive = value => new Proxy(value, { get(target, key) {
  const item = target[key]; return item && typeof item === "object" ? reactive(item) : item;
} });
assert.throws(() => structuredClone(reactive(config).loader), { name: "DataCloneError" });
for (const action of ["analysis", "story", "prompt"]) {
  const output = draftGraph(reactive(config), scene, plan, action, "指示", "", 1);
  assert.deepEqual(output.model.inputs, config.loader);
  assert.deepEqual(output.parameters.inputs, config[action === "story" ? "story" : "prompt"].parameters);
  assert.doesNotThrow(() => structuredClone(output));
}
const graph = draftGraph(config, scene, plan, "prompt", "Open the gate", "Story", 1, "Image observations", "Scene story");
assert.deepEqual(graph.model.inputs, config.loader);
assert.equal(graph.writer.inputs.cache_image_analysis, true);
assert.equal(graph.writer.inputs.force_offload, true);
assert.equal(graph.writer.inputs.images, undefined);
assert.equal(graph.images, undefined);
assert.equal(JSON.parse(graph.writer.inputs.custom_prompt).image_analysis, "Image observations");
assert.equal(JSON.parse(graph.writer.inputs.custom_prompt).scene_story, "Scene story");
assert.equal(JSON.parse(graph.writer.inputs.custom_prompt).cuts[0].prompt, "Original A");
assert.equal(JSON.parse(graph.writer.inputs.custom_prompt).selected_cut, 2);
assert.equal(graph.result.class_type, "PreviewAny");
assert.equal(Object.values(graph).some(n => /Sampler|SaveVideo/.test(n.class_type)), false);
assert.deepEqual({ config, plan, scene }, before);
assert.deepEqual(referenceDescriptions(scene).map(r => r.label), ["<Picture 1>", "<Audio 1>"]);
assert.deepEqual(referenceDescriptions({ ...scene, assets: [...scene.assets, { kind: "video", file: "clip.mp4", use_audio: true }] }).map(r => r.label), ["<Picture 1>", "<Audio 1>", "<Video 1>", "<Audio 2>"]);
assert.equal(draftGraph(config, { ...scene, mode: "T2V" }, plan, "prompt", "", "", null).images, undefined);
for (const selected of [0, 1]) {
  const solo = draftGraph(config, scene, plan, "prompt", "指示", "", selected, "解析", "前カットの話", false);
  const request = JSON.parse(solo.writer.inputs.custom_prompt);
  assert.equal(request.cuts.length, 1);
  assert.equal(request.cuts[0].id, plan.shots[selected].id);
  assert.equal(request.scene_story, "");
  assert.equal(request.include_previous, false);
  assert.match(solo.writer.inputs.system_prompt, /self-contained H3 prompt/);
}
const analysis = draftGraph(config, scene, plan, "analysis", "Do not send this", "Or this", null);
assert.deepEqual(analysis.writer.inputs.images, ["images", 0]);
assert.equal(analysis.writer.inputs.cache_image_analysis, true);
assert.deepEqual(Object.keys(JSON.parse(analysis.writer.inputs.custom_prompt)), ["references"]);
assert.deepEqual(JSON.parse(analysis.writer.inputs.custom_prompt).references.map(r => r.label), ["<Picture 1>"]);
for (const action of ["story", "prompt"]) for (const selected of [null, 1]) {
  const output = draftGraph(config, scene, plan, action, "指示", "Outline", selected, "Observations");
  const request = JSON.parse(output.writer.inputs.custom_prompt);
  assert.equal(request.selected_cut, selected === null ? null : 2);
  assert.equal(output.images, undefined);
  assert.equal(request.cuts.length, 2, "Keep neighboring cuts as context");
  assert.equal(output.writer.inputs.system_prompt.includes("Return only the selected cut"), selected !== null);
}
const bytes = text => new TextEncoder().encode(text).buffer;
const key = await imageAnalysisKey(config, scene, async path => {
  assert.equal(new URL(path, "http://localhost").searchParams.get("filename"), "one.png"); return bytes("first");
});
assert.equal(key, await imageAnalysisKey(config, scene, async () => bytes("first")));
assert.notEqual(key, await imageAnalysisKey(config, scene, async () => bytes("replacement at same path")));
assert.notEqual(key, await imageAnalysisKey({ ...config, loader: { model: "changed" } }, scene, async () => bytes("first")));
assert.notEqual(key, await imageAnalysisKey(config, { ...scene, assets: [{ ...scene.assets[0], note: "Changed role note" }] }, async () => bytes("first")));
await imageAnalysisKey(config, { mode: "I2V", assets: [{ kind: "image", role: "first", file: "folder\\image.png [output]" }] }, async path => {
  const query = new URL(path, "http://localhost").searchParams;
  assert.equal(query.get("filename"), "image.png"); assert.equal(query.get("subfolder"), "folder"); assert.equal(query.get("type"), "output");
  return bytes("output");
});
const draft = readDraft('```json\n{"shots":[{"id":"b","prompt":"Continues from A","start_state":"At gate","end_state":"Past gate"}]}\n```', plan, 1);
const applied = applyDraft(plan, structuredClone(plan), draft);
assert.deepEqual(applied.shots[0], plan.shots[0]);
assert.equal(applied.shots[1].seed, "0");
assert.equal(applied.shots[1].duration_seconds, 15);
assert.equal(applied.shots[1].prompt, "Continues from A");
assert.deepEqual(plan, before.plan);
assert.throws(() => readDraft('{"shots":[{"id":"wrong","prompt":"x"}]}', plan, 1), /ID/);
assert.throws(() => readDraft('{"shots":[]}', plan), /カット数/);
assert.throws(() => applyDraft({ ...plan, prompt_prefix: "Manual edit" }, plan, draft), /変更/);
console.log("PASS: LLM settings, scoped graph, reference mapping, continuity context, reviewed apply, and stale-draft protection.");

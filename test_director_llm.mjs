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
assert.equal(JSON.parse(graph.writer.inputs.custom_prompt).previous_prompt, "Original A");
assert.match(graph.writer.inputs.system_prompt, /Return ONLY JSON: \{"shots":\[\{"prompt":/);
const threeCuts = { shots: [{ id: "a", prompt: "Walk to the gate" },
  { id: "b", prompt: "Open the gate", end_state: "Woman holds the open gate with her right hand" }, { id: "c", prompt: "" }] };
const third = draftGraph(config, scene, threeCuts, "prompt", "Enter the garden", "", 2);
assert.equal(JSON.parse(third.writer.inputs.custom_prompt).previous_prompt, "Open the gate");
assert.equal(JSON.parse(third.writer.inputs.custom_prompt).previous_end_state, threeCuts.shots[1].end_state);
assert.match(third.writer.inputs.system_prompt, /prompt field itself, not only start_state/);
const first = draftGraph(config, scene, threeCuts, "prompt", "Start", "", 0);
assert.equal(JSON.parse(first.writer.inputs.custom_prompt).previous_prompt, undefined);
assert.match(first.writer.inputs.system_prompt, /self-contained H3 prompt/);
assert.equal(JSON.parse(graph.writer.inputs.custom_prompt).cuts[1].prompt, undefined, "Only earlier cuts carry generated text as context");
const endpointScene = { mode: "L2V", assets: [{ kind: "image", role: "last", file: "last.png" }] };
const stalePlan = { shots: [{ id: "cut2", duration_seconds: 15, prompt: "She remains seated throughout.", start_state: "Already seated", end_state: "Still seated" }] };
const instruction = "駅のホームから歩いて、電車に乗り、対面に座る日本の女学生。BGMや会話はなし。環境音のみ。";
for (const selected of [0, null]) for (const action of ["prompt", "story"]) {
  const output = draftGraph(config, endpointScene, stalePlan, action, instruction, "", selected, "<Picture 1>\nA student seated inside a train.");
  const request = JSON.parse(output.writer.inputs.custom_prompt);
  assert.equal(request.instruction, instruction);
  assert.equal(request.include_previous, false);
  assert.equal(request.previous_prompt, undefined);
  assert.equal(request.last_frame_cut, 1);
  assert.equal(request.references[0].label, "<Picture 1>");
  assert.deepEqual(request.cuts, [{ id: "cut2", duration_seconds: 15 }]);
  assert.doesNotMatch(output.writer.inputs.custom_prompt, /remains seated|Already seated|Still seated/);
  assert.match(output.writer.inputs.system_prompt, /current instruction takes priority/);
  assert.match(output.writer.inputs.system_prompt, /every requested action in order/);
  assert.match(output.writer.inputs.system_prompt, /only the ending of the final cut/);
}
const endpointContinuation = JSON.parse(draftGraph(config, endpointScene, threeCuts, "prompt", "Enter", "", 1).writer.inputs.custom_prompt);
assert.equal(endpointContinuation.last_frame_cut, 3, "Only the scene's actual final cut has the endpoint image");
assert.equal(endpointContinuation.previous_prompt, "Walk to the gate");
assert.equal(endpointContinuation.cuts[1].prompt, undefined);
assert.equal(stalePlan.shots[0].prompt, "She remains seated throughout.", "Request construction does not overwrite existing prompts");
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
  assert.equal(request.previous_prompt, undefined);
  assert.equal(request.previous_end_state, undefined);
  assert.match(solo.writer.inputs.system_prompt, /self-contained H3 prompt/);
}
const analysis = draftGraph(config, scene, plan, "analysis", "Do not send this", "Or this", null);
assert.deepEqual(analysis.writer.inputs.images, ["images", 0]);
assert.equal(analysis.writer.inputs.cache_image_analysis, true);
assert.deepEqual(JSON.parse(analysis.writer.inputs.custom_prompt), { task: "Describe the visible contents of the supplied image." });
assert.match(analysis.writer.inputs.system_prompt, /observations in English without reference numbers/);
assert.doesNotMatch(analysis.writer.inputs.system_prompt, /Japanese|R2V|I2V|first image|last image/);
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
assert.equal(key, await imageAnalysisKey(config, { ...scene, assets: [{ ...scene.assets[0], note: "Changed role note" }] }, async () => bytes("first")));
for (const [mode, role] of [["R2V", "reference"], ["I2V", "first"], ["L2V", "last"], ["FL2V", "last"]]) {
  assert.equal(key, await imageAnalysisKey(config, { mode, assets: [{ kind: "image", role, file: "another-folder/renamed.png", note: "New note" }] }, async () => bytes("first")));
}
assert.notEqual(key, await imageAnalysisKey({ ...config, prompt: { ...config.prompt, parameters: { temperature: 0.2 } } }, scene, async () => bytes("first")));
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
assert.deepEqual(readDraft('{"shots":[{"id":"wrong","prompt":"x"}]}', plan, 1), [{ index: 1, prompt: "x", start_state: "", end_state: "" }]);
assert.equal(readDraft('{"shots":[{"prompt":"No generated ID"}]}', plan, 1)[0].index, 1);
const repaired = readDraft('{"shots":[{"id":"a","prompt":"Continue from the gate.",""start_state":"At gate",""end_state":"Inside garden"}]}', plan, 1);
assert.deepEqual(repaired, [{ index: 1, prompt: "Continue from the gate.", start_state: "At gate", end_state: "Inside garden" }]);
const repairedPlan = applyDraft(plan, structuredClone(plan), repaired);
assert.deepEqual(repairedPlan.shots[0], plan.shots[0]);
assert.equal(repairedPlan.shots[1].id, "b");
assert.equal(repairedPlan.shots[1].prompt, "Continue from the gate.");
const exact = 'She says "Hello", then passes a sign reading "prompt": "example". Path C:\\garden.\nNext line.';
const promptOnly = JSON.stringify({ shots: [{ prompt: exact }] });
assert.equal(readDraft(promptOnly, plan, 1)[0].prompt, exact);
assert.equal(readDraft(promptOnly.slice(0, -2), plan, 1)[0].prompt, exact, "Recover complete text when the JSON closing brackets are missing");
assert.equal(readDraft('{"shots":[{"prompt":"Intact text.","end_state":"unfinished', plan, 1)[0].prompt, "Intact text.");
assert.equal(readDraft('{"shots":[{"prompt":"Intact text.","start_state":"bad\\q"}]}', plan, 1)[0].start_state, "");
for (const broken of [
  '{"shots":[{"prompt":"unfinished',
  '{"shots":[{"prompt":"Text with "unescaped" quotes"}]}',
  '{"shots":[{"prompt":"bad\\q"}]}',
  '{"shots":[{"prompt":"One"},{"prompt":"Two"}',
  '{"shots":[{"prompt":""}]}',
  '{"shots":[null]}',
  'null',
]) assert.throws(() => readDraft(broken, plan, 1));
assert.throws(() => readDraft('{"shots":[{"id":"wrong","prompt":"One"},{"id":"b","prompt":"Two"}]}', plan), /ID/);
assert.throws(() => readDraft('{"shots":[{"prompt":"Intact text.","end_state":"unfinished', plan));
assert.throws(() => readDraft('{"shots":[]}', plan), /カット数/);
assert.throws(() => applyDraft({ ...plan, prompt_prefix: "Manual edit" }, plan, draft), /変更/);
console.log("PASS: LLM settings, scoped graph, continuity, script-owned cut selection, JSON recovery, exact prompt preservation and concurrent-edit protection.");

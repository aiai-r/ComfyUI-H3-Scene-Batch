import assert from "node:assert/strict";
import { draftGraph, readDraft, applyDraft, referenceDescriptions } from "./web/director_llm.js";

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
const graph = draftGraph(config, scene, plan, "revise", "Open the gate", "Story", 1);
assert.deepEqual(graph.model.inputs, config.loader);
assert.equal(graph.writer.inputs.cache_image_analysis, true);
assert.equal(graph.writer.inputs.force_offload, true);
assert.deepEqual(graph.writer.inputs.images, ["images", 0]);
assert.equal(JSON.parse(graph.writer.inputs.custom_prompt).cuts[0].prompt, "Original A");
assert.equal(JSON.parse(graph.writer.inputs.custom_prompt).selected_cut, 2);
assert.equal(graph.result.class_type, "PreviewAny");
assert.equal(Object.values(graph).some(n => /Sampler|SaveVideo/.test(n.class_type)), false);
assert.deepEqual({ config, plan, scene }, before);
assert.deepEqual(referenceDescriptions(scene).map(r => r.label), ["<Picture 1>", "<Audio 1>"]);
assert.deepEqual(referenceDescriptions({ ...scene, assets: [...scene.assets, { kind: "video", file: "clip.mp4", use_audio: true }] }).map(r => r.label), ["<Picture 1>", "<Audio 1>", "<Video 1>", "<Audio 2>"]);
assert.equal(draftGraph(config, { ...scene, mode: "T2V" }, plan, "prompt", "", "", null).images, undefined);
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

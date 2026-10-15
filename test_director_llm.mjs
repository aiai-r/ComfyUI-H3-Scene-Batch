import assert from "node:assert/strict";
import { draftGraph, readDraft, applyDraft, referenceDescriptions, imageAnalysisKey, referenceDefinitions, SYSTEM_PROMPTS, readScene, scenePrompt, normalizeMediaReferences } from "./web/director_llm.js";

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
assert.match(graph.writer.inputs.system_prompt, /Return only the six plain-text sections/);
assert.match(graph.writer.inputs.system_prompt, /# Full-Reference Mode Rewrite Output Format Guide/);
const threeCuts = { shots: [{ id: "a", prompt: "Walk to the gate" },
  { id: "b", prompt: "Open the gate", end_state: "Woman holds the open gate with her right hand" }, { id: "c", prompt: "" }] };
const third = draftGraph(config, scene, threeCuts, "prompt", "Enter the garden", "", 2);
assert.equal(JSON.parse(third.writer.inputs.custom_prompt).previous_prompt, "Open the gate");
assert.equal(JSON.parse(third.writer.inputs.custom_prompt).previous_end_state, threeCuts.shots[1].end_state);
assert.match(third.writer.inputs.system_prompt, /continues directly from that ending/);
const first = draftGraph(config, scene, threeCuts, "prompt", "Start", "", 0);
assert.equal(JSON.parse(first.writer.inputs.custom_prompt).previous_prompt, undefined);
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
  assert.match(draftGraph(config, { ...scene, mode: "T2V" }, plan, "prompt", "指示", "", selected, "", "前カットの話", false).writer.inputs.system_prompt, /self-contained H3 prompt/);
}
const analysis = draftGraph(config, scene, plan, "analysis", "画像1は同一人物の三面図", "Do not send the story", null);
assert.deepEqual(analysis.writer.inputs.images, ["images", 0]);
assert.equal(analysis.writer.inputs.cache_image_analysis, false, "Purpose-aware analysis must inspect pixels, not the lower-level generic description cache");
assert.deepEqual(JSON.parse(analysis.writer.inputs.custom_prompt), { task: "Define the attached image for its intended reference use.", instruction: "画像1は同一人物の三面図", mode: "R2V", target_image: null });
assert.match(analysis.writer.inputs.system_prompt, /reusable reference definition in English/);
assert.match(analysis.writer.inputs.system_prompt, /all views depict ONE individual/);
assert.match(analysis.writer.inputs.system_prompt, /storyboard/);
assert.doesNotMatch(analysis.writer.inputs.custom_prompt, /Do not send the story/);
for (const action of ["story", "prompt"]) for (const selected of [null, 1]) {
  const output = draftGraph(config, scene, plan, action, "指示", "Outline", selected, "Observations");
  const request = JSON.parse(output.writer.inputs.custom_prompt);
  assert.equal(request.selected_cut, selected === null ? null : 2);
  assert.equal(output.images, undefined);
  assert.equal(request.cuts.length, 2, "Keep neighboring cuts as context");
  if (action === "story") assert.equal(output.writer.inputs.system_prompt.includes("Return only the selected cut"), selected !== null);
}
const bytes = text => new TextEncoder().encode(text).buffer;
const key = await imageAnalysisKey(scene, async path => {
  assert.equal(new URL(path, "http://localhost").searchParams.get("filename"), "one.png"); return bytes("first");
});
assert.equal(key, await imageAnalysisKey(scene, async () => bytes("first")));
assert.notEqual(key, await imageAnalysisKey(scene, async () => bytes("replacement at same path")));
assert.equal(key, await imageAnalysisKey({ ...scene, assets: [{ ...scene.assets[0], note: "Changed role note" }] }, async () => bytes("first")));
for (const [mode, role] of [["R2V", "reference"], ["I2V", "first"], ["L2V", "last"], ["FL2V", "last"]]) {
  assert.equal(key, await imageAnalysisKey({ mode, assets: [{ kind: "image", role, file: "another-folder/renamed.png", note: "New note" }] }, async () => bytes("first")));
}
const customConfig = JSON.parse(JSON.stringify({ ...config, system_prompts: {
  analysis: "Custom observations in English.", story: "Custom story. {{output_instructions}}",
  prompt_r2v: "Custom references. {{continuity_instructions}}\n{{output_instructions}}",
  prompt_base: "Custom base. {{mode_instructions}}\n{{continuity_instructions}}\n{{output_instructions}}",
} }));
assert.equal(draftGraph(customConfig, scene, plan, "analysis", "", "").writer.inputs.system_prompt, "Custom observations in English.");
for (const mode of ["R2V", "T2V", "I2V", "L2V", "FL2V"]) {
  const output = draftGraph(customConfig, { ...scene, mode }, plan, "prompt", "", "", 0).writer.inputs.system_prompt;
  assert.ok(output.startsWith(mode === "R2V" ? "Custom references." : "Custom base."));
  assert.doesNotMatch(output, /\{\{/);
  assert.match(output, /self-contained H3 prompt/);
  assert.match(output, /Return ONLY JSON/);
  assert.match(draftGraph(customConfig, { ...scene, mode }, plan, "story", "", "").writer.inputs.system_prompt, /^Custom story\. Return a concise editable story/);
  if (mode === "T2V") assert.doesNotMatch(output, /image|reference|last_frame/);
  if (mode === "R2V") assert.doesNotMatch(output, /anchors|last_frame/);
  if (mode === "L2V") assert.match(output, /only the ending of the final cut/);
}
assert.match(draftGraph(customConfig, scene, plan, "prompt", "", "", 1).writer.inputs.system_prompt, /previous_end_state/);
delete customConfig.system_prompts.analysis;
assert.equal(key, await imageAnalysisKey(scene, async () => bytes("first")), "Analysis identity is based only on image bytes");
customConfig.system_prompts.analysis = SYSTEM_PROMPTS.analysis.text;
delete customConfig.system_prompts.prompt_r2v;
assert.equal(draftGraph(customConfig, scene, plan, "prompt", "", "").writer.inputs.system_prompt,
  draftGraph(config, scene, plan, "prompt", "", "").writer.inputs.system_prompt);
await imageAnalysisKey({ mode: "I2V", assets: [{ kind: "image", role: "first", file: "folder\\image.png [output]" }] }, async path => {
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
for (const newline of ['\n', '\r\n', '\r']) for (const backslashes of ['', '\\', '\\\\', '\\\\\\']) {
  const expected = 'First line' + '\\'.repeat(Math.floor(backslashes.length / 2)) + '\nSecond line';
  const malformed = '{\n"shots":[{"id":"b","prompt":"First line' + backslashes + newline + 'Second line","end_state":"Done"}]\n}';
  assert.equal(readDraft(malformed, plan, 1)[0].prompt, expected, 'Repair raw newlines while preserving literal backslashes');
  assert.equal(readDraft(malformed, { shots: [{ id: 'b' }] })[0].prompt, expected);
  assert.equal(readDraft(malformed, plan, 1)[0].end_state, 'Done');
}
const malformedWithQuotes = JSON.stringify({ shots: [{ prompt: exact, start_state: 'Start', end_state: 'End' }] }).replace('\\nNext line.', '\\\nNext line.');
assert.equal(readDraft(malformedWithQuotes, plan, 1)[0].prompt, exact, 'Keep dialogue quotes, paths and complete content intact');
assert.throws(() => readDraft('{"shots":[{"prompt":"First\\\nunfinished', plan, 1), /Prompt|返答/);
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

const refs = [
  { label: '<Picture 1>', text: '<Subject 1> is one woman in <Picture>. All three views depict the same individual. Use the close-up for her face.' },
  { label: '<Picture 2>', text: '<Subject 1> is the room in <Picture>, including its desk and chair.' },
  { label: '<Picture 3>', text: '<Subject 1> is one man shown in multiple views in <Picture>. All views depict the same individual.' },
];
const definitions = referenceDefinitions(refs);
assert.match(definitions, /<Subject 1> is one woman in <Picture 1>/);
assert.match(definitions, /<Subject 2> is the room in <Picture 2>/);
assert.match(definitions, /<Subject 3> is one man shown in multiple views in <Picture 3>/);
assert.match(referenceDefinitions([refs[2], refs[0]].map((r,i) => ({...r,label:`<Picture ${i+1}>`}))), /<Subject 1> is one man.*<Picture 1>/);
const storyboard = '<Picture> is a storyboard: follow panels left to right, then top to bottom.';
assert.equal(referenceDefinitions([{label:'<Picture 2>',text:storyboard}]), storyboard.replace('<Picture>','<Picture 2>'));
assert.match(referenceDefinitions([{label:'<Picture 1>',text:'<Subject 1> is Alice in <Picture>. <Subject 2> is Bob in <Picture>. <Subject 1> wears red.'}, refs[1]]), /<Subject 3> is the room/);
const sections = ['subject_definitions', 'summary', 'retention_analysis', 'detailed_description', 'overall_soundscape', 'non_diegetic_music'];
for (const [action, mode] of [['story', 'R2V'], ['prompt', 'T2V']]) for (const selected of [null, 0, 1]) {
  const system = draftGraph(config, { ...scene, mode }, plan, action, '最初は無言。そのあと「こんにちは」と言う。環境音のみ。BGMなし。', '', selected).writer.inputs.system_prompt;
  assert.match(system, /Japanese quotation marks 「」/);
  assert.match(system, /first-person camera or 一人称視点 does not imply a spoken monologue/);
  assert.match(system, /specified people and time intervals/);
  assert.match(system, /except dialogue explicitly requested for this cut/);
  if (mode === 'R2V') assert.match(system, /<Audio 1> is the voice-timbre reference for <Subject 1> \(S1\)/);
  assert.match(system, /discard that addition/);
  assert.equal(system.split('With 環境音のみ,').length, 2, 'One shared sound policy per request');
  assert.doesNotMatch(system, /With 環境音のみ, include only ambience and physical sounds, no voices or music/);
}
const r2vSystem = draftGraph(config, scene, plan, 'prompt', '無言。環境音のみ。BGMなし。', '', 0).writer.inputs.system_prompt;
for (const heading of sections) assert.ok(r2vSystem.includes(heading + ':'));
assert.equal(r2vSystem, SYSTEM_PROMPTS.prompt_r2v.text, 'R2V prompts use the official guide without extra rules');
assert.match(r2vSystem, /Preserve Japanese dialogue inside <d>\[Japanese\] \.\.\.<\/d>/);
console.log('Reference definitions: image-order labels, multiview and storyboard preservation, multiple subjects, exact final insertion passed.');

const duplicate = referenceDefinitions([{...refs[0],key:'same image'}, {...refs[0],label:'<Picture 2>',key:'same image'}]);
assert.match(duplicate, /<Subject 1> is one woman in <Picture 1> and <Picture 2>/);
assert.doesNotMatch(duplicate, /<Subject 2>/, 'Identical image inputs do not create another person');

const cutPrompt = body => ['subject_definitions:', '<Subject 1> is the woman.', '', 'summary:', 'One cut.', '', 'retention_analysis:', '<Subject 1>: fully_preserved.', '',
  'detailed_description:', body, '', 'overall_soundscape:', 'Room tone.', '', 'non_diegetic_music:', 'N/A'].join('\n');
const block = (n, seconds, body) => [`=== SCENE ${n} (duration: ${seconds}s) ===`, '```text', cutPrompt(body), '```', ''];
const sceneReply = ['### Part 1: 全体ストーリー＆クリップ配分 (Japanese Breakdown)', '| Clip 1 | 15秒 | 勉強 |', '', '### Part 2: 各クリップ個別プロンプト (ComfyUI Contex-Loop Prompts)', '',
  ...block(1, 15, '[Shot 1] She writes. [Shot 2] At 00:08.000, he watches.'),
  ...block(2, 10, '[Shot 1] Close-up. [Shot 2] At 00:19.500, he speaks.'),
  ...block(3, 20, '[Shot 1] He reaches. [Shot 2] At 00:30.000, she smiles.')].join('\n');
const planned = readScene(sceneReply, 45, 'all');
assert.equal(planned.story, '| Clip 1 | 15秒 | 勉強 |');
assert.deepEqual(planned.cuts.map(c => c.duration_seconds), [15, 10, 20], 'The LLM cut lengths are kept as written');
assert.deepEqual(planned.problems, ['カット 3 が20秒です（1カットは4〜15秒）。']);
assert.match(planned.cuts[0].prompt, /\[Shot 2\] At 00:08\.000, he watches\./, 'Cut-local times stay unchanged');
assert.match(planned.cuts[1].prompt, /\[Shot 2\] At 00:04\.500, he speaks\./, 'Scene-wide times restart at the cut, as in short_storygen_h3');
assert.deepEqual(readScene(sceneReply.replace('summary:\nOne cut.\n\n', ''), 45, 'all').problems.filter(p => p.includes('6項目')).length, 1);
assert.deepEqual(readScene(sceneReply.replace('(duration: 20s)', '(duration: 15s)'), 45, 'all').problems, [], 'The requested total is a target; the LLM total is accepted');
assert.equal(readScene(sceneReply, 45, 'story').story, '| Clip 1 | 15秒 | 勉強 |');
assert.deepEqual([...normalizeMediaReferences('画像1は音声1、画像3は音声2').found], ['<Picture 1>', '<Audio 1>', '<Picture 3>', '<Audio 2>']);
const request = scenePrompt(60, '画像1は音声1を使う。', '', [{ number: 1, filename: 'woman.png', note: '', analysis: '<Subject 1> is the woman shown in <Picture 1>.' }]);
assert.match(request, /Total Runtime: EXACTLY 60\.00 seconds\./);
assert.match(request, /- <Picture 1> \(woman\.png\): Assigned Role = <Picture 1> Reference; User Note = none; Saved Visual Analysis = \{"description":"<Subject 1> is the woman shown in <Picture 1>\."\}/);
assert.match(request, /USER DIRECTION:\n<Picture 1>は<Audio 1>を使う。/);
assert.match(request, /- <Audio 1>: declared by the user; its contents were not inspected/);
assert.match(request, /8\. \*\*Complete prompt in every clip\*\*/);
const roles = scenePrompt(60, '画像3は音声2を使う。', '', [{ number: 3, filename: 'man.png', note: '', analysis: '<Subject 3> is the man.', subjects: [3] }]);
assert.match(roles, /- <Picture 3> \(man\.png\): Assigned Role = <Subject 3> Reference;/, 'Each picture states its Subject, as short_storygen_h3 subject references do');
assert.match(roles, /- <Picture 3>: attached as a reference asset; label it <Subject 3> in the generated prompt\./);
assert.match(roles, /<Audio N> is the voice-timbre reference for <Subject N> \(Sx\)\./, 'The clip example carries the voice-reference line');
assert.match(roles, /even when nobody speaks in that clip/);
console.log('Whole-scene plan: short_storygen_h3 request, kept cut lengths, reported problems and per-cut timelines passed.');

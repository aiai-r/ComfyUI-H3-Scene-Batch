import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { draftGraph, readDraft, sceneAssets, referenceDescriptions, referenceDefinitions, imageAnalysisKey, sceneGraph, readScene } from "./web/director_llm.js";

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
const LLM = new Function("api", "draftGraph", "readDraft", "sceneAssets", "referenceDescriptions", "referenceDefinitions", "imageAnalysisKey", "sceneGraph", "readScene", "crypto", source + "\nreturn DirectorLLM;")(
  api, draftGraph, readDraft, sceneAssets, referenceDescriptions, referenceDefinitions, imageAnalysisKey, sceneGraph, readScene, { getRandomValues: values => { values[0] = ++nextSeed; return values; } });
const node = { properties: { h3_llm: { loader: { model: "existing" }, story: { inputs: {}, parameters: {} }, prompt: { inputs: {}, parameters: {} } } }, graph: { change() {} } };
const scene = { mode: "R2V", assets: [{ kind: "image", file: "one.png" }, { kind: "image", file: "two.png" }] };
const llm = new LLM(node, () => {});
await llm.analyze(scene);
assert.equal(calls.length, 2);
assert.ok(calls.every(g => JSON.parse(g.images.inputs.scene_json).assets.length === 1));
llm.imageRecord(scene.assets[0]).text = "手動の観察結果";
const reused = await llm.analyze(scene);
assert.equal(calls.length, 2);
assert.match(reused, /<Picture 1>\.\n手動の観察結果/);
bytes.set("two.png", "replacement at same filename");
await llm.analyze(scene);
assert.equal(calls.length, 3);
assert.equal(JSON.parse(calls.at(-1).images.inputs.scene_json).assets[0].file, "two.png");
await llm.analyze(scene, [scene.assets[0]], true);
assert.equal(calls.length, 4);
const swapped = { ...scene, assets: [...scene.assets].reverse() };
assert.match(await llm.analyze(swapped), /^<Subject 1>.*<Picture 1>\.\nObservations 3/);
assert.equal(calls.length, 4, "Slot order changes labels without reanalyzing images");
assert.equal(await llm.analyze({ ...scene, mode: "T2V" }), "");
assert.equal(calls.length, 4);

bytes.set("copy.png", "one");
const copy = { kind: "image", file: "another-folder/copy.png", role: "first", note: "New note" };
await llm.matchImage(copy);
assert.equal(llm.imageRecord(copy), llm.imageRecord(scene.assets[0]), "Same bytes under a new name share the analysis immediately after import");
for (const [mode, role, label] of [["R2V", "reference", "<Picture 1>"], ["I2V", "first", "first frame"], ["L2V", "last", "<Picture 1>"]]) {
  assert.equal(await llm.analyze({ mode, assets: [{ ...copy, role }] }), mode === "R2V" ? `<Subject 1> is the visible content referenced from ${label}.\nObservations 4` : `${label}\nObservations 4`);
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
node.properties.h3_llm.prompt.parameters.temperature = 0.2;
node.properties.h3_llm.system_prompts = { analysis: "Different analysis instructions" };
await llm.analyze(paired, undefined, false, '用途を変えても保存済みを使う');
assert.equal(calls.length, 4, "Model, settings, system prompt, usage notes and Japanese instructions do not reanalyze saved images");
assert.match(await llm.analyze(paired), /Edited after reload/);

const legacyId = JSON.stringify(["one.png", "reference", ""]);
const legacyNode = { properties: { h3_llm: structuredClone(node.properties.h3_llm), h3_image_analyses: { [legacyId]: { text: "以前の日本語解析", key: "old-key" } } } };
const legacy = new LLM(legacyNode, () => {});
await legacy.analyze({ mode: "R2V", assets: [scene.assets[0]] });
assert.equal(calls.length, 4, "Existing manually edited observations are retained, not silently regenerated");
assert.equal(legacy.imageRecord(scene.assets[0]).text, "以前の日本語解析");
const currentKey = await llm.imageKey(scene.assets[0]);
const oldKey = JSON.stringify({version:2,loader:{model:'old model'},images:JSON.parse(currentKey).images});
const oldNode = { properties: { h3_llm: structuredClone(node.properties.h3_llm), h3_image_analysis_keys: {'one.png':oldKey}, h3_image_analyses: {[oldKey]:{text:'Existing content-hash analysis',key:oldKey}} } };
const migrated = new LLM(oldNode, () => {});
await migrated.analyze({mode:'R2V',assets:[scene.assets[0]]});
assert.equal(calls.length,4);
assert.equal(migrated.imageRecord(scene.assets[0]).text,'Existing content-hash analysis');

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
for (const change of [() => bytes.set("one.png", "changed during inference")]) {
  pending = {};
  const running = llm.analyze(scene, [scene.assets[0]], true);
  while (!pending.resolve) await new Promise(resolve => setImmediate(resolve));
  const previous = { ...llm.imageRecord(scene.assets[0]) };
  change(); pending.resolve(); pending = null;
  await assert.rejects(running, /処理中に画像が変わりました/);
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
for (const index of [0, 1]) assert.equal(JSON.parse(generated[index].writer.inputs.custom_prompt).story, '', 'New stories must not receive the previous story');
for (const index of [2, 3]) assert.equal(JSON.parse(generated[index].writer.inputs.custom_prompt).story, state.story, 'Prompt-only creation uses the editable story');
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
assert.equal(repaired[0].prompt, 'Recovered complete prompt.', 'The LLM prompt is kept as written');
await llm.create(plan, scene, 0, state, 'all', () => {});
assert.equal(JSON.parse(generated.at(-2).writer.inputs.custom_prompt).story, '');
assert.equal(JSON.parse(generated.at(-1).writer.inputs.custom_prompt).story, reply, 'Combined action uses only the freshly generated story');
assert.notEqual(generated.at(-1).writer.inputs.seed, generated.at(-2).writer.inputs.seed);
const twoCuts = { shots: [...plan.shots, { id: 'cut2', prompt: 'Old second cut', duration_seconds: 5 }] };
const continuationState = { ...state, includePrevious: true, sceneStory: 'Old whole-scene story' };
reply = JSON.stringify({ shots: [{ prompt: 'Fresh prompt' }] });
await llm.create(twoCuts, scene, null, continuationState, 'all', () => {});
assert.equal(JSON.parse(generated.at(-3).writer.inputs.custom_prompt).scene_story, '');
for (const graph of generated.slice(-2)) assert.equal(JSON.parse(graph.writer.inputs.custom_prompt).scene_story, reply, 'Whole-scene prompts use the fresh allocation');
await llm.create(twoCuts, scene, 1, continuationState, 'story', () => {});
const continuationRequest = JSON.parse(generated.at(-1).writer.inputs.custom_prompt);
assert.equal(continuationRequest.story, '');
assert.equal(continuationRequest.previous_prompt, plan.shots[0].prompt, 'Previous-cut continuity remains available');
assert.equal(continuationRequest.scene_story, continuationState.sceneStory);
assert.equal(calls.length, analysisCalls, 'Repeated writing must reuse image analyses');
assert.deepEqual(node.properties.h3_llm, originalConfig, 'Transient LLM seeds must not invalidate analysis settings');
assert.deepEqual(node.properties.h3_image_analyses, originalAnalyses);
assert.deepEqual(plan, originalPlan, 'Video seeds and existing prompts remain unchanged');
console.log('Director LLM regeneration: fresh writing seeds, malformed-reply retry, JSON repair, image reuse and unchanged video seeds passed.');

const fourCuts = { shots: [7, 15, 10, 20].map((duration_seconds, index) => ({ id: `part${index}`, duration_seconds, prompt: 'Old prompt', end_state: 'Old ending' })) };
const fourBefore = structuredClone(fourCuts), sequentialCalls = [];
const allocation = '各カットの時間に合わせて、入室、着席、会話、退室を割り振る。';
llm.execute = async graph => {
  const request = JSON.parse(graph.writer.inputs.custom_prompt);
  sequentialCalls.push({ request, system: graph.writer.inputs.system_prompt });
  if (request.selected_cut === null) return allocation;
  const cut = request.selected_cut;
  return JSON.stringify({ shots: [{ prompt: `Prompt ${cut}`, start_state: `Start ${cut}`, end_state: `End ${cut}` }] });
};
let savedStory;
const sequentialDrafts = await llm.create(fourCuts, scene, null, continuationState, 'all', story => { savedStory = story; });
assert.equal(savedStory, allocation);
assert.equal(sequentialCalls.length, 5, 'One story plus four sequential prompts');
assert.deepEqual(sequentialCalls.map(c => c.request.selected_cut), [null, 1, 2, 3, 4]);
assert.deepEqual(sequentialCalls[0].request.scene_cuts.map(c => c.duration_seconds), [7, 15, 10, 20]);
assert.match(sequentialCalls[0].system, /Plan ALL cuts together/);
for (let index = 0; index < 4; index++) {
  const { request, system } = sequentialCalls[index + 1];
  assert.equal(request.story, allocation);
  assert.equal(request.scene_story, allocation);
  assert.equal(request.scene_cuts.length, 4);
  assert.match(system, /Full-Reference Mode Rewrite Output Format Guide/);
  assert.match(system, /Write ONLY selected_cut/);
  assert.doesNotMatch(JSON.stringify(request), /start_state|end_state|Old ending/);
  assert.doesNotMatch(system, /start_state|end_state/);
  assert.deepEqual(Object.keys(sequentialDrafts[index]).sort(), ['index', 'prompt']);
  assert.doesNotMatch(system, /With 環境音のみ, include only ambience and physical sounds, no voices or music/);
  if (index) {
    assert.equal(request.previous_prompt, sequentialDrafts[index - 1].prompt);
    assert.equal(request.previous_end_state, undefined);
    assert.equal(request.cuts.length, 2);
    assert.equal(request.cuts[0].id, fourCuts.shots[index - 1].id);
  } else assert.equal(request.previous_prompt, undefined);
}
assert.deepEqual(fourCuts, fourBefore, 'Drafts remain local until all cuts succeed');
sequentialCalls.length = 0;
await llm.create(fourCuts, scene, null, { ...continuationState, story: allocation }, 'prompt', () => assert.fail('Prompt-only must not create a story'));
assert.equal(sequentialCalls.length, 4);
assert.equal(sequentialCalls[0].request.story, allocation);
sequentialCalls.length = 0;
await llm.create(fourCuts, scene, null, continuationState, 'story', () => {});
assert.equal(sequentialCalls.length, 1);
const normalExecute = llm.execute;
llm.execute = async graph => {
  const request = JSON.parse(graph.writer.inputs.custom_prompt);
  if (request.selected_cut === 2) throw new Error('Second cut failed');
  return normalExecute(graph);
};
await assert.rejects(llm.create(fourCuts, scene, null, continuationState, 'all', () => {}), /Second cut failed/);
assert.deepEqual(fourCuts, fourBefore);
llm.execute = async graph => { const result = await normalExecute(graph); llm.cancelled = true; return result; };
await assert.rejects(llm.create(fourCuts, scene, null, continuationState, 'prompt', () => {}), /中止/);
assert.deepEqual(fourCuts, fourBefore);
llm.cancelled = false;
llm.execute = normalExecute;
console.log('Whole-scene allocation, sequential continuity, scoped audio instructions, prompt-only, story-only, failure and cancellation passed.');

const fresh = { mode:'R2V',assets:[{kind:'image',file:'new-person.png',slot:0},{kind:'image',file:'new-board.png',slot:2}] };
bytes.set('new-person.png','new-person'); bytes.set('new-board.png','new-board');
const purposeNode = {properties:{h3_llm:structuredClone(node.properties.h3_llm)}};
const purpose = new LLM(purposeNode,()=>{});
const steps = [];
purpose.execute = async graph => {
  const request = JSON.parse(graph.writer.inputs.custom_prompt);
  steps.push({request,graph});
  if(graph.images) {
    assert.equal(graph.writer.inputs.cache_image_analysis,false);
    return request.target_image.image_number === 1
      ? '<Subject 1> is the woman in <Picture>. The three panels depict the SAME individual. Use the close-up for her face; one woman appears in the video.'
      : '<Picture> is a storyboard. Follow its three panels left to right; use them for shot order, not simultaneous people.';
  }
  return graph.writer.inputs.system_prompt.includes('Return a concise editable story') ? 'A woman follows the storyboard.' : '{"shots":[{"prompt":"<Subject 1> follows the shot order in <Picture 2>."}]}';
};
const purposeState = {...state,instruction:'画像1は同じ女性の三面図。画像3は左から読む絵コンテ。女性が歩く。'};
const purposeResult = await purpose.create(plan,fresh,0,purposeState,'all',()=>{});
assert.equal(steps.length,4,'One click runs missing-image analysis, story, then prompt');
assert.equal(steps[0].request.instruction,purposeState.instruction);
assert.equal(steps[1].request.target_image.image_number,3,'Japanese image number follows the visible slot, even across empty slots');
assert.equal(steps[1].request.target_image.label,'<Picture 2>','H3 picture label follows active input order');
assert.equal(purposeResult[0].prompt,'<Subject 1> follows the shot order in <Picture 2>.');
assert.ok(steps[2].request.image_analysis.includes('three panels depict the SAME individual'));
const frozen = structuredClone(purposeNode.properties.h3_image_analyses);
await purpose.create(plan,fresh,0,{...purposeState,instruction:'女性が座って話す。画像の用途を変更。'},'all',()=>{});
assert.equal(steps.length,6,'Changing motion, dialogue or usage in Japanese does not rerun saved analysis');
assert.deepEqual(purposeNode.properties.h3_image_analyses,frozen);
await purpose.analyze(fresh,[fresh.assets[1]],true,purposeState.instruction);
assert.equal(steps.length,7,'Explicit reanalysis touches only the selected image');
const savedSteps=steps.length;
bytes.set('new-person.png','replacement-person');
await purpose.analyze(fresh,undefined,false,purposeState.instruction);
assert.equal(steps.length,savedSteps+1,'Same-path replacement reruns only that image');
assert.match(purpose.imageRecord(fresh.assets[1]).text,/storyboard/);
console.log('Purpose-aware workflow: Japanese usage reaches pixels, definitions survive writing, cache stays fixed, replacement and explicit reanalysis passed.');

for (const [mode,role] of [['I2V','first'],['L2V','last'],['FL2V','first']]) {
  const boundaryScene={mode,assets:[{...fresh.assets[0],role}]};
  const boundaryCalls=[];
  purpose.execute=async graph=>{boundaryCalls.push(graph);return '{"shots":[{"prompt":"The woman moves from the supplied frame."}]}';};
  const result=await purpose.create(plan,boundaryScene,0,purposeState,'prompt',()=>{});
  assert.equal(boundaryCalls.length,1,'Saved boundary images are not reanalyzed');
  assert.equal(result[0].prompt,'The woman moves from the supplied frame.');
  assert.doesNotMatch(JSON.parse(boundaryCalls[0].writer.inputs.custom_prompt).image_analysis,/<Subject/);
}
console.log('Boundary modes reuse saved observations without R2V subject sections.');

const buttonLLM = new LLM(node, () => {});
buttonLLM.analyze = async () => '';
node.properties.h3_llm.story.parameters.max_tokens = 1024;
node.properties.h3_llm.prompt.parameters.max_tokens = 2048;
const allocationOnly = '### Part 1: 全体ストーリー＆クリップ配分 (Japanese Breakdown)\n| Clip 1 | 15秒 | 門を開ける |\n| Clip 2 | 15秒 | 庭へ入る |';
const promptOnly = '### Part 2: 各クリップ個別プロンプト (ComfyUI Contex-Loop Prompts)\n=== SCENE 1 (duration: 15s) ===\n```text\nsubject_definitions:\nA garden.\n\nsummary:\nA walk.\n\nretention_analysis:\nN/A\n\ndetailed_description:\n[Shot 1] Open the gate.\n\noverall_soundscape:\nFootsteps.\n\nnon_diegetic_music:\nN/A\n```';
for (const action of ['story', 'prompt', 'all', 'generate']) {
  const requests = [], stories = [];
  buttonLLM.execute = async graph => {
    requests.push(graph);
    return action === 'story' ? allocationOnly : action === 'prompt' ? promptOnly : allocationOnly + '\n\n' + promptOnly;
  };
  const result = await buttonLLM.createScene({ mode: 'R2V', assets: [] }, { instruction: '門を開けて庭へ入る。', story: '編集済みの配分' }, action, 30, story => stories.push(story));
  assert.equal(requests.length, 1);
  const request = requests[0].writer.inputs.custom_prompt;
  assert.equal(request.includes('### Part 1'), action !== 'prompt');
  assert.equal(request.includes('### Part 2'), action !== 'story');
  assert.equal(request.includes('# Full-Reference Mode Rewrite Output Format Guide'), action !== 'story');
  assert.equal(requests[0].parameters.inputs.max_tokens, action === 'story' ? 1024 : 2048);
  if (action === 'story') {
    assert.equal(result.cuts, null);
    assert.doesNotMatch(request, /subject_definitions|retention_analysis|detailed_description|non_diegetic_music|=== SCENE/);
    assert.deepEqual(stories, ['| Clip 1 | 15秒 | 門を開ける |\n| Clip 2 | 15秒 | 庭へ入る |']);
  } else {
    assert.equal(result.cuts.length, 1);
    assert.deepEqual(result.problems, []);
    if (action === 'prompt') {
      assert.equal(result.story, '');
      assert.equal(stories.length, 0);
      assert.ok(request.includes('編集済みの配分'));
    } else assert.equal(stories.length, 1);
  }
}
console.log('Whole-scene buttons: story-only allocation, prompt-only output and combined output use the matching LLM settings.');

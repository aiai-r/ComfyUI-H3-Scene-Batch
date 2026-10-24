// Optional DOM check: point H3_DOM_MODULE at an installed linkedom ESM entry.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { readPlan, updateCut } from "./web/director_plan.js";
import { sceneAssets, referenceDescriptions, applyDraft, draftGraph, readDraft, sceneGraph, readScene, SCENE_CUT_SECONDS, referenceDefinitions, imageAnalysisKey, SYSTEM_PROMPTS, renderSystemPrompt } from "./web/director_llm.js";

if (!process.env.H3_DOM_MODULE) {
  console.log("Director UI DOM check skipped: set H3_DOM_MODULE to linkedom/esm/index.js.");
  process.exit(0);
}
const { parseHTML } = await import(pathToFileURL(process.env.H3_DOM_MODULE));
const { document, window } = parseHTML("<html><head></head><body></body></html>");
window.HTMLElement.prototype.scrollIntoView = () => {};
// linkedom exposes a read-only select value; browsers provide this setter.
const selectValue = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value");
Object.defineProperty(window.HTMLSelectElement.prototype, "value", { ...selectValue, set(value) {
  for (const option of this.options) option.selected = false;
  const selected = [...this.options].find(option => option.value === value);
  if (selected) selected.selected = true;
} });
let extension, draftOpened = false, queuedRecord, onGenerate = async () => {}, generationStops = 0;
const uploaded = [];
const uploadedBytes = new Map();
const llmCalls = [], history = new Map();
const projectCalls = [];
const batchCalls = [];
let libraryData = { scenes: [], batch: null, directory: "test" };
let promptOutput = null, sceneOutput = null, onPrompt = () => {};
const app = { registerExtension: value => { extension = value; } };
const api = { apiURL: value => value, addEventListener() {}, removeEventListener() {},
  async fetchApi(path, request) {
    if (path === '/object_info/LoraLoaderModelOnly') return { ok: true, json: async () => ({ LoraLoaderModelOnly: { input: { required: { lora_name: [[
      'minimaxh3/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors',
      'minimaxh3/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors',
    ]] } } } }) };
    if (path.startsWith('/view?')) return { ok: true, arrayBuffer: async () => uploadedBytes.get(new URL(path, 'http://localhost').searchParams.get('filename')) ?? new TextEncoder().encode(path).buffer };
    if (path.startsWith('/history/')) { const id = path.split('/').pop(); return { ok: true, json: async () => ({ [id]: history.get(id) }) }; }
    if (path === '/prompt') {
      const graph = JSON.parse(request.body).prompt, custom = graph.writer.inputs.custom_prompt;
      const scenePlan = custom.startsWith('You are a master film director');
      const data = scenePlan ? { total_seconds: Number(custom.match(/Total Runtime: EXACTLY ([0-9.]+) seconds/)[1]), text: custom } : JSON.parse(custom);
      const stage = graph.images ? 'analysis' : scenePlan ? 'scene'
        : graph.writer.inputs.system_prompt.includes('Return a concise editable story') ? 'story' : 'prompt';
      llmCalls.push({ stage, data, system: graph.writer.inputs.system_prompt, parameters: graph.parameters.inputs });
      const sections = body => ['subject_definitions:', '<Subject 1> is the referenced person.', '', 'summary:', body, '', 'retention_analysis:', '<Subject 1>: fully_preserved.', '',
        'detailed_description:', body, '', 'overall_soundscape:', 'Room tone.', '', 'non_diegetic_music:', 'N/A'].join('\n');
      const text = stage === 'analysis' ? 'A person stands in a garden.' : stage === 'story' ? '庭を歩いて振り返る'
        : stage === 'scene' ? sceneOutput ?? (() => { const first = Math.min(15, Math.ceil(data.total_seconds / 2));
          return ['### Part 1: 全体ストーリー＆クリップ配分 (Japanese Breakdown)', '| Clip 1 | 歩く |', '| Clip 2 | 振り返る |', '', '### Part 2: 各クリップ個別プロンプト (ComfyUI Contex-Loop Prompts)', '',
            `=== SCENE 1 (duration: ${first}s) ===`, '```text', sections('Walk'), '```', '', `=== SCENE 2 (duration: ${data.total_seconds - first}s) ===`, '```text', sections('Turn'), '```'].join('\n'); })()
        : promptOutput ?? JSON.stringify({ shots: data.cuts.filter(c => data.selected_cut == null || c.id === JSON.parse(node.widgets.find(w => w.name === 'plan_json').value).shots[data.selected_cut - 1].id).map(c => ({ id: c.id, prompt: 'Generated ' + c.id, start_state: 'Start ' + c.id, end_state: 'End ' + c.id })) });
      if (stage === 'prompt') onPrompt();
      const id = String(llmCalls.length); history.set(id, { status: { completed: true }, outputs: { result: { text: [text] } } });
      return { ok: true, json: async () => ({ prompt_id: id }) };
    }
    assert.equal(path, '/upload/image');
    const file = request.body.get('image'); uploaded.push(file.name);
    uploadedBytes.set(file.name, await file.arrayBuffer());
    return { ok: true, json: async () => ({ name: file.name, subfolder: 'h3_scene_director' }) };
  },
};
class Queue {
  constructor() {}
  async generate(record) {
    this.busy = true;
    try {
      node.widgets.find(w => w.name === "plan_json").serializeValue();
      queuedRecord = structuredClone(record); await onGenerate();
    }
    finally { this.busy = false; }
  }
  async stop() { generationStops++; }
  async batch(...args) { batchCalls.push(args); }
}
const scene = { mode: "R2V", assets: [{ kind: "image", file: "ref.png", role: "reference" }, { kind: "image", file: "other.png", role: "reference" }] };
const plan = { prompt_prefix: "Shared", shots: [{ id: "a", prompt: "First", seed: "18446744073709551615", duration_seconds: 15 }, { id: "b", prompt: "Second", duration_seconds: 15 }] };
class Node {
  constructor() {
    this.properties = { h3_llm: { loader: { model: 'existing.gguf' }, story: { inputs: {}, parameters: {} }, prompt: { inputs: {}, parameters: {} } } }; this.id = 1200; this.graph = { change() {} };
    this.widgets = [{ name: "run_name", value: "auto" }, { name: "plan_json", value: JSON.stringify(plan) }, { name: "scene_json", value: JSON.stringify(scene) }, { name: "use_current_settings", value: false }];
  }
  setDirtyCanvas() {}
  addDOMWidget(name, type, element) { this.element = element; document.body.append(element); }
}
const source = (await readFile(new URL("./web/director.js", import.meta.url), "utf8")).replace(/^import .*;\r?\n/gm, "").replace("import.meta.url", JSON.stringify(new URL("./web/director.js", import.meta.url).href));
const llmSource = (await readFile(new URL("./web/director_dialog.js", import.meta.url), "utf8")).replace(/^import .*;\r?\n/gm, "").replaceAll("export ", "");
const LLM = new Function("api", "draftGraph", "readDraft", "sceneGraph", "readScene", "sceneAssets", "referenceDescriptions", "referenceDefinitions", "imageAnalysisKey", llmSource + '\nreturn DirectorLLM;')(api, draftGraph, readDraft, sceneGraph, readScene, sceneAssets, referenceDescriptions, referenceDefinitions, imageAnalysisKey);
const queueSource = (await readFile(new URL("./web/director_queue.js", import.meta.url), "utf8")).replace(/^import .*;\r?\n/gm, "").replaceAll("export ", "");
const batchProgress = new Function(queueSource + '\nreturn batchProgress;')();
new Function("app", "api", "document", "readPlan", "updateCut", "sceneAssets", "referenceDescriptions", "applyDraft", "SCENE_CUT_SECONDS", "DirectorLLM", "openLLMSettings", "DirectorQueue", "projectRequest", "confirm", "batchProgress", source)(
  app, api, document, readPlan, updateCut, sceneAssets, referenceDescriptions, applyDraft, SCENE_CUT_SECONDS, LLM, () => { draftOpened = true; }, Queue,
  async (project, action) => {
    projectCalls.push({ project, action });
    return action === 'load' ? { title: 'Cloud scene', plan, scene: { mode: 'T2V', assets: [] }, video: null } : libraryData;
  }, () => true, batchProgress);
await extension.beforeRegisterNodeDef(Node, { name: "H3SceneDirector" });
const node = new Node(); node.onNodeCreated();
const root = node.element;
root.focus = () => {};
const byText = text => [...root.querySelectorAll("button")].find(b => b.textContent === text);
const field = text => [...root.querySelectorAll("label")].find(l => l.querySelector(".label")?.textContent === text)?.querySelector("input,textarea,select");
const assertHealthy = () => assert.equal(root.querySelector('[role="alert"]').textContent, "");
assertHealthy();
// Existing saved state fields must not reappear or affect direct multi-cut prompts.
const originalPlanValue = node.widgets.find(w => w.name === 'plan_json').value;
const originalSceneValue = node.widgets.find(w => w.name === 'scene_json').value;
node.widgets.find(w => w.name === 'plan_json').value = JSON.stringify({ shots: [
  { id: 'first', prompt: 'Walk to the door. End with one hand on its handle.', duration_seconds: 15, start_state: 'Stale start', end_state: 'Stale ending' },
  { id: 'second', prompt: 'At the door, hand on the handle, open it and enter.', duration_seconds: 15 },
] });
node.widgets.find(w => w.name === 'scene_json').value = JSON.stringify({ mode: 'I2V', assets: [{ kind: 'image', role: 'first', file: 'ref.png' }] });
node.onConfigure();
assert.equal(field('開始状態'), undefined);
assert.equal(field('終了状態'), undefined);
await byText('全カットまとめて作成').onclick();
await root.querySelector('[aria-label="カット 2"]').onclick();
field('カット 2 のPrompt').value = 'At the door with a hand on the handle, open it and enter the room.';
field('カット 2 のPrompt').oninput();
await byText('このシーンを生成').onclick(); assertHealthy();
assert.equal(queuedRecord.plan.shots.length, 2);
assert.equal(queuedRecord.plan.shots[1].prompt, field('カット 2 のPrompt').value);
assert.equal(queuedRecord.plan.shots[0].prompt, 'Walk to the door. End with one hand on its handle.');
node.widgets.find(w => w.name === 'plan_json').value = originalPlanValue;
node.widgets.find(w => w.name === 'scene_json').value = originalSceneValue;
node.onConfigure();
console.log('State fields removed; I2V multi-cut direct prompts reach generation unchanged.');
field('プロジェクト').value = 'My current project';
await byText('開く').onclick(); assertHealthy();
assert.deepEqual(projectCalls.at(-1), { project: 'My current project', action: 'open' });
assert.match(root.querySelector('[role="status"]').textContent, /保存先を開きました：test/);
assert.equal(byText('開く').parentElement, field('プロジェクト').parentElement.parentElement);
assert.equal(root.querySelectorAll(".prompt").length, 1);
field("カット 1 のPrompt").value = "Edited first"; field("カット 1 のPrompt").oninput();
await root.querySelector('[aria-label="カット 2"]').onclick();
assert.equal(field("カット 2 のPrompt").value, "Second");
field("カット 2 のPrompt").value = "Edited second"; field("カット 2 のPrompt").oninput();
await byText("＋ カット追加").onclick();
assert.equal(root.querySelectorAll(".cut-tab").length, 3);
field("カット 3 のPrompt").value = "Third"; field("カット 3 のPrompt").oninput();
await byText("LLM設定").onclick(); assert.equal(draftOpened, true);
await byText("このシーンを生成").onclick();
assert.deepEqual(queuedRecord.plan.shots.map(s => s.prompt), ["Edited first", "Edited second", "Third"]);
assert.equal(queuedRecord.plan.shots[0].seed, "18446744073709551615");
node.onConfigure(); assertHealthy();
await byText("保存済み・一括生成").onclick();
assert.ok(root.textContent.includes("保存済みシーンはありません"));
await byText("作成").onclick();
assert.equal(root.querySelectorAll(".prompt").length, 1);
await byText("このカットを削除").onclick();
assert.equal(root.querySelectorAll(".cut-tab").length, 2);
assertHealthy();
const storedScene = () => JSON.parse(node.widgets.find(w => w.name === 'scene_json').value);
const lanes = () => [...root.querySelectorAll('.media-lane')].map(z => z.dataset.kind);
const slots = kind => [...root.querySelectorAll(`.media-slot[data-kind="${kind}"]`)];
const switchMode = async mode => { await root.querySelector(`[data-mode="${mode}"]`).onclick(); assertHealthy(); };
assert.equal(field('生成モード'), undefined, 'Mode must be buttons, not a select');
assert.deepEqual([...root.querySelectorAll('.mode-button')].map(b => b.textContent), ['T2VA', 'I2VA', 'FL2VA', 'L2VA', 'REF2VA']);
assert.deepEqual(lanes(), ['image', 'video', 'audio']);
assert.deepEqual(lanes().map(kind => slots(kind).length), [9, 3, 3]);
async function drop(kind, slot, name, type) {
  const zone = slot == null ? root.querySelector(`.media-lane[data-kind="${kind}"]`) : slots(kind)[slot];
  let prevented = false, stopped = false;
  await zone.ondrop({ dataTransfer: { files: [new File(['fixture'], name, { type })] },
    preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
  assert.equal(prevented, true); assert.equal(stopped, true);
}
await drop('image', 8, 'new.png', 'image/png');
await drop('audio', null, 'sound.flac', '');
await drop('video', null, 'movie.mkv', '');
assert.deepEqual(storedScene().assets.map(a => [a.kind, a.slot]), [['image', 0], ['image', 1], ['image', 8], ['video', 0], ['audio', 0]]);
assert.deepEqual(uploaded, ['new.png', 'sound.flac', 'movie.mkv']);
assert.equal(slots('image')[2].classList.contains('empty-slot'), true);
assert.equal(slots('image')[8].classList.contains('media-clip'), true);
// Pointer dragging swaps occupied slots and preserves empty positions through reload.
function dragImage(from, to) {
  const tiles = slots('image');
  for (let i = 0; i < tiles.length; i++) tiles[i].getBoundingClientRect = () => ({ left: i * 120, width: 112 });
  const tile = tiles[from];
  tile.onpointerdown({ button: 0, target: tile, clientX: from * 120 + 56, pointerId: 1, stopPropagation() {} });
  tile.onpointermove({ clientX: to * 120 + 56 });
  tile.onpointerup({ clientX: to * 120 + 56 });
}
dragImage(8, 0);
assert.ok(storedScene().assets[0].file.endsWith('new.png'));
assert.equal(storedScene().assets.find(a => a.file === 'ref.png').slot, 8);
assert.deepEqual(referenceDescriptions(storedScene()).filter(r => r.kind === 'image').map(r => r.label), ['<Picture 1>', '<Picture 2>', '<Picture 3>']);
node.onConfigure(); assert.equal(slots('image')[8].classList.contains('media-clip'), true);
await switchMode('FL2V');
assert.deepEqual(lanes(), ['image']); assert.equal(slots('image').length, 2);
assert.deepEqual(sceneAssets(storedScene()).map(a => [a.role, a.slot]), [['first', 0], ['last', 1]]);
assert.ok(sceneAssets(storedScene())[0].file.endsWith('new.png'), 'Changing mode reuses the image in slot 1');
await drop('image', 0, 'start.png', 'image/png');
await drop('image', 1, 'end.png', 'image/png');
await drop('image', 0, 'replacement.png', 'image/png');
assert.equal(storedScene().assets.filter(a => a.role === 'first').length, 1);
assert.ok(storedScene().assets.find(a => a.role === 'first').file.endsWith('replacement.png'));
assert.equal(sceneAssets(storedScene()).length, 2);
await switchMode('I2V');
assert.equal(slots('image').length, 1); assert.equal(sceneAssets(storedScene())[0].role, 'first');
await switchMode('L2V');
assert.equal(slots('image').length, 2);
assert.equal(slots('image')[0].getAttribute('aria-disabled'), 'true');
assert.ok(slots('image')[0].textContent.includes('Not Used'));
assert.equal(sceneAssets(storedScene())[0].file.endsWith('end.png'), true);
const beforeLockedDrop = uploaded.length;
await drop('image', 0, 'locked.png', 'image/png');
assert.equal(uploaded.length, beforeLockedDrop); assert.match(root.querySelector('[role="alert"]').textContent, /先頭スロット/);
await switchMode('T2V');
assert.deepEqual(lanes(), []); assert.equal(sceneAssets(storedScene()).length, 0);
node.onConfigure(); assert.deepEqual(lanes(), []);
await switchMode('R2V');
assert.equal(sceneAssets(storedScene()).length, 5);
assert.equal(slots('image')[8].classList.contains('media-clip'), true);
dragImage(8, 4);
assert.equal(storedScene().assets.find(a => a.file === 'ref.png').slot, 4);
node.onConfigure(); assert.equal(slots('image')[4].classList.contains('media-clip'), true);
assert.equal(slots('image')[8].classList.contains('empty-slot'), true);
await byText('このシーンを生成').onclick();
assert.deepEqual(queuedRecord.scene, storedScene(), 'Generation must receive the same slot order and roles as the UI');
await root.querySelector('[aria-label="Image 5を削除"]').onclick({ stopPropagation() {} });
assert.equal(slots('image')[4].classList.contains('empty-slot'), true);
assert.equal(storedScene().assets.some(a => a.file === 'ref.png'), false);
root.querySelector('.media-lane[data-kind="audio"]').onclick();
await root.onpaste({ target: root, clipboardData: { files: [new File(['fixture'], 'paste.wav', { type: 'audio/wav' })] }, preventDefault() {}, stopPropagation() {} });
assert.equal(storedScene().assets.find(a => a.file.endsWith('paste.wav')).slot, 1);
root.onkeydown({ key: 'Delete', target: root.querySelector('.prompt'), preventDefault() {}, stopPropagation() {} });
assert.ok(storedScene().assets.some(a => a.file.endsWith('paste.wav')), 'Editing prompt text must not delete selected media');
root.onkeydown({ key: 'Delete', target: root, preventDefault() {}, stopPropagation() {} });
assert.equal(storedScene().assets.some(a => a.file.endsWith('paste.wav')), false);
await drop('audio', 0, 'wrong.png', 'image/png');
assert.match(root.querySelector('[role="alert"]').textContent, /ファイルの種類/);
await switchMode('R2V');
assertHealthy();
await root.querySelector('[aria-label="カット 1"]').onclick();
field('カット 1の日本語指示').value = '庭を歩く'; field('カット 1の日本語指示').oninput();
await root.querySelector('[aria-label="カット 2"]').onclick();
assert.equal(field('カット 2の日本語指示').value, '');
field('カット 2の日本語指示').value = '振り返る'; field('カット 2の日本語指示').oninput();
await byText('画像をまとめて解析').onclick(); assertHealthy();
const analyzed = llmCalls.length;
assert.ok(analyzed > 0 && llmCalls.every(c => c.stage === 'analysis'));
assert.ok(llmCalls.every(c => c.data.instruction === '振り返る'));
assert.ok(field('カット 2の日本語指示').placeholder.includes('ストーリーボード'));
await byText('画像をまとめて解析').onclick(); assertHealthy();
assert.equal(llmCalls.length, analyzed, 'Reuse completed image analyses');
assert.ok(root.querySelector('.analysis-badge').textContent.includes('解析済み'));
await switchMode('I2V');
assert.equal(root.querySelector('.analysis-badge').textContent, '解析済み');
await drop('image', 0, 'same-content-new-name.png', 'image/png'); assertHealthy();
assert.equal(root.querySelector('.analysis-badge').textContent, '解析済み', 'Imported copy reuses its analysis before an LLM action');
await byText('画像をまとめて解析').onclick(); assertHealthy();
assert.equal(llmCalls.length, analyzed, 'Changing mode and importing identical bytes does not rerun analysis');
node.properties = JSON.parse(JSON.stringify(node.properties)); node.onConfigure();
assert.equal(root.querySelector('.analysis-badge').textContent, '解析済み');
await switchMode('R2V');
await root.querySelector('.media-clip[data-kind="image"] .clip-details').onclick({ stopPropagation() {} });
assertHealthy();
await byText('この画像を再解析').onclick(); assertHealthy();
assert.equal(llmCalls.length, analyzed + 1, 'Individual image action queues just one analysis');
field('画像解析結果（確認・編集）').value = '手動で確認した人物'; field('画像解析結果（確認・編集）').oninput();
const prior = JSON.parse(node.widgets.find(w => w.name === 'plan_json').value);
await byText('ストーリー→Prompt').onclick(); assertHealthy();
assert.deepEqual(llmCalls.slice(-2).map(c => c.stage), ['story', 'prompt']);
assert.equal(llmCalls.at(-1).data.selected_cut, 2);
assert.equal(llmCalls.at(-1).data.include_previous, true);
assert.ok(llmCalls.at(-1).data.image_analysis.includes('手動で確認した人物'));
assert.equal(field('カット 2のストーリー').value, '庭を歩いて振り返る');
const applied = JSON.parse(node.widgets.find(w => w.name === 'plan_json').value);
assert.deepEqual(applied.shots[0], prior.shots[0]);
assert.equal(applied.shots[1].prompt, 'Generated ' + applied.shots[1].id, 'The LLM prompt is kept as written');
assert.equal(field('カット 2 のPrompt').value, applied.shots[1].prompt);
assert.equal(byText('草案を適用'), undefined);
assert.equal(byText('草案を破棄'), undefined);
const previous = [...root.querySelectorAll('label')].find(l => l.textContent.includes('前カットの終了状況をPromptに含める')).querySelector('input');
assert.equal(previous.checked, true, 'Continuation defaults ON for cut 2');
previous.checked = false; previous.onchange();
field('カット 2のストーリー').value = ''; field('カット 2のストーリー').oninput();
await byText('Prompt作成').onclick(); assertHealthy();
assert.equal(llmCalls.at(-1).data.include_previous, false);
assert.equal(llmCalls.at(-1).data.cuts.length, 1);
assert.equal(llmCalls.at(-1).data.story, '');
assert.equal(llmCalls.at(-1).data.instruction, '振り返る');
field('カット 2 のPrompt').value = 'Manual after generation'; field('カット 2 のPrompt').oninput();
assert.equal(JSON.parse(node.widgets.find(w => w.name === 'plan_json').serializeValue()).shots[1].prompt, 'Manual after generation');
await root.querySelector('[aria-label="カット 1"]').onclick();
assert.equal(field('カット 1の日本語指示').value, '庭を歩く');
await byText('Prompt作成').onclick(); assertHealthy();
assert.equal(llmCalls.at(-1).data.include_previous, false);
assert.equal(llmCalls.at(-1).data.cuts.length, 1);
node.onConfigure();
assert.equal(field('カット 1の日本語指示').value, '庭を歩く');
await root.querySelector('[aria-label="カット 2"]').onclick();
assert.equal([...root.querySelectorAll('label')].find(l => l.textContent.includes('前カットの終了状況をPromptに含める')).querySelector('input').checked, false, 'Saved OFF survives reload');
// Reproduce the reported workflow: two blank cuts whose IDs differ from their tab numbers.
const planWidget = node.widgets.find(w => w.name === 'plan_json');
planWidget.value = JSON.stringify({ prompt_prefix: '', shots: [
  { id: 'cut2', prompt: '', duration_seconds: 15 }, { id: 'cut3', prompt: '', duration_seconds: 15 },
] });
node.onConfigure();
await root.querySelector('[aria-label="カット 1"]').onclick();
await byText('Prompt作成').onclick(); assertHealthy();
assert.equal(field('カット 1 のPrompt').value, 'Generated cut2');
const firstGenerated = field('カット 1 のPrompt').value;
await root.querySelector('[aria-label="カット 2"]').onclick();
await byText('Prompt作成').onclick(); assertHealthy();
assert.equal(llmCalls.at(-1).data.previous_prompt, firstGenerated);
assert.equal(llmCalls.at(-1).data.previous_end_state, undefined);
assert.doesNotMatch(JSON.stringify(llmCalls.at(-1).data), /start_state|end_state/);
assert.equal([...root.querySelectorAll('label')].some(l => /^(開始状態|終了状態)$/.test(l.querySelector('.label')?.textContent ?? '')), false);
assert.equal(field('カット 2 のPrompt').value, 'Generated cut3');
const generated = JSON.parse(planWidget.serializeValue());
assert.deepEqual(generated.shots.map(s => s.prompt), ['Generated cut2', 'Generated cut3']);
await byText('このシーンを生成').onclick(); assertHealthy();
assert.deepEqual(queuedRecord.plan, generated);
node.onConfigure(); assertHealthy();
assert.deepEqual(JSON.parse(planWidget.serializeValue()), generated);

for (const output of [
  '{"shots":[{"id":"cut2",""prompt":"Recovered second cut"}]}',
  '{"shots":[{"prompt":"Recovered second cut","end_state":"unfinished',
]) {
  promptOutput = output;
  await byText('Prompt作成').onclick(); assertHealthy();
  assert.equal(field('カット 2 のPrompt').value, 'Recovered second cut');
  const recovered = JSON.parse(planWidget.serializeValue());
  assert.deepEqual(recovered.shots[0], generated.shots[0]);
  assert.equal(recovered.shots[1].id, 'cut3');
  await byText('このシーンを生成').onclick(); assertHealthy();
  assert.equal(queuedRecord.plan.shots[1].prompt, recovered.shots[1].prompt);
}
planWidget.value = JSON.stringify(generated); node.onConfigure();
for (const output of ['{"shots":[{""start_state":"broken"}]}', '{"shots":[{"prompt":"unfinished', '{"shots":[{"prompt":""}]}']) {
  promptOutput = output;
  await byText('Prompt作成').onclick();
  assert.ok(root.querySelector('[role="alert"]').textContent);
  assert.deepEqual(JSON.parse(planWidget.serializeValue()), generated, 'Invalid LLM output must not overwrite prompts');
}
promptOutput = null;
onPrompt = () => { field('カット 2 のPrompt').value = 'Edited while generating'; field('カット 2 のPrompt').oninput(); };
await byText('Prompt作成').onclick();
assert.match(root.querySelector('[role="alert"]').textContent, /処理中にカットが変更/);
assert.equal(JSON.parse(planWidget.serializeValue()).shots[1].prompt, 'Edited while generating');
onPrompt = () => {};
await byText('ストーリー作成').onclick(); assertHealthy();
assert.equal(JSON.parse(planWidget.serializeValue()).shots[1].prompt, 'Edited while generating', 'Story-only generation preserves prompts');
assert.equal(field('合計生成秒数（overlap込み）'), undefined, 'Only the selected LLM form is shown');
assert.equal(byText('カット 2 のLLM作成').getAttribute('aria-selected'), 'true');
await byText('全カットまとめて作成').onclick(); assertHealthy();
assert.equal(byText('全カットまとめて作成').getAttribute('aria-selected'), 'true');
assert.equal(root.querySelectorAll('.cut-writing').length, 1, 'One LLM form at a time');
const bulk = root.querySelector('.cut-writing');
assert.equal(field('合計生成秒数（overlap込み）').value, '30', 'Total defaults to the current cut seconds');
const storyBefore = field('全カットのストーリー').value;
await [...bulk.querySelectorAll('button')].find(b => b.textContent === 'Prompt作成').onclick(); assertHealthy();
assert.equal(llmCalls.at(-1).stage, 'scene', 'One request plans every cut');
assert.equal(llmCalls.at(-1).data.total_seconds, 30);
assert.equal(llmCalls.at(-1).system, '', 'The whole request is one user message, as in short_storygen_h3');
assert.match(llmCalls.at(-1).data.text, /# Full-Reference Mode Rewrite Output Format Guide/);
assert.match(llmCalls.at(-1).data.text, /DECIDE YOURSELF how many clips/);
assert.equal(llmCalls.at(-1).parameters.max_tokens, node.properties.h3_llm.prompt.parameters.max_tokens, 'Whole-scene generation uses the configured output limit');
let planned = JSON.parse(planWidget.serializeValue());
assert.deepEqual(planned.shots.map(s => [s.id, s.duration_seconds]), [['cut1', 15], ['cut2', 15]], 'The LLM decides the cut lengths');
assert.ok(planned.shots.every(s => s.prompt.startsWith('subject_definitions:') && s.prompt.endsWith('non_diegetic_music:\nN/A')));
assert.equal(field('全カットのストーリー').value, storyBefore, 'Prompt-only creation keeps the story');
assert.equal(root.querySelectorAll('.cut-writing button').length, 4, 'The whole-scene form has the combined action');
field('合計生成秒数（overlap込み）').value = '25'; field('合計生成秒数（overlap込み）').oninput();
queuedRecord = null;
await byText('ストーリー→Prompt→生成').onclick(); assertHealthy();
assert.equal(llmCalls.at(-1).stage, 'scene');
assert.equal(llmCalls.at(-1).data.total_seconds, 25);
planned = JSON.parse(planWidget.serializeValue());
assert.deepEqual(planned.shots.map(s => s.duration_seconds), [13, 12]);
assert.match(field('全カットのストーリー').value, /歩く/, 'The combined action stores the allocation as the story');
assert.deepEqual(queuedRecord.plan, planned, 'Bulk generation uses the newly applied prompts');
sceneOutput = '### Part 2\n\n=== SCENE 1 (duration: 5s) ===\n```text\nsubject_definitions:\nA\n```\n\n=== SCENE 2 (duration: 20s) ===\n```text\ndetailed_description:\nB\n```';
queuedRecord = null;
await byText('ストーリー→Prompt→生成').onclick();
assert.match(root.querySelector('[role="alert"]').textContent, /カット 2 が20秒です/);
assert.match(root.querySelector('[role="alert"]').textContent, /カット 1 のPromptに公式の6項目/);
planned = JSON.parse(planWidget.serializeValue());
assert.deepEqual(planned.shots.map(s => [s.duration_seconds, s.prompt]), [[5, 'subject_definitions:\nA'], [20, 'detailed_description:\nB']], 'Problem results are kept for inspection');
assert.equal(queuedRecord, null, 'Problem results do not start video generation');
sceneOutput = null;
const findBulk = () => root.querySelector('.cut-writing');
field('合計生成秒数（overlap込み）').value = '10'; field('合計生成秒数（overlap込み）').oninput();
await [...findBulk().querySelectorAll('button')].find(b => b.textContent === 'Prompt作成').onclick(); assertHealthy();
planned = JSON.parse(planWidget.serializeValue());
assert.deepEqual(planned.shots.map(s => [s.id, s.duration_seconds]), [['cut1', 10]], 'Up to 15 seconds makes one cut');
assert.equal(llmCalls.at(-1).stage, 'prompt', 'One cut uses the single-cut prompt request');
assert.equal(llmCalls.at(-1).data.selected_cut, 1);
field('合計生成秒数（overlap込み）').value = '30'; field('合計生成秒数（overlap込み）').oninput();
await [...findBulk().querySelectorAll('button')].find(b => b.textContent === 'Prompt作成').onclick(); assertHealthy();
const multiplePlan = planWidget.serializeValue();
const singlePlan = JSON.parse(multiplePlan); singlePlan.shots = singlePlan.shots.slice(0, 1);
planWidget.value = JSON.stringify(singlePlan); node.onConfigure();
await byText('カット 1 のLLM作成').onclick(); assertHealthy();
assert.equal(root.querySelectorAll('.cut-writing button').length, 4, 'A single cut exposes the combined action in its own form too');
queuedRecord = null;
await byText('ストーリー→Prompt').onclick(); assertHealthy();
assert.equal(queuedRecord, null, 'Existing action does not generate video');
field('カット 1 のPrompt').value = 'Old single-cut prompt with speech'; field('カット 1 のPrompt').oninput();
promptOutput = JSON.stringify({ shots: [{ prompt: 'subject_definitions:\n<Subject 1> is the referenced person.\n\nsummary:\n[reference generation] Quiet study.\n\nretention_analysis:\n<Subject 1>: fully_preserved - appearance.\n\ndetailed_description:\n[Shot 1] The person writes silently.\n\noverall_soundscape:\nRoom tone and pen sounds only. No voices.\n\nnon_diegetic_music:\nN/A', start_state: 'Writing.', end_state: 'Still writing.' }] });
onGenerate = async () => {
  assert.equal(field('カット 1 のPrompt').value, queuedRecord.plan.shots[0].prompt, 'The visible prompt updates before video generation');
  assert.deepEqual(JSON.parse(planWidget.serializeValue()), queuedRecord.plan, 'Queue serialization preserves the new prompt');
  assert.deepEqual([...queuedRecord.plan.shots[0].prompt.matchAll(/^(\w+):$/gm)].map(match => match[1]), ['subject_definitions', 'summary', 'retention_analysis', 'detailed_description', 'overall_soundscape', 'non_diegetic_music']);
  assert.ok(queuedRecord.plan.shots[0].prompt.endsWith('overall_soundscape:\nRoom tone and pen sounds only. No voices.\n\nnon_diegetic_music:\nN/A'));
  await byText('中止').onclick();
};
await byText('ストーリー→Prompt→生成').onclick(); assertHealthy();
assert.deepEqual(llmCalls.slice(-2).map(c => c.stage), ['story', 'prompt']);
assert.equal(llmCalls.at(-1).data.selected_cut, 1);
assert.equal(queuedRecord.plan.shots.length, 1);
assert.deepEqual(queuedRecord.plan, JSON.parse(planWidget.serializeValue()));
assert.equal(generationStops, 1, 'Stop targets video generation after the LLM stage');
onGenerate = async () => {};
const combinedPlan = structuredClone(queuedRecord.plan);
await byText('このシーンを生成').onclick(); assertHealthy();
assert.deepEqual(queuedRecord.plan, combinedPlan, 'Subsequent generation keeps the new prompt');
queuedRecord = null; promptOutput = 'invalid JSON';
await byText('ストーリー→Prompt→生成').onclick();
assert.ok(root.querySelector('[role="alert"]').textContent);
assert.equal(queuedRecord, null, 'Invalid prompts do not start video generation');
promptOutput = null;
onPrompt = () => { byText('中止').onclick(); };
await byText('ストーリー→Prompt→生成').onclick();
assert.equal(queuedRecord, null, 'Cancelled LLM work does not start video generation');
onPrompt = () => {};
planWidget.value = multiplePlan; node.onConfigure();
console.log("Director DOM: direct prompt updates, sequential cut continuity, RUN serialization, invalid-output preservation, concurrent edits, story-only and bulk generation passed.");
console.log('Director UI: mode buttons, 9/3/3 lanes, shared boundary slots, locked L2V start, slot drops, pointer swapping/moving, reference order, replacement, removal and reload passed.');
libraryData = { directory: '/workspace/MyScenes', scenes: Array.from({ length: 40 }, (_, i) => ({ id: `s${i + 1}`, title: `Scene ${i + 1}`, mode: 'T2V', cuts: 2, video: null })),
  batch: { ids: ['s12', 's13'], positions: [12, 13], total: 40, completed: [{ id: 's12', video: { project: '/workspace/MyScenes', subfolder: 'batches/test', filename: 'done.mp4' } }], status: 'error', error: 'Interrupted' } };
field('プロジェクト').value = '/workspace/MyScenes'; field('プロジェクト').onchange();
await byText('読込').onclick(); assertHealthy();
assert.equal(projectCalls.at(-1).project, '/workspace/MyScenes');
assert.equal(node.properties.h3_project, '/workspace/MyScenes');
assert.deepEqual(JSON.parse(node.widgets.find(w => w.name === 'scene_json').serializeValue()).output, { project: '/workspace/MyScenes' });
assert.match(root.querySelector('a').href, /h3_scene_director\/video\?/);
assert.equal(root.querySelectorAll('.library-item').length, 40);
assert.ok(root.textContent.includes('40. Scene 40'));
assert.ok(root.textContent.includes('エラー位置：シーン 13/40'));
field('開始番号').value = '12';
await byText('この番号から末尾まで生成').onclick(); assertHealthy();
assert.deepEqual(batchCalls.at(-1), ['/workspace/MyScenes', [], false, 12]);
await byText('未完了から再開').onclick(); assertHealthy();
assert.deepEqual(batchCalls.at(-1), ['/workspace/MyScenes', [], true]);
field('開始番号').value = '41';
const count = batchCalls.length;
await byText('この番号から末尾まで生成').onclick();
assert.match(root.querySelector('[role="alert"]').textContent, /開始番号/);
assert.equal(batchCalls.length, count);
await root.querySelector('.library-item button').onclick(); assertHealthy();
assert.equal(field('カット 1 のPrompt').value, plan.shots[0].prompt);
assert.equal(node.widgets.find(w => w.name === 'use_current_settings').value, true);
assert.equal(root.querySelector('.result-video'), null, 'A project without previews still loads for editing/generation');
console.log('Director project UI: absolute path, numbered scenes, start position, missing previews and persisted failure position passed.');

await byText('保存済み・一括生成').onclick();
await byText('バッチLoRA設定').onclick(); assertHealthy();
const flGroup = [...root.querySelectorAll('.section')].find(e => e.querySelector('strong')?.textContent === 'T2V・I2V・L2V・FL2V用');
const [policy, lora] = flGroup.querySelectorAll('select');
assert.equal(policy.value, 'saved');
policy.value = 'override'; policy.onchange();
assert.deepEqual(node.properties.h3_batch_turbo.FL2V, { lora_name: 'minimaxh3/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors' });
assert.equal(node.properties.h3_batch_turbo.R2V, undefined);
assert.equal(flGroup.querySelector('input'), null, 'Turbo selection must not expose steps or strength controls');
assert.deepEqual([...policy.options].map(option => option.textContent), ['保存したTurbo LoRAを使用', 'Turbo LoRAを変更']);
await byText('更新').onclick(); await byText('バッチLoRA設定').onclick();
assert.deepEqual(node.properties.h3_batch_turbo.FL2V, { lora_name: lora.value });
const restoredGroup = [...root.querySelectorAll('.section')].find(e => e.querySelector('strong')?.textContent === 'T2V・I2V・L2V・FL2V用');
const restoredPolicy = restoredGroup.querySelector('select');
restoredPolicy.value = 'saved'; restoredPolicy.onchange();
assert.equal(node.properties.h3_batch_turbo.FL2V, undefined);
console.log('Director batch LoRA UI: file selection only, exact labels, persistence and saved-settings reset passed.');

window.HTMLElement.prototype.showModal = function () { this.setAttribute('open', ''); };
window.HTMLElement.prototype.close = function () { this.dispatchEvent(new window.Event('close')); };
const openSettings = new Function('document', 'SYSTEM_PROMPTS', 'renderSystemPrompt', llmSource + '\nreturn openLLMSettings;')(
  document, SYSTEM_PROMPTS, renderSystemPrompt);
openSettings(node);
let settings = document.querySelector('dialog');
const target = settings.querySelector('[aria-label="システムPromptの対象"]');
const promptEditor = settings.querySelector('[aria-label="システムPrompt本文"]');
const promptPreview = settings.querySelector('[aria-label="送信Promptの展開例"]');
const settingsButton = text => [...settings.querySelectorAll('button')].find(b => b.textContent === text);
assert.equal(promptEditor.value, SYSTEM_PROMPTS.analysis.text);
assert.equal(promptPreview.value, promptEditor.value);
promptEditor.value = 'Custom English analysis.'; promptEditor.oninput();
assert.equal(node.properties.h3_llm.system_prompts, undefined, 'Editing is not saved until Save');
target.value = 'story'; target.onchange();
assert.equal(promptEditor.value, SYSTEM_PROMPTS.story.text);
target.value = 'analysis'; target.onchange();
assert.equal(promptEditor.value, 'Custom English analysis.', 'Switching targets retains unsaved edits within the dialog');
settingsButton('保存').onclick();
assert.equal(node.properties.h3_llm.system_prompts.analysis, 'Custom English analysis.');
for (const key of ['story', 'prompt_r2v', 'prompt_base']) {
  target.value = key; target.onchange();
  promptEditor.value += '\nCustom ' + key; promptEditor.oninput(); settingsButton('保存').onclick();
  assert.ok(promptPreview.value.includes('Custom ' + key));
  assert.doesNotMatch(promptPreview.value, /\{\{/);
}
const modePreview = settings.querySelector('[aria-label="展開例のモード"]');
modePreview.value = 'L2V'; modePreview.onchange();
assert.match(promptPreview.value, /only the ending of the final cut/);
assert.equal(promptPreview.value, draftGraph(node.properties.h3_llm, { mode: 'L2V', assets: [] }, plan, 'prompt', '', '', 0).writer.inputs.system_prompt);
const savedPrompts = structuredClone(node.properties.h3_llm.system_prompts);
promptEditor.value = 'Unsaved edit'; promptEditor.oninput();
settingsButton('閉じる').onclick();
assert.equal(document.querySelector('dialog'), null);
node.properties = JSON.parse(JSON.stringify(node.properties));
openSettings(node); settings = document.querySelector('dialog');
assert.equal(settings.querySelector('textarea').value, savedPrompts.analysis);
assert.deepEqual(node.properties.h3_llm.system_prompts, savedPrompts, 'Workflow round trip preserves every saved prompt and discards the unsaved edit');
settingsButton('標準に戻す').onclick();
assert.equal(settings.querySelector('textarea').value, SYSTEM_PROMPTS.analysis.text);
assert.equal(node.properties.h3_llm.system_prompts.analysis, undefined);
for (const key of ['story', 'prompt_r2v', 'prompt_base']) assert.equal(node.properties.h3_llm.system_prompts[key], savedPrompts[key], 'Reset affects only the selected prompt');
settingsButton('閉じる').onclick();
openSettings(node); settings = document.querySelector('dialog');
assert.equal(settings.querySelector('textarea').value, SYSTEM_PROMPTS.analysis.text, 'Reset survives reopening');
settingsButton('閉じる').onclick();
console.log('Director LLM settings UI: defaults, edits, save, workflow persistence, preview, unsaved close and per-target reset passed.');

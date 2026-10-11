// Optional DOM check: point H3_DOM_MODULE at an installed linkedom ESM entry.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { readPlan, updateCut } from "./web/director_plan.js";
import { sceneAssets, referenceDescriptions, applyDraft, draftGraph, readDraft, imageAnalysisKey, SYSTEM_PROMPTS, renderSystemPrompt } from "./web/director_llm.js";

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
let extension, draftOpened = false, queuedRecord;
const uploaded = [];
const uploadedBytes = new Map();
const llmCalls = [], history = new Map();
const projectCalls = [];
const batchCalls = [];
let libraryData = { scenes: [], batch: null, directory: "test" };
let promptOutput = null, onPrompt = () => {};
const app = { registerExtension: value => { extension = value; } };
const api = { apiURL: value => value, addEventListener() {}, removeEventListener() {},
  async fetchApi(path, request) {
    if (path.startsWith('/view?')) return { ok: true, arrayBuffer: async () => uploadedBytes.get(new URL(path, 'http://localhost').searchParams.get('filename')) ?? new TextEncoder().encode(path).buffer };
    if (path.startsWith('/history/')) { const id = path.split('/').pop(); return { ok: true, json: async () => ({ [id]: history.get(id) }) }; }
    if (path === '/prompt') {
      const graph = JSON.parse(request.body).prompt, data = JSON.parse(graph.writer.inputs.custom_prompt);
      const stage = graph.images ? 'analysis' : graph.writer.inputs.system_prompt.includes('Return a concise editable story') ? 'story' : 'prompt';
      llmCalls.push({ stage, data });
      const text = stage === 'analysis' ? 'A person stands in a garden.' : stage === 'story' ? '庭を歩いて振り返る'
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
  async generate(record) { queuedRecord = structuredClone(record); }
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
const LLM = new Function("api", "draftGraph", "readDraft", "sceneAssets", "referenceDescriptions", "imageAnalysisKey", llmSource + '\nreturn DirectorLLM;')(api, draftGraph, readDraft, sceneAssets, referenceDescriptions, imageAnalysisKey);
const queueSource = (await readFile(new URL("./web/director_queue.js", import.meta.url), "utf8")).replace(/^import .*;\r?\n/gm, "").replaceAll("export ", "");
const batchProgress = new Function(queueSource + '\nreturn batchProgress;')();
new Function("app", "api", "document", "readPlan", "updateCut", "sceneAssets", "referenceDescriptions", "applyDraft", "DirectorLLM", "openLLMSettings", "DirectorQueue", "projectRequest", "confirm", "batchProgress", source)(
  app, api, document, readPlan, updateCut, sceneAssets, referenceDescriptions, applyDraft, LLM, () => { draftOpened = true; }, Queue,
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
await byText('この画像を解析').onclick(); assertHealthy();
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
assert.equal(applied.shots[1].prompt, 'Generated ' + applied.shots[1].id);
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
await root.querySelector('[aria-label="カット 2"]').onclick();
await byText('Prompt作成').onclick(); assertHealthy();
assert.equal(llmCalls.at(-1).data.previous_prompt, 'Generated cut2');
assert.equal(llmCalls.at(-1).data.previous_end_state, 'End cut2');
assert.equal(field('カット 2 のPrompt').value, 'Generated cut3');
const generated = JSON.parse(planWidget.serializeValue());
assert.deepEqual(generated.shots.map(s => s.prompt), ['Generated cut2', 'Generated cut3']);
await byText('このシーンを生成').onclick(); assertHealthy();
assert.deepEqual(queuedRecord.plan, generated);
node.onConfigure(); assertHealthy();
assert.deepEqual(JSON.parse(planWidget.serializeValue()), generated);

for (const output of [
  '{"shots":[{"id":"cut2","prompt":"Recovered second cut",""start_state":"Start",""end_state":"End"}]}',
  '{"shots":[{"prompt":"Recovered second cut","end_state":"unfinished',
]) {
  promptOutput = output;
  await byText('Prompt作成').onclick(); assertHealthy();
  assert.equal(field('カット 2 のPrompt').value, 'Recovered second cut');
  const recovered = JSON.parse(planWidget.serializeValue());
  assert.deepEqual(recovered.shots[0], generated.shots[0]);
  assert.equal(recovered.shots[1].id, 'cut3');
  await byText('このシーンを生成').onclick(); assertHealthy();
  assert.equal(queuedRecord.plan.shots[1].prompt, 'Recovered second cut');
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
const bulk = [...root.querySelectorAll('details')].find(e => e.querySelector('summary')?.textContent === '補助操作：全カットまとめて作成');
await [...bulk.querySelectorAll('button')].find(b => b.textContent === 'Prompt作成').onclick(); assertHealthy();
assert.equal(llmCalls.at(-1).data.selected_cut, null);
assert.deepEqual(JSON.parse(planWidget.serializeValue()).shots.map(s => s.prompt), ['Generated cut2', 'Generated cut3']);
console.log("Director DOM: direct prompt updates, sequential cut continuity, RUN serialization, invalid-output preservation, concurrent edits, story-only and bulk generation passed.");
console.log('Director UI: mode buttons, 9/3/3 lanes, shared boundary slots, locked L2V start, slot drops, pointer swapping/moving, reference order, replacement, removal and reload passed.');
libraryData = { directory: '/workspace/MyScenes', scenes: Array.from({ length: 40 }, (_, i) => ({ id: `s${i + 1}`, title: `Scene ${i + 1}`, mode: 'T2V', cuts: 2, video: null })),
  batch: { ids: ['s12', 's13'], positions: [12, 13], total: 40, completed: [{ id: 's12', video: { filename: 'done.mp4' } }], status: 'error', error: 'Interrupted' } };
field('プロジェクト').value = '/workspace/MyScenes'; field('プロジェクト').onchange();
await byText('読込').onclick(); assertHealthy();
assert.equal(projectCalls.at(-1).project, '/workspace/MyScenes');
assert.equal(node.properties.h3_project, '/workspace/MyScenes');
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
  assert.ok(promptPreview.value.endsWith('Custom ' + key));
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

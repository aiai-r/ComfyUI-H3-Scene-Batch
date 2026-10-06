// Optional DOM check: point H3_DOM_MODULE at an installed linkedom ESM entry.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { readPlan, updateCut } from "./web/director_plan.js";
import { sceneAssets, referenceDescriptions } from "./web/director_llm.js";

if (!process.env.H3_DOM_MODULE) {
  console.log("Director UI DOM check skipped: set H3_DOM_MODULE to linkedom/esm/index.js.");
  process.exit(0);
}
const { parseHTML } = await import(pathToFileURL(process.env.H3_DOM_MODULE));
const { document, window } = parseHTML("<html><head></head><body></body></html>");
// linkedom exposes a read-only select value; browsers provide this setter.
const selectValue = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value");
Object.defineProperty(window.HTMLSelectElement.prototype, "value", { ...selectValue, set(value) {
  for (const option of this.options) option.selected = false;
  const selected = [...this.options].find(option => option.value === value);
  if (selected) selected.selected = true;
} });
let extension, draftOpened = false, queuedRecord;
const uploaded = [];
const app = { registerExtension: value => { extension = value; } };
const api = { apiURL: value => value, addEventListener() {}, removeEventListener() {},
  async fetchApi(path, request) {
    assert.equal(path, '/upload/image');
    const file = request.body.get('image'); uploaded.push(file.name);
    return { ok: true, json: async () => ({ name: file.name, subfolder: 'h3_scene_director' }) };
  },
};
class Queue { constructor() {} async generate(record) { queuedRecord = structuredClone(record); } }
const scene = { mode: "R2V", assets: [{ kind: "image", file: "ref.png", role: "reference" }, { kind: "image", file: "other.png", role: "reference" }] };
const plan = { prompt_prefix: "Shared", shots: [{ id: "a", prompt: "First", seed: "18446744073709551615", duration_seconds: 15 }, { id: "b", prompt: "Second", duration_seconds: 15 }] };
class Node {
  constructor() {
    this.properties = {}; this.id = 1200; this.graph = { change() {} };
    this.widgets = [{ name: "run_name", value: "auto" }, { name: "plan_json", value: JSON.stringify(plan) }, { name: "scene_json", value: JSON.stringify(scene) }, { name: "use_current_settings", value: false }];
  }
  setDirtyCanvas() {}
  addDOMWidget(name, type, element) { this.element = element; document.body.append(element); }
}
const source = (await readFile(new URL("./web/director.js", import.meta.url), "utf8")).replace(/^import .*;\r?\n/gm, "").replace("import.meta.url", JSON.stringify(new URL("./web/director.js", import.meta.url).href));
new Function("app", "api", "document", "readPlan", "updateCut", "sceneAssets", "referenceDescriptions", "openDraftDialog", "DirectorQueue", "projectRequest", "confirm", source)(
  app, api, document, readPlan, updateCut, sceneAssets, referenceDescriptions, () => { draftOpened = true; }, Queue, async () => ({ scenes: [], batch: null, directory: "test" }), () => true);
await extension.beforeRegisterNodeDef(Node, { name: "H3SceneDirector" });
const node = new Node(); node.onNodeCreated();
const root = node.element;
root.focus = () => {};
const byText = text => [...root.querySelectorAll("button")].find(b => b.textContent === text);
const field = text => [...root.querySelectorAll("label")].find(l => l.querySelector(".label")?.textContent === text)?.querySelector("input,textarea,select");
const assertHealthy = () => assert.equal(root.querySelector('[role="alert"]').textContent, "");
assertHealthy();
assert.equal(root.querySelectorAll(".prompt").length, 1);
field("カット 1 のPrompt").value = "Edited first"; field("カット 1 のPrompt").oninput();
await root.querySelector('[aria-label="カット 2"]').onclick();
assert.equal(field("カット 2 のPrompt").value, "Second");
field("カット 2 のPrompt").value = "Edited second"; field("カット 2 のPrompt").oninput();
await byText("＋ カット追加").onclick();
assert.equal(root.querySelectorAll(".cut-tab").length, 3);
field("カット 3 のPrompt").value = "Third"; field("カット 3 のPrompt").oninput();
await byText("LLMで作成・修正").onclick(); assert.equal(draftOpened, true);
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
console.log("Director DOM: inline cut editing, tabs, additions, seed precision, modal entry, generation and library passed.");
console.log('Director UI: mode buttons, 9/3/3 lanes, shared boundary slots, locked L2V start, slot drops, pointer swapping/moving, reference order, replacement, removal and reload passed.');

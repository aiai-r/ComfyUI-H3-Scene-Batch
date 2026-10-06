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
const zones = () => [...root.querySelectorAll('.media-zone')].map(z => [z.dataset.kind, z.dataset.role]);
assert.deepEqual(zones(), [['image', 'reference'], ['audio', 'reference'], ['video', 'reference']]);
async function drop(kind, role, name, type) {
  const zone = root.querySelector(`.media-zone[data-kind="${kind}"][data-role="${role}"]`);
  let prevented = false, stopped = false;
  await zone.ondrop({ dataTransfer: { files: [new File(['fixture'], name, { type })] },
    preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
  assert.equal(prevented, true); assert.equal(stopped, true);
}
await drop('image', 'reference', 'new.png', 'image/png');
await drop('audio', 'reference', 'sound.flac', '');
await drop('video', 'reference', 'movie.mkv', '');
assert.deepEqual(storedScene().assets.slice(-3).map(a => [a.kind, a.role]), [['image', 'reference'], ['audio', 'reference'], ['video', 'reference']]);
assert.deepEqual(uploaded, ['new.png', 'sound.flac', 'movie.mkv']);
field('生成モード').value = 'FL2V'; field('生成モード').onchange();
assert.deepEqual(zones(), [['image', 'first'], ['image', 'last']]);
await drop('image', 'first', 'start.png', 'image/png');
await drop('image', 'last', 'end.png', 'image/png');
await drop('image', 'first', 'replacement.png', 'image/png');
assert.equal(storedScene().assets.filter(a => a.role === 'first').length, 1);
assert.ok(storedScene().assets.find(a => a.role === 'first').file.endsWith('replacement.png'));
assert.equal(sceneAssets(storedScene()).length, 2);
field('生成モード').value = 'I2V'; field('生成モード').onchange();
assertHealthy();
assert.deepEqual(zones(), [['image', 'first']]);
field('生成モード').value = 'L2V'; field('生成モード').onchange();
assert.deepEqual(zones(), [['image', 'last']]);
field('生成モード').value = 'T2V'; field('生成モード').onchange();
assert.deepEqual(zones(), []); assert.equal(sceneAssets(storedScene()).length, 0);
node.onConfigure(); assert.deepEqual(zones(), []);
field('生成モード').value = 'R2V'; field('生成モード').onchange();
assert.equal(sceneAssets(storedScene()).length, 5);
assertHealthy();
console.log("Director DOM: inline cut editing, tabs, additions, seed precision, modal entry, generation and library passed.");
console.log('Director inputs: image/audio/video drops, empty MIME, mode-specific slots, boundary replacement, reload, and drop propagation passed.');

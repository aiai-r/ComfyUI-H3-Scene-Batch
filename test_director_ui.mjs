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
Object.defineProperty(window.HTMLSelectElement.prototype, "value", { ...selectValue, set(value) { for (const o of this.options) o.selected = o.value === value; } });
let extension, draftOpened = false, queuedRecord;
const app = { registerExtension: value => { extension = value; } };
const api = { apiURL: value => value, addEventListener() {}, removeEventListener() {} };
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
console.log("Director DOM: inline cut editing, tabs, additions, seed precision, modal entry, generation and library passed.");

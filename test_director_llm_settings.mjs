import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { draftGraph, sceneGraph, SYSTEM_PROMPTS, renderSystemPrompt } from "./web/director_llm.js";

if (!process.env.H3_DOM_MODULE) throw new Error("Set H3_DOM_MODULE to linkedom/esm/index.js.");
const { parseHTML } = await import(pathToFileURL(process.env.H3_DOM_MODULE));
const { document, window } = parseHTML("<html><body></body></html>");
const selectValue = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value");
Object.defineProperty(window.HTMLSelectElement.prototype, "value", { ...selectValue, set(value) {
  for (const option of this.options) option.selected = false;
  const selected = [...this.options].find(option => option.value === value);
  if (selected) selected.selected = true;
} });
window.HTMLElement.prototype.showModal = function () { this.setAttribute("open", ""); };
window.HTMLElement.prototype.close = function () { this.dispatchEvent(new window.Event("close")); };
let loaderInputs, loaderError = false, changes = 0;
const api = { async fetchApi(path, options) {
  assert.equal(path, "/object_info/llama_cpp_model_loader");
  assert.equal(options.cache, "no-store");
  return { ok: !loaderError, json: async () => ({ llama_cpp_model_loader: { input: { required: loaderInputs } } }) };
} };
const source = (await readFile(new URL("./web/director_dialog.js", import.meta.url), "utf8"))
  .replace(/^import .*;\r?\n/gm, "").replaceAll("export ", "");
const openSettings = new Function("document", "api", "SYSTEM_PROMPTS", "renderSystemPrompt", source + "\nreturn openLLMSettings;")(
  document, api, SYSTEM_PROMPTS, renderSystemPrompt);
const localModel = "HauhauCS\\Gemma4\\model.gguf", localProjector = "HauhauCS\\Gemma4\\mmproj.gguf";
const cloudModel = "GGUF/HauhauCS/Gemma4/model.gguf", cloudProjector = "GGUF/HauhauCS/Gemma4/mmproj.gguf";
const node = { properties: { h3_llm: {
  loader: { model: localModel, mmproj: localProjector, chat_handler: "Gemma4", n_ctx: 32768 },
  story: { inputs: { seed: 42 }, parameters: { max_tokens: 2048, temperature: 0.7 } },
  prompt: { inputs: { seed: 42 }, parameters: { max_tokens: 4096, temperature: 0.6 } },
} }, graph: { change() { changes++; } } };
const scene = { mode: "R2V", assets: [{ kind: "image", role: "reference", file: "ref.png" }] };
const plan = { shots: [{ id: "cut1", duration_seconds: 15, prompt: "Walk." }] };
const flush = () => new Promise(resolve => setImmediate(resolve));
const close = dialog => [...dialog.querySelectorAll("button")].find(b => b.textContent === "閉じる").onclick();
for (const [modelName, projectorName] of [[localModel, localProjector], [cloudModel, cloudProjector]]) {
  loaderInputs = { model: [[modelName]], mmproj: [["None", projectorName]] };
  const before = structuredClone(node.properties.h3_llm);
  openSettings(node);
  const dialog = document.querySelector("dialog");
  await flush();
  const model = dialog.querySelector('[aria-label="model"]'), mmproj = dialog.querySelector('[aria-label="mmproj"]');
  assert.deepEqual([...model.options].filter(o => !o.disabled).map(o => o.value), [modelName]);
  assert.deepEqual([...mmproj.options].filter(o => !o.disabled).map(o => o.value), ["None", projectorName]);
  assert.equal(model.value, modelName === localModel ? modelName : "", "A foreign path must remain unselected");
  assert.equal(mmproj.value, projectorName === localProjector ? projectorName : "");
  assert.deepEqual(node.properties.h3_llm, before, "Opening settings must not silently replace saved paths");
  assert.equal(dialog.querySelector('[aria-label="システムPrompt本文"]').value, SYSTEM_PROMPTS.analysis.text);
  model.value = modelName; model.onchange();
  mmproj.value = projectorName; mmproj.onchange();
  close(dialog);
  node.properties = JSON.parse(JSON.stringify(node.properties));
  for (const action of ["analysis", "story", "prompt"]) {
    const graph = draftGraph(node.properties.h3_llm, scene, plan, action, "Instruction", "Story", 0);
    assert.equal(graph.model.inputs.model, modelName);
    assert.equal(graph.model.inputs.mmproj, projectorName);
  }
  const wholeScene = sceneGraph(node.properties.h3_llm, 15, "Instruction", "", []);
  assert.equal(wholeScene.model.inputs.model, modelName);
  assert.equal(wholeScene.model.inputs.mmproj, projectorName);
  assert.equal(wholeScene.model.inputs.chat_handler, before.loader.chat_handler);
  assert.equal(wholeScene.model.inputs.n_ctx, before.loader.n_ctx);
  openSettings(node);
  const reopened = document.querySelector("dialog"); await flush();
  assert.equal(reopened.querySelector('[aria-label="model"]').value, modelName);
  assert.equal(reopened.querySelector('[aria-label="mmproj"]').value, projectorName);
  close(reopened);
}
openSettings(node); const optionalProjector = document.querySelector("dialog"); await flush();
const noProjector = optionalProjector.querySelector('[aria-label="mmproj"]');
noProjector.value = "None"; noProjector.onchange();
assert.equal(node.properties.h3_llm.loader.mmproj, "None"); close(optionalProjector);
assert.equal(changes, 5);
for (const inputs of [null, { model: [[]], mmproj: [["None"]] }]) {
  loaderError = inputs === null; loaderInputs = inputs;
  const saved = structuredClone(node.properties);
  openSettings(node); const dialog = document.querySelector("dialog"); await flush();
  assert.equal(dialog.querySelector('[aria-label="model"]').disabled, true);
  if (loaderError) assert.match(dialog.textContent, /LLM一覧を取得できません/);
  assert.deepEqual(node.properties, saved); close(dialog);
}
console.log("Director LLM settings: Windows/Cloud lists, explicit selection, persistence, all request paths, None, empty list and fetch failure passed.");

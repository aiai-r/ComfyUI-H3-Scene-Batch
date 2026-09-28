import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
let extension;
let prompt;
const app = globalThis.sceneModeTestApp = {
  graph: { _nodes: [] },
  registerExtension(value) { extension = value; },
  async graphToPrompt() { return structuredClone(prompt); },
};
const generationSource = readFileSync(new URL("web/generation.js", import.meta.url), "utf8");
const generationUrl = `data:text/javascript;base64,${Buffer.from(generationSource).toString("base64")}`;
const source = readFileSync(new URL("web/mode.js", import.meta.url), "utf8")
  .replace('import { app } from "../../scripts/app.js";', "const app = globalThis.sceneModeTestApp;")
  .replace('import { api } from "../../scripts/api.js";', "const api = globalThis.sceneModeTestApi;")
  .replace('"./generation.js"', JSON.stringify(generationUrl));
const { batchPrompt } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
function capture() {
  return {
    id: 830, type: "H3SceneCapture", mode: 0, outputs: [], properties: {},
    widgets: [{ name: "project_dir", value: "project" }, { name: "execution_mode", value: "バッチ生成" },
      { name: "start_at", value: 5 }, { name: "auto_queue", value: true }],
  };
}
const graph = {
  "92": { class_type: "SaveVideo", inputs: { video: ["render", 0], filename_prefix: "original" } },
  render: { class_type: "Render", inputs: { refs: ["817:136", 0], noise: ["817:129", 0], length: ["817:819", 0], model: ["model", 0], steps: 8 } },
  model: { class_type: "Model", inputs: { name: "original-model", strength: 0.75 } },
  "817:136": { class_type: "Refs", inputs: { prompt: ["llm", 0], "ref_images.ref_image_0": ["image", 0] } },
  "817:129": { class_type: "RandomNoise", inputs: { noise_seed: 123 } },
  "817:819": { class_type: "PrimitiveFloat", inputs: { value: 15 } },
  llm: { class_type: "LLM", inputs: { text: "original" } }, image: { class_type: "LoadImage", inputs: { image: "original.png" } },
  "224": { class_type: "PreviewAny", inputs: { source: ["llm", 0] } },
};
const control = capture();
const before = JSON.stringify(graph);
const batch = batchPrompt(graph, control);
assert.equal(JSON.stringify(graph), before, "Submitted source graph is untouched");
assert.equal(control.outputs.length, 0);
assert.deepEqual(batch["830"].inputs, { manifest_path: "project/scenes.json", image_root: "project/images", start_at: 5, auto_queue: true });
assert.deepEqual(batch["817:129"].inputs.noise_seed, ["830", 1]);
assert.deepEqual(batch["830:batch_image_0"].inputs.path, ["830", 3]);
assert.deepEqual(batch.model, graph.model);
assert.equal(batch.render.inputs.steps, 8);
assert.equal(batch.llm, undefined);
assert.equal(batch["224"], undefined);
for (const node of Object.values(batch)) for (const value of Object.values(node.inputs)) {
  if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string") assert.ok(batch[value[0]], `Missing ${value[0]}`);
}
prompt = { output: graph, workflow: { nodes: [control], links: [] } };
app.graph._nodes = [control];
extension.setup();
const queued = await app.graphToPrompt();
assert.deepEqual(queued.output, batch);
assert.deepEqual(queued.workflow, prompt.workflow, "Visible workflow gains no nodes or wires");
control.widgets[1].value = "シーン作成";
assert.deepEqual((await app.graphToPrompt()).output, graph);
app.graph._nodes.push(capture());
control.widgets[1].value = "バッチ生成";
await assert.rejects(app.graphToPrompt(), /1つ/);
app.graph._nodes.pop();

class Node {
  widgets = capture().widgets;
  properties = {};
  outputs = [];
  size = [500, 700];
  computeSize() { return [500, 300]; }
  setSize(size) { this.size = size; }
  setDirtyCanvas() {}
  removeOutput(index) { this.outputs.splice(index, 1); }
}
await extension.beforeRegisterNodeDef(Node, { name: "H3SceneCapture" });
const node = new Node();
node.graph = { getNodeById() {} };
node.onNodeCreated(); node.onConfigure();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(node.outputs.length, 0);
assert.equal(node.widgets[1].label, "実行モード");
assert.deepEqual(node.size, [500, 300]);

const old = new Node();
old.outputs = Array.from({ length: 22 }, () => ({}));
old.properties = { h3_unified_controls: true, scene_batch: { mode: "batch", routes: [{ target: 817, input: "prompt", scene: [822, 1] }], node_modes: { scene: { "822": 0 }, batch: { "831": 0 } } } };
let restored = null;
const llm = { outputs: [{}, {}], mode: 4, connect(slot, target, input) { restored = [slot, target, input]; } };
const target = { inputs: [{ name: "prompt" }], disconnectInput() {} };
const loader = { mode: 0 };
old.graph = { getNodeById(id) { return { "817": target, "822": llm, "831": loader }[id]; } };
old.onNodeCreated(); old.onConfigure();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(old.outputs.length, 0, "The previous 22 visible outputs are removed");
assert.deepEqual(restored, [1, target, 0]);
assert.equal(llm.mode, 0);
assert.equal(loader.mode, 4);
assert.deepEqual(old.properties, {});
console.log("PASS: output-free Capture, internal batch prompt, sixth scene, unchanged visible workflow/model settings, scene mode, and previous 22-output cleanup.");

const { scenePrompt, configureGeneration } = await import(generationUrl);
const mixed = structuredClone(graph);
mixed["817:136"].class_type = "MiniMaxH3ReferenceToVideo";
mixed["817:136"].inputs["ref_images.ref_image_1"] = ["second", 0];
mixed.second = { class_type: "LoadImage", inputs: { image: "second.png" } };
mixed["822:803"] = { class_type: "llama_cpp_instruct_adv", inputs: { images: ["second", 0], system_prompt: "Plot instructions" } };
mixed["822:210"] = { class_type: "llama_cpp_instruct_adv", inputs: { images: ["second", 0], system_prompt: ["822:492", 0] } };
mixed["822:492"] = { class_type: "PrimitiveStringMultiline", inputs: { value: "R2V instructions" } };
for (const mode of ["I2V", "R2V", "L2V", "FL2V"]) {
  const scene = scenePrompt(mixed, mode);
  const saved = { generation_mode: mode, generation_settings: { model: { name: mode + "-model", strength: 0.5 }, render: { steps: 4 } } };
  const result = batchPrompt(mixed, capture(), saved);
  const inputs = result["817:136"].inputs;
  assert.equal(result.model.inputs.name, mode + "-model");
  assert.equal(result.render.inputs.steps, 4);
  if (mode === "R2V") {
    assert.equal(result["817:136"].class_type, "MiniMaxH3ReferenceToVideo");
    assert.deepEqual(inputs["ref_audios.ref_audio_0"], ["830", 13]);
  } else {
    assert.equal(result["817:136"].class_type, "MiniMaxH3ImageToVideo");
    assert.ok(!Object.keys(inputs).some((key) => key.startsWith("ref_")));
    if (mode !== "L2V") assert.deepEqual(inputs.first_frame, ["830:batch_image_0", 0]);
    if (mode !== "I2V") assert.deepEqual(inputs.last_frame, [`830:batch_image_${mode === "FL2V" ? 1 : 0}`, 0]);
    assert.deepEqual(scene["822:210"].inputs.images, mode === "FL2V" ? ["830:scene_images", 0] : ["image", 0]);
    assert.match(scene["822:492"].inputs.value, new RegExp(mode));
    assert.equal(Object.values(result).filter((node) => node.class_type === "H3SceneImagePath").length, mode === "FL2V" ? 2 : 1);
  }
}
const uiControl = capture();
uiControl.widgets[1].value = "シーン作成";
uiControl.addWidget = function (type, name, value, callback, options) {
  const entry = { type, name, value, callback, options }; this.widgets.push(entry); return entry;
};
uiControl.computeSize = () => [400, 400];
uiControl.setSize = () => {};
uiControl.properties.h3_multimode = { mode: "R2V", models: { R2V: {}, FL2V: { unet_name: "fl2v-model" } }, r2vModes: {} };
const generator = { id: 817, widgets: ["unet_name", "lora_name", "strength_model", "lora_name_1", "strength_model_1", "value"].map((name) => ({ name, value: name === "unet_name" ? "custom-r2v" : 4 })) };
const uiNodes = [generator, ...Array.from({ length: 9 }, (_, i) => ({ id: 600 + i, mode: i < 3 ? 0 : 4 })), ...Array.from({ length: 8 }, (_, i) => ({ id: 701 + i, mode: i < 2 ? 0 : 4 })), { id: 802 }, { id: 845 }];
uiControl.graph = { _nodes: uiNodes, getNodeById(id) { return uiNodes.find((n) => n.id === id); }, getNodeOnPos(x, y, nodes) { return nodes[0]; }, setDirtyCanvas() {} };
const canvas = { graph: uiControl.graph, computeVisibleNodes(nodes) { return nodes; }, _renderAllLinkSegments() { return "drawn"; } };
configureGeneration(uiControl, { canvas });
const selector = uiControl.widgets.find((w) => w.name === "生成モード");
selector.callback("I2V");
assert.deepEqual(uiNodes.filter((n) => n.id >= 600 && n.id <= 608 && !n.h3Hidden).map((n) => n.id), [600]);
assert.equal(generator.widgets[0].value, "fl2v-model");
assert.equal(uiControl.graph.getNodeById(802).h3Hidden, true);
assert.ok(!canvas.computeVisibleNodes().some((node) => node.h3Hidden));
assert.equal(canvas._renderAllLinkSegments(null, { origin_id: 601, target_id: 817 }), undefined);
selector.callback("FL2V");
assert.equal(uiControl.graph.getNodeById(601).h3Hidden, false);
assert.equal(uiControl.graph.getNodeById(601).mode, 0);
generator.widgets[0].value = "custom-fl2v";
selector.callback("R2V");
assert.equal(generator.widgets[0].value, "custom-r2v");
assert.deepEqual(uiNodes.filter((n) => n.id >= 600 && n.id <= 608).map((n) => n.mode), [0, 0, 0, 4, 4, 4, 4, 4, 4]);
selector.callback("L2V");
assert.equal(generator.widgets[0].value, "custom-fl2v");
configureGeneration(uiControl, { canvas });
assert.equal(uiControl.widgets.filter((w) => w.name === "生成モード").length, 1);
console.log("PASS: four mixed modes, first/last frame routing, audio exclusion, saved model/steps, LLM inputs, visibility and model-family switch restoration.");

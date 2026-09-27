import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
let extension;
let prompt;
const app = globalThis.sceneModeTestApp = {
  graph: { _nodes: [] },
  registerExtension(value) { extension = value; },
  async graphToPrompt() { return structuredClone(prompt); },
};
const source = readFileSync(new URL("web/mode.js", import.meta.url), "utf8")
  .replace('import { app } from "../../scripts/app.js";', "const app = globalThis.sceneModeTestApp;");
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

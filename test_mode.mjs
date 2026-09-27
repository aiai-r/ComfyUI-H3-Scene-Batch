import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let extension;
const notices = [];
globalThis.sceneModeTestApp = {
  registerExtension(value) { extension = value; },
  extensionManager: { toast: { add(value) { notices.push(value); } } },
};
const source = readFileSync(new URL("web/mode.js", import.meta.url), "utf8")
  .replace('import { app } from "../../scripts/app.js";', "const app = globalThis.sceneModeTestApp;");
const { switchSceneMode } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const names = ["prompt", "seed", "duration", ...Array.from({ length: 9 }, (_, i) => `image_${i + 1}`), "filename_prefix",
  ...["ref_audio", "ref_video", "ref_video_audio"].flatMap((name) => [0, 1, 2].map((i) => `${name}_${i}`))];
const nodeData = { name: "H3SceneCapture", output_name: names, output: names.map(() => "*") };
class Node {
  constructor(id, type = "test") {
    this.id = id; this.type = type; this.mode = 0; this.properties = {}; this.size = [500, 300];
    this.inputs = []; this.outputs = []; this.widgets = [];
  }
  addOutput(name, type) { this.outputs.push({ name, type, links: [] }); }
  computeSize() { return [500, 600]; }
  setSize(size) { this.size = size; }
  disconnectInput(slot) {
    const id = this.inputs[slot].link;
    const link = this.graph.links[id];
    if (link) {
      const output = this.graph.getNodeById(link.origin_id).outputs[link.origin_slot];
      output.links = output.links.filter((item) => item !== id);
      delete this.graph.links[id];
    }
    this.inputs[slot].link = null;
  }
  connect(slot, target, input) {
    target.disconnectInput(input);
    const id = ++this.graph.lastLink;
    this.outputs[slot].links.push(id);
    target.inputs[input].link = id;
    this.graph.links[id] = { id, origin_id: this.id, origin_slot: slot, target_id: target.id, target_slot: input };
  }
}
await extension.beforeRegisterNodeDef(Node, nodeData);
function fixture() {
  const graph = {
    nodes: [], links: {}, lastLink: 0,
    getNodeById(id) { return this.nodes.find((node) => node.id === id); },
    beforeChange() {}, afterChange() {}, setDirtyCanvas() {},
  };
  function add(id, type, inputs = [], outputs = 1) {
    const n = new Node(id, type); n.graph = graph;
    n.inputs = inputs.map((name) => ({ name, link: null }));
    for (let i = 0; i < outputs; i++) n.addOutput(`out${i}`, "*");
    graph.nodes.push(n); return n;
  }
  const inputs = ["prompt", "noise_seed", "value_1", ...Array.from({ length: 9 }, (_, i) => `ref_images.ref_image_${i}`),
    ...["ref_audios.ref_audio", "ref_videos.ref_video", "ref_video_audios.ref_video_audio"].flatMap((name) => [0, 1, 2].map((i) => `${name}_${i}`))];
  const generator = add(817, "generator", inputs);
  const save = add(92, "SaveVideo", ["filename_prefix"]);
  const llm = add(822, "LLM", [], 2);
  llm.connect(1, generator, 0);
  add(841, "ttN seed").connect(0, generator, 1);
  for (let i = 0; i < 9; i++) add(600 + i, "LoadImage").connect(0, generator, 3 + i);
  add(802, "LoadAudio").connect(0, generator, 12);
  add(224, "PreviewAny"); add(805, "preview");
  const unrelated = add(825, "FolderBatch"); unrelated.mode = 4;
  const control = add(830, "H3SceneCapture", [], 0);
  control.widgets = [
    { name: "project_dir", value: "project" }, { name: "execution_mode", value: "シーン作成" },
    { name: "start_at", value: 0 }, { name: "auto_queue", value: true },
  ];
  control.onNodeCreated(); control.onConfigure();
  return { graph, add, generator, save, control };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const f = fixture();
await tick();
assert.equal(f.control.outputs.length, 22, "Old capture nodes gain the registered outputs");
const original = Object.values(f.graph.links).map((l) => [l.origin_id, l.origin_slot, l.target_id, l.target_slot]);
const count = f.graph.nodes.length;
for (let repeat = 0; repeat < 3; repeat++) {
  switchSceneMode(f.control, "batch");
  assert.equal(f.graph.nodes.length, count, "Switching must never create helper nodes");
  for (const input of f.generator.inputs) assert.equal(f.graph.links[input.link].origin_id, 830);
  assert.equal(f.graph.links[f.save.inputs[0].link].origin_id, 830);
  assert.equal(f.control.widgets[1].value, "バッチ生成");
  assert.equal(f.graph.getNodeById(822).mode, 4);
  switchSceneMode(f.control, "scene");
  assert.deepEqual(Object.values(f.graph.links).map((l) => [l.origin_id, l.origin_slot, l.target_id, l.target_slot]), original);
  assert.equal(f.graph.getNodeById(822).mode, 0);
  assert.equal(f.graph.getNodeById(825).mode, 4);
}
const audioSlot = f.generator.inputs.findIndex((item) => item.name === "ref_audios.ref_audio_1");
f.graph.getNodeById(802).connect(0, f.generator, audioSlot);
switchSceneMode(f.control, "batch");
f.control.properties = structuredClone(f.control.properties);
switchSceneMode(f.control, "scene");
assert.equal(f.graph.links[f.generator.inputs[audioSlot].link].origin_id, 802);
f.control.h3BatchQueue = { pending: { promptId: "running" } };
f.control.widgets[1].callback("バッチ生成");
assert.equal(notices.length, 1);
assert.equal(f.control.widgets[1].value, "シーン作成");

const migrated = fixture();
await tick();
switchSceneMode(migrated.control, "batch");
const loader = migrated.add(831, "H3SceneBatchLoad", [], 22);
loader.widgets = [{ name: "start_at", value: 5 }, { name: "auto_queue", value: false }];
for (const route of migrated.control.properties.scene_batch.routes) route.batch[0] = "831";
migrated.control.properties.scene_batch.node_modes.batch = { "831": 0 };
delete migrated.control.properties.h3_unified_controls;
migrated.control.outputs = [];
migrated.control.onConfigure();
await tick();
assert.equal(migrated.control.widgets[2].value, 5);
assert.equal(migrated.control.widgets[3].value, false);
assert.equal(loader.mode, 4);
assert.equal(migrated.control.outputs.length, 22);
for (const input of migrated.generator.inputs) assert.equal(migrated.graph.links[input.link].origin_id, 830);
console.log("PASS: one capture node switches and routes batch outputs, restores edited scene links, keeps helpers unchanged, and upgrades old controls without adding nodes.");

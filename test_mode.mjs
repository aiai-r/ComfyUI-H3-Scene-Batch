import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let extension;
globalThis.sceneModeTestApp = { registerExtension(value) { extension = value; }, ui: { dialog: { show(message) { throw new Error(message); } } } };
const source = readFileSync(new URL("web/mode.js", import.meta.url), "utf8")
  .replace('import { app } from "../../scripts/app.js";', "const app = globalThis.sceneModeTestApp;");
const { switchSceneMode } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const workflow = JSON.parse(readFileSync(new URL("../../user/default/workflows/video_minimax_h3_r2v_scene_batch.json", import.meta.url), "utf8"));

class Node {
  constructor(data, graph) { Object.assign(this, structuredClone(data)); this.graph = graph; this.widgets = []; }
  addWidget(type, name, value, callback, options) {
    const widget = { type, name, value, callback, options };
    this.widgets.push(widget);
    return widget;
  }
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
    this.outputs[slot].links ??= [];
    this.outputs[slot].links.push(id);
    target.inputs[input].link = id;
    this.graph.links[id] = { id, origin_id: this.id, origin_slot: slot, target_id: target.id, target_slot: input };
  }
}

const graph = {
  links: Object.fromEntries(workflow.links.map(([id, origin_id, origin_slot, target_id, target_slot]) => [id, { id, origin_id, origin_slot, target_id, target_slot }])),
  lastLink: workflow.last_link_id,
  getNodeById(id) { return this.nodes.find((node) => node.id === id); },
  beforeChange() {}, afterChange() {}, setDirtyCanvas() {},
};
graph.nodes = workflow.nodes.map((node) => new Node(node, graph));
const get = (id) => graph.getNodeById(id);
const control = get(830);
const inputSource = (id, name) => {
  const input = get(id).inputs.find((item) => item.name === name);
  const link = graph.links[input.link];
  return link ? [link.origin_id, link.origin_slot] : null;
};
const helpers = [825, 826, 827, 828].map((id) => [id, get(id).mode]);
const optional = [602, 603, 604, 605, 606, 607, 608, 802].map((id) => [id, get(id).mode]);
const settings = graph.nodes.map((node) => JSON.stringify([node.id, node.widgets_values, node.widgets_values_named]));
function checkLinks() {
  for (const link of Object.values(graph.links)) {
    assert.equal(get(link.target_id).inputs[link.target_slot].link, link.id);
    assert.ok(get(link.origin_id).outputs[link.origin_slot].links.includes(link.id));
  }
  for (const [id, mode] of helpers) assert.equal(get(id).mode, mode);
  assert.deepEqual(graph.nodes.map((node) => JSON.stringify([node.id, node.widgets_values, node.widgets_values_named])), settings);
}

await extension.beforeRegisterNodeDef(Node, { name: "H3SceneCapture" });
control.onConfigure();
assert.equal(control.widgets[0].value, "バッチ生成");
control.widgets[0].callback("シーン作成");
assert.equal(control.properties.scene_batch.mode, "scene");
assert.deepEqual(inputSource(817, "prompt"), [822, 1]);
assert.deepEqual(inputSource(817, "ref_audios.ref_audio_0"), [802, 0]);
assert.equal(inputSource(817, "ref_video_audios.ref_video_audio_0"), null);
assert.equal(inputSource(817, "noise_seed"), null);
assert.equal(inputSource(817, "value_1"), null);
assert.equal(inputSource(92, "filename_prefix"), null);
for (let i = 0; i < 9; i++) assert.deepEqual(inputSource(817, `ref_images.ref_image_${i}`), [600 + i, 0]);
for (const id of [822, 224, 805]) assert.equal(get(id).mode, 0);
for (let id = 831; id <= 840; id++) assert.equal(get(id).mode, 4);
for (const [id, mode] of optional) assert.equal(get(id).mode, mode);
checkLinks();

// A user edits a reference connection and enables audio in scene mode.
get(802).mode = 0;
const audioSlot = get(817).inputs.findIndex((input) => input.name === "ref_audios.ref_audio_1");
get(802).connect(0, get(817), audioSlot);
for (let repeat = 0; repeat < 3; repeat++) {
  switchSceneMode(control, "batch");
  assert.deepEqual(inputSource(817, "prompt"), [831, 0]);
  assert.deepEqual(inputSource(817, "ref_audios.ref_audio_1"), [831, 14]);
  assert.deepEqual(inputSource(817, "noise_seed"), [831, 1]);
  assert.deepEqual(inputSource(92, "filename_prefix"), [831, 12]);
  for (const id of [822, 224, 805]) assert.equal(get(id).mode, 4);
  for (let id = 831; id <= 840; id++) assert.equal(get(id).mode, 0);
  checkLinks();
  // Persisted properties survive JSON save/reload.
  control.properties = JSON.parse(JSON.stringify(control.properties));
  switchSceneMode(control, "scene");
  assert.deepEqual(inputSource(817, "ref_audios.ref_audio_1"), [802, 0]);
  assert.equal(get(802).mode, 0);
  checkLinks();
}
control.onConfigure();
assert.equal(control.widgets.length, 1);
assert.equal(control.widgets[0].value, "シーン作成");
const originalCapture = new Node({ id: 1, properties: {} }, graph);
originalCapture.onConfigure();
assert.equal(originalCapture.widgets.length, 0);
console.log("PASS: scene/batch routes, repeated toggles, saved properties, optional media states, untouched settings/helpers and widget reload");

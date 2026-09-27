import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let extension;
let queued = 0;
let failQueue = false;
const listeners = new Map();
const app = globalThis.batchApp = {
  graph: {},
  registerExtension(value) { extension = value; },
  async queuePrompt() {
    if (failQueue) throw new Error("queue rejected");
    queued += 1;
  },
};
const api = globalThis.batchApi = {
  addEventListener(event, callback) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(callback);
  },
  removeEventListener(event, callback) { listeners.get(event).delete(callback); },
  async fetchApi(url, options) {
    assert.equal(url, "/h3_scene_batch/manifest_info");
    assert.equal(JSON.parse(options.body).manifest_path, "project/scenes.json");
    return { ok: true, async json() { return { scene_count: 8 }; } };
  },
};
function emit(event, detail = {}) {
  for (const callback of listeners.get(event) ?? []) callback({ detail });
}
const source = readFileSync(new URL("web/batch_queue.js", import.meta.url), "utf8")
  .replace('import { app } from "../../scripts/app.js";', "const app = globalThis.batchApp;")
  .replace('import { api } from "../../scripts/api.js";', "const api = globalThis.batchApi;");
await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
class Node {
  id = 831;
  mode = 0;
  graph = app.graph;
  size = [500, 300];
  widgets = [
    { name: "manifest_path", value: "project/scenes.json" },
    { name: "image_root", value: "project/images" },
    { name: "start_at", value: 0 },
    { name: "auto_queue", value: true },
  ];
  addWidget(type, name, value, callback, options) {
    const widget = { type, name, value, callback, options };
    this.widgets.push(widget);
    return widget;
  }
  setDirtyCanvas() {}
  computeSize() { return [500, 350]; }
  setSize(size) { this.size = size; }
}
await extension.beforeRegisterNodeDef(Node, { name: "H3SceneBatchLoad" });
const node = new Node();
node.onNodeCreated();
const state = node.h3BatchQueue;
const tick = () => new Promise((resolve) => setTimeout(resolve, 230));
const loaded = (prompt, index, overrides = {}) => emit("executed", {
  node: "831", display_node: "831", prompt_id: prompt,
  output: { start_at: [index], scene_count: [8], scene_id: [`scene0${index + 1}`],
    manifest_path: ["project/scenes.json"], image_root: ["project/images"] }, ...overrides,
});
await new Promise((resolve) => setImmediate(resolve));
assert.equal(state.count.value, "8");
assert.equal(state.index.type, "hidden");
assert.equal(state.start.options.serialize, false);

state.start.callback(6);
assert.equal(state.index.value, 5);
loaded("sixth", 5);
await tick();
assert.equal(queued, 0, "Loading must not queue another generation");
assert.equal(state.index.value, 5);
assert.match(state.progress.value, /実行中：6 \/ 8（scene06）/);
emit("execution_success", { prompt_id: "unrelated" });
assert.equal(state.index.value, 5);
emit("execution_interrupted", { prompt_id: "sixth" });
await tick();
assert.equal(queued, 0);
assert.equal(state.index.value, 5, "Interrupted scene stays selected");
assert.match(state.progress.value, /未完了.*今回完了 0 件/);

loaded("retry-sixth", 5);
emit("execution_error", { prompt_id: "retry-sixth" });
assert.equal(state.index.value, 5);
loaded("successful-sixth", 5);
emit("execution_success", { prompt_id: "successful-sixth" });
emit("execution_success", { prompt_id: "successful-sixth" });
await tick();
assert.equal(queued, 1);
assert.equal(state.index.value, 6);
assert.equal(state.start.value, 7);
assert.equal(state.completed, 1);

state.auto.value = false;
loaded("seventh", 6);
emit("execution_success", { prompt_id: "seventh" });
await tick();
assert.equal(queued, 1);
assert.equal(state.start.value, 8);
state.auto.value = true;
loaded("last", 7);
emit("execution_success", { prompt_id: "last" });
await tick();
assert.equal(queued, 1);
assert.equal(state.index.value, 7, "Last scene must not reset to the first");
assert.match(state.progress.value, /最終シーン完了：8 \/ 8.*今回完了 3 件/);

state.start.callback(2);
loaded("edited", 1);
state.start.callback(6);
emit("execution_success", { prompt_id: "edited" });
await tick();
assert.equal(state.index.value, 5, "Keep an explicitly chosen restart position");
assert.equal(queued, 1);
loaded("mode-switched", 5);
node.mode = 4;
emit("execution_success", { prompt_id: "mode-switched" });
await tick();
assert.equal(queued, 1);
node.mode = 0;
loaded("root-changed", 5);
state.root.value = "different/images";
emit("execution_success", { prompt_id: "root-changed" });
await tick();
assert.equal(queued, 1);
state.root.value = "project/images";

loaded("disconnected", 5);
emit("reconnecting");
emit("execution_success", { prompt_id: "disconnected" });
await tick();
assert.equal(state.index.value, 5);
assert.equal(queued, 1);
assert.match(state.progress.value, /完了は未確認/);

loaded("submission-error", 5);
failQueue = true;
emit("execution_success", { prompt_id: "submission-error" });
await tick();
assert.equal(state.start.value, 7);
assert.match(state.progress.value, /キュー登録失敗/);
failQueue = false;
loaded("remove", 6);
emit("execution_success", { prompt_id: "remove" });
node.onRemoved();
await tick();
assert.equal(queued, 1);
assert.ok([...listeners.values()].every((callbacks) => callbacks.size === 0));

const restored = new Node();
restored.onNodeCreated();
restored.widgets.find((widget) => widget.name === "start_at").value = 5;
restored.onConfigure();
assert.equal(restored.h3BatchQueue.start.value, 6, "Saved zero-based index restores as one-based selection");
restored.onRemoved();
console.log("Batch count, progress, sixth-scene resume, failure, success, final scene, edits, mode, disconnect, and cleanup tests passed.");

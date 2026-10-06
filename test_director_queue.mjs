import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = (await readFile(new URL("./web/director_queue.js", import.meta.url), "utf8")).replace(/^import .*;\r?\n/gm, "").replaceAll("export ", "");
const calls = [];
let queued;
const api = { clientId: "test", fetchApi: async (path, options) => {
  const body = JSON.parse(options.body); calls.push({ path, body });
  if (path === "/prompt") return new Promise(resolve => { queued = () => resolve({ ok: true, json: async () => ({ prompt_id: body.prompt_id }) }); });
  return { ok: true, json: async () => ({}) };
} };
const template = { output: {
  "1200": { class_type: "H3SceneDirector", inputs: { plan_json: "old", scene_json: "old", width: ["size", 0], base_seed: ["seed", 0] } },
  "1211": { class_type: "H3SceneResult", inputs: { scene: ["1200", 2], video_path: ["assemble", 0] } },
  model: { class_type: "UNETLoader", inputs: { unet_name: "current-model", weight_dtype: "default" } },
  steps: { class_type: "PrimitiveInt", inputs: { value: 12 } },
}, workflow: { nodes: [{ id: 1200, widgets_values: ["old", "old", "old", false], properties: { keep: true } }] } };
const phases = [];
const app = { graphToPrompt: async () => structuredClone(template), rootGraph: { _nodes: [{ widgets: [{
  beforeQueued: () => phases.push("before"), afterQueued: () => phases.push("after"),
}] }] } };
const { sceneRequest, resultNode, DirectorQueue } = new Function("app", "api", "applyPromotedWidgetControl", source + "\nreturn {sceneRequest,resultNode,DirectorQueue};")(app, api, () => {});
const record = { plan: { shots: [{ prompt: "Garden", seed: "18446744073709551615", duration_seconds: 15 }, { prompt: "Pond", seed: "0", duration_seconds: 15 }] }, scene: { mode: "T2V", assets: [] } };
const before = structuredClone(template);
const graph = sceneRequest(template, 1200, record, { run_name: "unique-scene" }, true);
assert.deepEqual(template, before);
assert.deepEqual(graph.output.model, template.output.model);
assert.deepEqual(graph.output.steps, template.output.steps);
assert.equal(graph.output[1200].inputs.use_current_settings, true);
assert.deepEqual(JSON.parse(graph.output[1200].inputs.plan_json), record.plan);
assert.equal(graph.workflow.nodes[0].widgets_values[0], "unique-scene");
assert.equal(JSON.parse(graph.workflow.nodes[0].widgets_values[2]).mode, "T2V");
assert.equal(resultNode(template, 1200), "1211");
const queue = new DirectorQueue({ id: 1200, properties: {} }, () => {}, () => {});
const task = queue.generate(record);
while (!queued) await new Promise(resolve => setImmediate(resolve));
const promptId = calls.find(c => c.path === "/prompt").body.prompt_id;
await queue.stop();
queued();
await task;
assert.equal(queue.busy, false);
assert.ok(calls.filter(c => c.path === "/interrupt").length >= 2);
for (const call of calls.filter(c => c.path === "/interrupt")) assert.equal(call.body.prompt_id, promptId);
assert.ok(!calls.some(c => c.path.startsWith("/history")));
assert.deepEqual(phases, ["before", "after"], "An accepted prompt advances controls once even when cancelled during submission");
phases.length = 0;
api.fetchApi = async () => ({ ok: false, json: async () => ({ error: { message: "Rejected prompt" } }) });
await assert.rejects(queue.generate(record), /Rejected prompt/);
assert.deepEqual(phases, ["before"], "A rejected prompt must not advance after-queue controls");
assert.equal(queue.busy, false);
console.log("Director queue: saved inputs, current settings, workflow metadata and pending-registration cancellation passed.");

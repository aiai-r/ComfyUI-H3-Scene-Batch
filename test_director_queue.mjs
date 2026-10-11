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
const reactive = value => new Proxy(value, { get(target, key) {
  const item = target[key]; return item && typeof item === "object" ? reactive(item) : item;
} });
const app = { graphToPrompt: async () => reactive(template), rootGraph: { _nodes: [{ widgets: [{
  beforeQueued: () => phases.push("before"), afterQueued: () => phases.push("after"),
}] }] } };
const { sceneRequest, resultNode, DirectorQueue, batchProgress } = new Function("app", "api", "applyPromotedWidgetControl", "setTimeout", source + "\nreturn {sceneRequest,resultNode,DirectorQueue,batchProgress};")(app, api, () => {}, callback => callback());
const record = { plan: { shots: [{ prompt: "Garden", seed: "18446744073709551615", duration_seconds: 15 }, { prompt: "Pond", seed: "0", duration_seconds: 15 }] }, scene: { mode: "T2V", assets: [] } };
const before = structuredClone(template);
assert.throws(() => structuredClone(reactive(template)), { name: "DataCloneError" });
const graph = sceneRequest(reactive(template), 1200, record, { run_name: "unique-scene" }, true);
assert.deepEqual(template, before);
assert.deepEqual(graph.output.model, template.output.model);
assert.deepEqual(graph.output.steps, template.output.steps);
assert.equal(graph.output[1200].inputs.use_current_settings, true);
assert.deepEqual(JSON.parse(graph.output[1200].inputs.plan_json), record.plan);
assert.equal(graph.workflow.nodes[0].widgets_values[0], "unique-scene");
assert.equal(JSON.parse(graph.workflow.nodes[0].widgets_values[2]).mode, "T2V");
assert.equal(resultNode(template, 1200), "1211");
assert.doesNotThrow(() => structuredClone(graph));
const queue = new DirectorQueue({ id: 1200, properties: {} }, () => {}, () => {});
const task = queue.generate(record);
while (!queued) await new Promise(resolve => setImmediate(resolve));
const promptId = calls.find(c => c.path === "/prompt").body.prompt_id;
assert.deepEqual(JSON.parse(calls.find(c => c.path === "/prompt").body.prompt[1200].inputs.plan_json), record.plan);
assert.deepEqual(template, before, "Submitting a scene must not mutate the live workflow");
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

const messages = [], batchRequests = [], submissions = [];
let state, loadFails = false;
api.fetchApi = async (path, options) => {
  const body = JSON.parse(options.body);
  if (path === '/prompt') {
    submissions.push(body);
    state.completed.push({ id: state.ids[state.completed.length] });
    state.attempt = null; state.status = state.completed.length === state.ids.length ? 'complete' : 'ready';
    return { ok: true, json: async () => ({ prompt_id: body.prompt_id }) };
  }
  assert.equal(path, '/h3_scene_director/project'); batchRequests.push(body);
  if (body.action === 'start') {
    assert.equal(body.start_index, 12);
    state = { ids: ['scene12', 'scene13'], positions: [12, 13], total: 40, completed: [], status: 'ready' };
  } else if (body.action === 'next') {
    state.attempt = { prompt_id: `attempt${submissions.length}`, run_name: `run${submissions.length}`,
      output: { project: '/workspace/MyScenes', directory: `batches/test/scene_${submissions.length + 12}` } }; state.status = 'submitting';
  } else if (body.action === 'load') {
    return { ok: !loadFails, json: async () => loadFails ? { error: 'Missing asset' } : record };
  } else if (body.action === 'fail') { state.status = 'error'; state.error = body.error; state.attempt = null; }
  else if (body.action === 'resume') { state.status = 'ready'; state.error = ''; }
  return { ok: true, json: async () => ({ batch: structuredClone(state) }) };
};
const batchQueue = new DirectorQueue({ id: 1200, properties: {} }, message => messages.push(message), () => {});
await batchQueue.batch('/workspace/MyScenes', [], false, 12);
assert.equal(submissions.length, 2);
assert.ok(batchRequests.every(body => body.project === '/workspace/MyScenes'));
assert.ok(messages.some(text => text.includes('シーン 12/40')));
assert.ok(messages.some(text => text.includes('シーン 13/40')));
assert.match(messages.at(-1), /完了：シーン 13\/40 · 今回 2\/2/);
assert.equal(submissions[0].prompt[1200].inputs.use_current_settings, true);
assert.deepEqual(JSON.parse(submissions[0].prompt[1200].inputs.plan_json), record.plan);
assert.deepEqual(JSON.parse(submissions[0].prompt[1200].inputs.scene_json).output,
  { project: '/workspace/MyScenes', directory: 'batches/test/scene_12' });
assert.equal(JSON.parse(submissions[1].prompt[1200].inputs.scene_json).output.directory, 'batches/test/scene_13');
loadFails = true;
await assert.rejects(batchQueue.batch('/workspace/MyScenes', [], false, 12), /Missing asset/);
assert.equal(state.status, 'error'); assert.equal(state.attempt, null);
assert.equal(submissions.length, 2);
assert.match(messages.at(-1), /エラー位置：シーン 12\/40/);
loadFails = false;
await batchQueue.batch('/workspace/MyScenes', [], true);
assert.equal(submissions.length, 4);
assert.equal(state.status, 'complete');
assert.match(batchProgress({ ids: ['old'], completed: [], status: 'stopped' }), /停止位置：シーン 1\/1/);
console.log('Director batch: start index, current settings, project position, load failure persistence and resume passed.');

// Optional DOM check with mocked queue responses; never runs inference.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { draftGraph, readDraft, applyDraft, sceneAssets, imageAnalysisKey } from "./web/director_llm.js";

if (!process.env.H3_DOM_MODULE) {
  console.log("Director dialog check skipped: set H3_DOM_MODULE to linkedom/esm/index.js.");
  process.exit(0);
}
const { parseHTML } = await import(pathToFileURL(process.env.H3_DOM_MODULE));
const { document, window } = parseHTML("<html><body></body></html>");
const selectValue = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value");
Object.defineProperty(window.HTMLSelectElement.prototype, "value", { ...selectValue, set(value) {
  for (const option of this.options) option.selected = false;
  const selected = [...this.options].find(option => option.value === value);
  if (selected) selected.selected = true;
} });
window.HTMLTextAreaElement.prototype.reportValidity = () => true;
window.HTMLElement.prototype.showModal = function () { this.open = true; };
window.HTMLElement.prototype.close = function () { this.dispatchEvent(new window.Event("close")); };

const config = { loader: { model: "existing.gguf", mmproj: "vision.gguf" },
  story: { inputs: { seed: 42, cache_image_analysis: true }, parameters: { temperature: .7, max_tokens: 2048 } },
  prompt: { inputs: { seed: 43, cache_image_analysis: true }, parameters: { temperature: .6, max_tokens: 4096 } } };
const original = { shots: [{ id: "a", prompt: "Original A", seed: "18446744073709551615", duration_seconds: 15 },
  { id: "b", prompt: "", seed: "0", duration_seconds: 15 }] };
let plan = structuredClone(original), scene = { mode: "R2V", assets: [{ kind: "image", file: "one.png" }] };
let bytes = "original", failStage = null, pending;
const calls = [], histories = new Map();
const api = { clientId: "test", async fetchApi(path, options) {
  if (path.startsWith("/view?")) return { ok: true, arrayBuffer: async () => new TextEncoder().encode(bytes).buffer };
  if (path === "/prompt") {
    const graph = JSON.parse(options.body).prompt;
    const request = JSON.parse(graph.writer.inputs.custom_prompt);
    const stage = graph.images ? "analysis" : graph.writer.inputs.system_prompt.includes("Return a concise editable story") ? "story" : "prompt";
    calls.push({ stage, graph, request });
    const id = String(calls.length);
    const cuts = request.selected_cut == null ? plan.shots : [plan.shots[request.selected_cut - 1]];
    const text = stage === "analysis" ? "<Picture 1>: 人物と庭。" : stage === "story" ? `構成 ${request.selected_cut ?? "all"}`
      : JSON.stringify({ shots: cuts.map(c => ({ id: c.id, prompt: `New ${c.id}`, start_state: "Start", end_state: "End" })) });
    histories.set(id, stage === failStage ? { status: { status_str: "error", messages: [["execution_error", { exception_message: "LLM failed" }]] } }
      : { status: { completed: true }, outputs: { result: { text: [text] } } });
    if (pending) return new Promise(resolve => { pending.resolve = () => resolve({ ok: true, json: async () => ({ prompt_id: id }) }); });
    return { ok: true, json: async () => ({ prompt_id: id }) };
  }
  if (path.startsWith("/history/")) { const id = path.split("/").pop(); return { ok: true, json: async () => ({ [id]: histories.get(id) }) }; }
  assert.ok(["/queue", "/interrupt"].includes(path));
  return { ok: true, json: async () => ({}) };
} };
const source = (await readFile(new URL("./web/director_dialog.js", import.meta.url), "utf8")).replace(/^import .*;\r?\n/gm, "").replaceAll("export ", "");
const open = new Function("api", "document", "draftGraph", "readDraft", "applyDraft", "sceneAssets", "imageAnalysisKey", source + "\nreturn openDraftDialog;")(
  api, document, draftGraph, readDraft, applyDraft, sceneAssets, imageAnalysisKey);
const node = { properties: { h3_llm: structuredClone(config), h3_draft: { instruction: "庭を歩く", story: "元の構成", storyOn: false } }, graph: { change() {} } };
let dialog;
const launch = () => { open(node, () => plan, value => { plan = value; }, () => scene); dialog = document.querySelector("dialog"); };
const button = label => [...dialog.querySelectorAll("button")].find(b => b.textContent === label);
const field = label => [...dialog.querySelectorAll("label")].find(l => l.firstChild?.textContent === label)?.querySelector("textarea");
const status = () => dialog.querySelector('[role="status"]').textContent;
const stages = () => calls.map(c => c.stage);
const edit = (label, value) => { const input = field(label); assert.ok(input, label); input.value = value; input.oninput(); };
const select = value => { const input = dialog.querySelector("select"); input.value = value; input.onchange(); };
const clearCalls = () => { calls.length = 0; histories.clear(); };
const storyLabel = "対象のストーリー（編集可能・不要なら空欄）";
const instructionLabel = "日本語指示（選んだ対象の作成・修正）";
const analysisLabel = "画像解析結果（確認・編集できます）";
const applyLabel = "確認した草案をノードへ適用";

launch();
assert.equal(dialog.querySelector('input[type="checkbox"]'), null);
assert.equal(field(instructionLabel).value, "庭を歩く");
assert.equal(field(storyLabel).value, "元の構成", "Preserve existing manual story");
await button("画像解析を実行").onclick();
assert.deepEqual(stages(), ["analysis"]);
assert.deepEqual(plan, original);
assert.ok(button(applyLabel).disabled);
assert.equal(field(analysisLabel).value, "<Picture 1>: 人物と庭。");
edit(analysisLabel, "<Picture 1>: 編集した観察結果");

clearCalls();
await button("ストーリーだけ作成").onclick();
assert.deepEqual(stages(), ["story"]);
assert.equal(calls[0].request.image_analysis, "<Picture 1>: 編集した観察結果");
assert.equal(calls[0].graph.images, undefined);
assert.deepEqual(plan, original);
edit(storyLabel, "編集した全体構成");
clearCalls();
await button("Promptだけ作成").onclick();
assert.deepEqual(stages(), ["prompt"]);
assert.equal(calls[0].request.story, "編集した全体構成");
assert.deepEqual(plan, original, "Drafts require explicit apply");

select("1");
assert.ok(button(applyLabel).disabled, "Switching target discards unapplied drafts");
edit(instructionLabel, "振り返る");
clearCalls();
await button("ストーリー → Promptをまとめて作成").onclick();
assert.deepEqual(stages(), ["story", "prompt"]);
assert.ok(calls.every(c => c.request.selected_cut === 2));
assert.equal(calls[0].request.scene_story, "編集した全体構成");
assert.equal(calls[1].request.story, "構成 2");
assert.equal(dialog.querySelectorAll("fieldset fieldset").length, 1);
await button(applyLabel).onclick();
assert.deepEqual(plan.shots[0], original.shots[0]);
assert.deepEqual(plan.shots[1], { ...original.shots[1], prompt: "New b", start_state: "Start", end_state: "End" });
assert.equal(document.querySelector("dialog"), null);

launch();
assert.equal(field(storyLabel).value, "編集した全体構成");
select("1");
assert.equal(field(instructionLabel).value, "振り返る");
assert.equal(field(storyLabel).value, "構成 2");
edit(storyLabel, "");
clearCalls();
await button("Promptだけ作成").onclick();
assert.deepEqual(stages(), ["prompt"], "Reopened dialog reuses saved analysis");
assert.equal(calls[0].request.story, "");
assert.equal(calls[0].request.instruction, "振り返る");
bytes = "replacement at same filename";
clearCalls();
await button("Promptだけ作成").onclick();
assert.deepEqual(stages(), ["analysis", "prompt"]);
await button("閉じる").onclick();

const savedAnalysis = node.properties.h3_draft.analysis;
scene = { mode: "T2V", assets: [] };
launch();
assert.ok(button("画像解析を実行").disabled);
clearCalls();
await button("ストーリー → Promptをまとめて作成").onclick();
assert.deepEqual(stages(), ["story", "prompt"]);
assert.ok(calls.every(c => c.request.selected_cut === null && c.request.image_analysis === ""));
assert.equal(node.properties.h3_draft.analysis, savedAnalysis, "T2V does not erase observations for inactive image references");
assert.ok(button("画像解析を実行").disabled);
failStage = "story";
clearCalls();
await button("ストーリー → Promptをまとめて作成").onclick();
assert.deepEqual(stages(), ["story"]);
assert.equal(status(), "LLM failed");
assert.ok(button(applyLabel).disabled);
failStage = null;

clearCalls(); pending = {};
const running = button("ストーリー → Promptをまとめて作成").onclick();
while (!pending.resolve) await new Promise(resolve => setImmediate(resolve));
await button("中止").onclick();
pending.resolve(); pending = null;
await running;
assert.deepEqual(stages(), ["story"], "Cancel before queue registration prevents later stages");
assert.ok(button(applyLabel).disabled);
await button("閉じる").onclick();
console.log("Director LLM dialog: separate stages, all/single cut pipeline, reviewed apply, editable reuse, same-path image changes, T2V, failure and cancellation passed.");

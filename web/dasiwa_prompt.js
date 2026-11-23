import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { DirectorLLM, openLLMSettings } from "./director_dialog.js";
import { recordQueued, openRecords, runBatchFolder } from "./dasiwa_records.js";

// Writes Scene Director's LLM prompt into DaSiWa's MiniMaxH3 Director right before queueing.
const TYPE = "H3DaSiWaPrompt";
const MODES = { T2VA: "T2V", I2VA: "I2V", FL2VA: "FL2V", L2VA: "L2V", REF2VA: "R2V" };

const graphNodes = () => (app.rootGraph ?? app.graph)?._nodes ?? [];
const widget = (node, name) => node.widgets?.find(w => w.name === name);

// Director timeline items -> Scene Director scene, numbered the same way as the Director.
function sceneFromDirector(forge) {
  const mode = MODES[forge.mode()];
  if (!mode) throw new Error(`DirectorのモードはLLM作成に対応していません：${forge.mode()}`);
  const items = forge.items().filter(item => typeof item.value === "string" && item.value);
  const assets = [];
  if (mode === "R2V") {
    const lane = { image: [], video: [], audio: [] };
    for (const item of items) {
      if (item.type === "image") lane.image.push({ kind: "image", item });
      else if (item.type === "audio" || item.type === "video" && item.media_mode === "audio") lane.audio.push({ kind: "audio", item });
      else if (item.type === "video") lane.video.push({ kind: "video", item, use_audio: item.media_mode === "video_audio" });
    }
    for (const entries of Object.values(lane)) {
      entries.sort((a, b) => a.item.slot - b.item.slot);
      entries.forEach(({ kind, item, use_audio }, slot) => assets.push({ kind, role: "reference", slot, file: item.value, enabled: true, note: "", ...(kind === "video" ? { use_audio } : {}) }));
    }
  } else {
    const roles = { I2V: { 0: "first" }, FL2V: { 0: "first", 1: "last" }, L2V: { 1: "last" }, T2V: {} }[mode];
    for (const item of items.filter(i => i.type === "image" && roles[i.slot]).sort((a, b) => a.slot - b.slot)) {
      assets.push({ kind: "image", role: roles[item.slot], slot: item.slot, file: item.value, enabled: true, note: "" });
    }
  }
  return { mode, assets };
}

async function writePrompt(helper, notify) {
  const directors = graphNodes().filter(n => n.comfyClass === "MiniMaxH3Director" && n.mode === 0);
  if (directors.length !== 1) throw new Error("有効なMiniMaxH3 Directorを1つだけ置いてください。");
  const forge = directors[0].__dasiwaH3Forge;
  if (!forge) throw new Error("MiniMaxH3 Directorの画面が読み込まれていません。");
  const instruction = String(widget(helper, "instruction")?.value ?? "").trim();
  if (!instruction) throw new Error("日本語指示を入力してください。");
  const duration = forge.duration();
  if (!duration) throw new Error("Directorの秒数を取得できません。");
  const scene = sceneFromDirector(forge);
  const plan = { prompt_prefix: "", shots: [{ id: "cut1", prompt: "", duration_seconds: duration }] };
  const llm = new DirectorLLM(helper, notify);
  helper.h3Llm = llm;
  try {
    const drafts = await llm.create(plan, scene, null, { instruction, story: "", includePrevious: true, sceneStory: "" }, "prompt", () => {});
    const prompt = drafts?.[0]?.prompt;
    if (!prompt?.trim()) throw new Error("LLMのPromptが空です。");
    const applied = forge.apply({ mode: forge.mode(), continuity: false, fields: forge.mode() === "REF2VA" ? { ref: {} } : {}, simple_prompt: prompt });
    if (!applied) throw new Error("DirectorにPromptを書き込めませんでした（続きの生成中は使えません）。");
    return drafts.missing ?? [];
  } finally { helper.h3Llm = null; }
}

let busy = false;
// Writes the LLM prompt into the Director; returns the requested lines missing from it.
async function createPrompt(helper, notify) {
  if (busy) throw new Error("LLMでPrompt作成中です。終わるまでお待ちください。");
  busy = true;
  try {
    const missing = await writePrompt(helper, notify);
    notify(missing.length ? "Promptを書き込みました。指示のセリフがPromptに入っていません：" + missing.map(line => `「${line}」`).join(" ") : "Promptを書き込みました。", missing.length > 0);
    return missing;
  } finally { busy = false; }
}

function patchQueue() {
  if (api.__h3DaSiWaPromptPatched) return;
  const original = api.queuePrompt;
  api.queuePrompt = async function (number, data, ...rest) {
    const helpers = graphNodes().filter(n => n.type === TYPE && n.mode === 0);
    if (!helpers.length) return original.apply(this, [number, data, ...rest]);
    const helper = helpers[0];
    const notify = (text, failed = false) => helper.h3Status?.(text, failed);
    if (helpers.length > 1) { notify("H3 DaSiWa Promptは1つだけにしてください。", true); throw new Error("H3 DaSiWa Promptは1つだけにしてください。"); }
    if (widget(helper, "enabled")?.value) {
      try { await createPrompt(helper, notify); }
      catch (error) { notify(error.message, true); throw error; }
      // Rebuild so the queued body carries the prompt just written into the Director.
      data = await app.graphToPrompt();
    }
    const queued = await original.apply(this, [number, data, ...rest]);
    try { await recordQueued(helper, data, queued); }
    catch (error) { notify(`生成は開始しましたが、記録していません：${error.message}`, true); }
    return queued;
  };
  api.__h3DaSiWaPromptPatched = true;
}

function attach(node) {
  const enabled = widget(node, "enabled"), instruction = widget(node, "instruction");
  if (enabled) enabled.label = "実行時にPrompt作成→生成";
  if (instruction) { instruction.label = "日本語指示"; if (instruction.inputEl) instruction.inputEl.placeholder = "例：画像1の女性が手を振り、音声1の声で「こんにちは」と話す。BGMなし。"; }
  const status = document.createElement("p");
  status.style.cssText = "margin:4px;font-size:12px;white-space:pre-wrap;color:var(--descrip-text,#999)";
  const folder = widget(node, "batch_folder");
  if (folder) folder.label = "バッチ用フォルダ";
  const recordName = widget(node, "record_name");
  if (recordName) recordName.label = "記録名";
  node.addWidget("button", "Prompt作成のみ", null, () => createPrompt(node, (text, failed) => node.h3Status(text, failed))
    .catch(error => node.h3Status(error.message, true))).serialize = false;
  node.addWidget("button", "LLM設定", null, () => { try { openLLMSettings(node); } catch (error) { node.h3Status(error.message, true); } }).serialize = false;
  node.addWidget("button", "記録一覧・書き出し", null, () => openRecords(node).catch(error => node.h3Status(error.message, true))).serialize = false;
  node.addWidget("button", "このフォルダを一括実行", null, () => runBatchFolder(folder?.value ?? "", (text, failed) => node.h3Status(text, failed))
    .catch(error => node.h3Status(error.message, true))).serialize = false;
  node.addDOMWidget("h3_status", "custom", status, { serialize: false, hideOnZoom: false, getMinHeight: () => 40 });
  node.h3Status = (text, failed) => { status.textContent = text; status.style.color = failed ? "#f66" : "var(--descrip-text,#999)"; };
  const removed = node.onRemoved;
  node.onRemoved = function () { node.h3Llm?.stop().catch(console.error); return removed?.apply(this, arguments); };
}

app.registerExtension({
  name: "H3SceneBatch.DaSiWaPrompt",
  setup() { patchQueue(); },
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== TYPE) return;
    const created = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () { const result = created?.apply(this, arguments); attach(this); return result; };
  },
});

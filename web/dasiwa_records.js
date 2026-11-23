import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// Records every generation queued with H3 DaSiWa Prompt, exports checked ones to a batch folder
// and replays a batch folder with the current workflow settings.
const DIRECTOR_KEYS = ["mode", "prompt", "duration", "ref_image_size", "timeline_data", "builder_state"];
const LORA_FILE = /\.(safetensors|pt|pth|ckpt|bin)$/i;
const randomHex = bytes => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), b => b.toString(16).padStart(2, "0")).join("");

async function request(body) {
  const response = await api.fetchApi("/h3_dasiwa/records", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "記録の処理に失敗しました。");
  return data;
}

function listId(helper) {
  if (!helper.properties.h3_record_list) { helper.properties.h3_record_list = `rec_${randomHex(8)}`; helper.graph?.change(); }
  return helper.properties.h3_record_list;
}

function directorEntry(output) {
  const entries = Object.entries(output).filter(([, n]) => n.class_type === "MiniMaxH3Director");
  if (entries.length !== 1) throw new Error("MiniMaxH3 Directorが1つではありません。");
  return entries[0];
}

function sourceOf(timeline) {
  const c = JSON.parse(timeline || "{}").continuity ?? {};
  if (c.source_kind === "video" && c.source_video_id) return { kind: "video" };
  if (c.source_kind !== "video" && c.source_id) return { kind: "clip", clip_id: c.source_id };
  return { kind: "new" };
}

const plainInputs = inputs => Object.fromEntries(Object.entries(inputs).filter(([, v]) => !Array.isArray(v)));

// Results arrive as events: the video from the exporter, the checkpoint ID from DaSiWa's publish.
const pending = new Map();
let running = null;
const savedBySession = new Map();
api.addEventListener("execution_start", ({ detail }) => { running = detail?.prompt_id ?? null; });
api.addEventListener("df_h3_continuity_saved", ({ detail }) => {
  savedBySession.set(detail.session, detail.clip_id);
  const list = pending.get(running);
  if (list) request({ action: "update", list, id: running, patch: { clip_id: detail.clip_id } }).catch(console.error);
});
api.addEventListener("executed", ({ detail }) => {
  const list = pending.get(detail?.prompt_id), video = detail?.output?.gifs?.[0];
  if (list && video) request({ action: "update", list, id: detail.prompt_id, patch: { video } }).catch(console.error);
});
for (const name of ["execution_success", "execution_error", "execution_interrupted"]) {
  api.addEventListener(name, ({ detail }) => { if (detail?.prompt_id) setTimeout(() => pending.delete(detail.prompt_id), 5000); });
}

export async function recordQueued(helper, data, queued) {
  if (!queued?.prompt_id) return;
  const [, director] = directorEntry(data.output);
  const picked = Object.fromEntries(DIRECTOR_KEYS.filter(k => k in director.inputs && !Array.isArray(director.inputs[k])).map(k => [k, director.inputs[k]]));
  const seeds = Object.fromEntries(Object.entries(data.output).filter(([, n]) => n.class_type === "DaSiWa_SeedControl" && typeof n.inputs.seed_value === "number").map(([id, n]) => [id, n.inputs.seed_value]));
  const loras = Object.fromEntries(Object.entries(data.output).filter(([, n]) => /lora/i.test(n.class_type)).map(([id, n]) => [id, { class_type: n.class_type, inputs: plainInputs(n.inputs) }]));
  const list = listId(helper);
  pending.set(queued.prompt_id, list);
  await request({ action: "add", list, record: { id: queued.prompt_id, created: Date.now(), director: picked, seeds, loras, source: sourceOf(picked.timeline_data) } });
}

function promptText(record) {
  const timeline = JSON.parse(record.director.timeline_data || "{}");
  if (record.source.kind !== "new") return timeline.continuity?.continuation_prompt ?? "";
  const builder = JSON.parse(record.director.builder_state || "{}");
  return builder.simple_prompt || record.director.prompt || "";
}

// LoRA names are matched by file name, ignoring folders, against this server's LoRA list.
async function loraResolver() {
  const response = await api.fetchApi("/object_info/LoraLoaderModelOnly");
  if (!response.ok) throw new Error("LoRA一覧を取得できません。");
  const spec = (await response.json()).LoraLoaderModelOnly?.input?.required?.lora_name;
  const names = Array.isArray(spec?.[0]) ? spec[0] : spec?.[1]?.options ?? [];
  const base = name => name.replaceAll("\\", "/").split("/").pop().toLowerCase();
  const byBase = new Map(names.map(name => [base(name), name]));
  return name => {
    if (typeof name !== "string" || !LORA_FILE.test(name)) return name;
    const found = byBase.get(base(name));
    if (!found) throw new Error(`LoRAが見つかりません：${name.replaceAll("\\", "/").split("/").pop()}`);
    return found;
  };
}

function applyLoras(output, loras, resolve) {
  for (const [id, saved] of Object.entries(loras ?? {})) {
    const node = output[id];
    if (!node || node.class_type !== saved.class_type) throw new Error(`記録時のLoRAノード（${saved.class_type}）が今のワークフローにありません。`);
    for (const [key, value] of Object.entries(saved.inputs)) {
      let replaced = resolve(value);
      if (typeof value === "string" && value.trim().startsWith("[")) {
        try {
          const slots = JSON.parse(value);
          if (Array.isArray(slots)) replaced = JSON.stringify(slots.map(slot => slot && typeof slot.lora === "string" ? { ...slot, lora: resolve(slot.lora) } : slot));
        } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
      }
      node.inputs[key] = replaced;
    }
  }
}

async function waitDone(promptId) {
  while (true) {
    const response = await api.fetchApi(`/history/${encodeURIComponent(promptId)}`);
    if (!response.ok) throw new Error("実行履歴を取得できません。");
    const history = (await response.json())[promptId];
    if (history?.status?.status_str === "error") {
      const failure = history.status.messages?.find(([name]) => name === "execution_error")?.[1];
      throw new Error(failure?.exception_message ?? "生成が失敗または中止されました。");
    }
    if (history?.status?.completed) return;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}

let batchBusy = false;
export async function runBatchFolder(folder, notify) {
  if (batchBusy) throw new Error("バッチ生成中です。");
  batchBusy = true;
  try {
    notify("バッチ用フォルダを読み込み中…");
    const records = await request({ action: "load_batch", folder });
    const resolve = await loraResolver();
    const session = `h3_${randomHex(16)}`;
    const made = [];
    for (const [index, record] of records.entries()) {
      notify(`バッチ ${index + 1}/${records.length}（記録 #${record.number}）を生成中…`);
      const template = await app.graphToPrompt();
      const output = structuredClone(template.output);
      const [, director] = directorEntry(output);
      const current = JSON.parse(director.inputs.timeline_data || "{}");
      const timeline = JSON.parse(record.director.timeline_data || "{}");
      timeline.resolution = current.resolution;
      const c = timeline.continuity ??= {};
      Object.assign(c, { session, capture: true });
      if (record.source.kind === "new") Object.assign(c, { operation: "new", source_kind: "checkpoint", source_id: "", source_video_id: "", source_video: null });
      if (record.source.kind === "clip") Object.assign(c, { operation: "continue", source_kind: "checkpoint", source_id: made[record.source.from] });
      if (record.source.kind === "video") {
        const response = await api.fetchApi("/df_h3_continuity/video", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: c.source_video.filename }) });
        const video = await response.json();
        if (!response.ok) throw new Error(`開始動画を登録できません：${video.error ?? ""}`);
        Object.assign(c, { operation: "continue", source_kind: "video", source_video_id: video.clip_id, source_video: video, source_id: "" });
      }
      Object.assign(director.inputs, record.director, { timeline_data: JSON.stringify(timeline) });
      for (const [id, seed] of Object.entries(record.seeds)) if (output[id]?.class_type === "DaSiWa_SeedControl") output[id].inputs.seed_value = seed;
      applyLoras(output, record.loras, resolve);
      savedBySession.delete(session);
      const response = await api.fetchApi("/prompt", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: output, client_id: api.clientId, extra_data: { extra_pnginfo: { workflow: template.workflow } } }) });
      const queued = await response.json();
      if (!response.ok) throw new Error(`キュー登録失敗: ${JSON.stringify(queued.node_errors ?? queued.error ?? queued)}`);
      await waitDone(queued.prompt_id);
      const saved = savedBySession.get(session);
      if (!saved) throw new Error(`記録 #${record.number} の保存データが作られませんでした。`);
      made.push(saved);
    }
    notify(`バッチ完了：${records.length}本を生成しました。`);
  } finally { batchBusy = false; }
}

export async function openRecords(helper) {
  const records = helper.properties.h3_record_list ? await request({ action: "list", list: helper.properties.h3_record_list }) : [];
  const dialog = document.createElement("dialog");
  dialog.style.cssText = "width:min(1100px,94vw);max-height:88vh;overflow:auto;background:var(--comfy-menu-bg,#222);color:var(--fg-color,#ddd);padding:16px";
  const title = document.createElement("h3"); title.textContent = "生成の記録"; dialog.append(title);
  const status = document.createElement("p"); status.style.cssText = "white-space:pre-wrap";
  const notify = (text, failed = false) => { status.textContent = text; status.style.color = failed ? "#f66" : ""; };
  const checks = [];
  if (!records.length) dialog.append("記録はまだありません。");
  records.forEach((record, index) => {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:12px;align-items:flex-start;padding:8px 0;border-bottom:1px solid #444";
    const check = document.createElement("input"); check.type = "checkbox"; checks.push(check);
    const info = document.createElement("div"); info.style.cssText = "flex:1;min-width:0";
    const origin = record.source.kind === "clip" ? records.findIndex(r => r.clip_id && r.clip_id === record.source.clip_id) : -1;
    const source = { new: "新規", video: "読み込んだ動画の続き", clip: origin >= 0 ? `#${origin + 1} の続き` : "記録外の動画の続き" }[record.source.kind];
    const head = document.createElement("strong");
    head.textContent = `#${index + 1}　${new Date(record.created).toLocaleString()}　${record.director.mode} ${record.director.duration}秒　${source}`;
    const text = document.createElement("p"); const prompt = promptText(record);
    text.textContent = prompt.length > 200 ? prompt.slice(0, 200) + "…" : prompt; text.title = prompt;
    text.style.cssText = "margin:4px 0;font-size:12px;opacity:.8;white-space:pre-wrap";
    info.append(head, text);
    row.append(check);
    if (record.video) {
      const video = document.createElement("video"); video.controls = true; video.preload = "metadata"; video.style.cssText = "width:280px;max-height:200px";
      video.src = api.apiURL(`/view?${new URLSearchParams({ filename: record.video.filename, subfolder: record.video.subfolder ?? "", type: record.video.type ?? "output" })}`);
      row.append(video);
    }
    row.append(info);
    dialog.append(row);
  });
  const buttons = document.createElement("div"); buttons.style.cssText = "display:flex;gap:8px;margin-top:12px;align-items:center";
  const folder = document.createElement("input"); folder.placeholder = "書き出し先（フォルダ名または絶対パス）"; folder.style.cssText = "flex:1";
  const exportButton = document.createElement("button"); exportButton.textContent = "チェックした回をバッチ用フォルダに書き出す";
  const close = document.createElement("button"); close.textContent = "閉じる";
  exportButton.onclick = async () => {
    try {
      const ids = records.filter((_, index) => checks[index].checked).map(r => r.id);
      const result = await request({ action: "export", list: helper.properties.h3_record_list, ids, folder: folder.value });
      notify(`${result.count}件を書き出しました：${result.folder}`);
    } catch (error) { notify(error.message, true); }
  };
  close.onclick = () => { dialog.close(); dialog.remove(); };
  buttons.append(folder, exportButton, close); dialog.append(buttons, status);
  document.body.append(dialog); dialog.showModal();
}

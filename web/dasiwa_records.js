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
  const name = String(helper.widgets?.find(w => w.name === "record_name")?.value ?? "").trim();
  if (!name) throw new Error("記録名が空です。");
  return name;
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
  const list = listId(helper);
  const [, director] = directorEntry(data.output);
  const picked = Object.fromEntries(DIRECTOR_KEYS.filter(k => k in director.inputs && !Array.isArray(director.inputs[k])).map(k => [k, director.inputs[k]]));
  const seeds = Object.fromEntries(Object.entries(data.output).filter(([, n]) => n.class_type === "DaSiWa_SeedControl" && typeof n.inputs.seed_value === "number").map(([id, n]) => [id, n.inputs.seed_value]));
  const loras = Object.fromEntries(Object.entries(data.output).filter(([, n]) => /lora/i.test(n.class_type)).map(([id, n]) => [id, { class_type: n.class_type, inputs: plainInputs(n.inputs) }]));
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

// One record -> the prompt body to queue, built on the current workflow (steps, resolution, models).
function buildOutput(template, record, { session, made, list, index, resolve }) {
  const output = structuredClone(template.output);
  const [, director] = directorEntry(output);
  const current = JSON.parse(director.inputs.timeline_data || "{}");
  const timeline = JSON.parse(record.director.timeline_data || "{}");
  timeline.resolution = current.resolution;
  const c = timeline.continuity ??= {};
  Object.assign(c, { session, capture: true });
  if (record.source.kind === "new") Object.assign(c, { operation: "new", source_kind: "checkpoint", source_id: "", source_video_id: "", source_video: null });
  if (record.source.kind === "clip") Object.assign(c, { operation: "continue", source_kind: "checkpoint", source_id: made[record.source.from] ?? "" });
  Object.assign(director.inputs, record.director, { timeline_data: JSON.stringify(timeline) });
  for (const [id, seed] of Object.entries(record.seeds)) if (output[id]?.class_type === "DaSiWa_SeedControl") output[id].inputs.seed_value = seed;
  applyLoras(output, record.loras, resolve);
  // Batch videos go to the record folder, named in the order they are made.
  const prefix = `h3_dasiwa_records/${list}/batch_outputs/${list}_batch_${String(index + 1).padStart(4, "0")}`;
  for (const node of Object.values(output)) if (node.class_type === "DaSiWa_EnhancedVideoCombine") node.inputs.filename_prefix = prefix;
  return { output, director, timeline };
}

const MODEL_FILE = /\.(safetensors|sft|ckpt|pt|pth|bin|gguf|onnx)$/i;
const comboOptions = spec => Array.isArray(spec?.[0]) ? spec[0] : Array.isArray(spec?.[1]?.options) ? spec[1].options : null;

// Everything that would stop the batch partway, found before generating anything.
async function preflight(template, records, context, progress) {
  const problems = new Set();
  const response = await api.fetchApi("/object_info");
  if (!response.ok) throw new Error("ノード情報を取得できません。");
  const info = await response.json();
  const resolve = name => { try { return context.resolve(name); } catch (error) { problems.add(error.message); return name; } };
  for (const [index, record] of records.entries()) {
    let built;
    try { built = buildOutput(template, record, { ...context, index, resolve }); }
    catch (error) { problems.add(`#${record.number}：${error.message}`); continue; }
    for (const node of Object.values(built.output)) {
      const spec = info[node.class_type];
      if (!spec) { problems.add(`ノードが入っていません：${node.class_type}`); continue; }
      for (const [key, value] of Object.entries(node.inputs)) {
        if (typeof value !== "string" || !MODEL_FILE.test(value)) continue;
        const options = comboOptions(spec.input?.required?.[key] ?? spec.input?.optional?.[key]);
        if (options && !options.includes(value)) problems.add(`モデルが見つかりません：${value}（${node.class_type}）`);
      }
    }
  }
  if (progress?.made?.length) {
    const missing = await request({ action: "missing_clips", session: progress.session, clips: progress.made });
    if (missing.length) problems.add(`再開に使う、生成済みの回の保存データが見つかりません（${missing.length}件）。`);
  }
  if (problems.size) throw new Error(`バッチを始められません。次を直してください：\n・${[...problems].join("\n・")}`);
}

let batchBusy = false;
export async function runBatchFolder(folder, notify, list = "") {
  if (batchBusy) throw new Error("バッチ生成中です。");
  if (!list) throw new Error("記録名を入力してください。バッチの動画の保存名に使います。");
  batchBusy = true;
  try {
    notify("バッチ用フォルダを読み込み中…");
    const records = await request({ action: "load_batch", folder, list });
    const resolve = await loraResolver();
    // Resume after the clips a stopped run already made, continuing from their saved data.
    const progress = await request({ action: "progress", folder, list });
    const session = progress?.session ?? `h3_${randomHex(16)}`;
    const made = progress?.made ?? [];
    if (made.length >= records.length) { notify(`このバッチは${records.length}本すべて生成済みです。`); return; }
    notify("バッチを実行できる状態か確認中…");
    await preflight(await app.graphToPrompt(), records, { session, made, list, resolve }, progress);
    if (made.length) notify(`${made.length}本目まで生成済みです。${made.length + 1}本目から再開します。`);
    for (const [index, record] of records.entries()) {
      if (index < made.length) continue;
      notify(`バッチ ${index + 1}/${records.length}（記録 #${record.number}）を生成中…`);
      const template = await app.graphToPrompt();
      const { output, director, timeline } = buildOutput(template, record, { session, made, list, index, resolve });
      if (record.source.kind === "video") {
        const c = timeline.continuity;
        const response = await api.fetchApi("/df_h3_continuity/video", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: c.source_video.filename }) });
        const video = await response.json();
        if (!response.ok) throw new Error(`開始動画を登録できません：${video.error ?? ""}`);
        Object.assign(c, { operation: "continue", source_kind: "video", source_video_id: video.clip_id, source_video: video, source_id: "" });
        director.inputs.timeline_data = JSON.stringify(timeline);
      }
      savedBySession.delete(session);
      const response = await api.fetchApi("/prompt", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: output, client_id: api.clientId, extra_data: { extra_pnginfo: { workflow: template.workflow } } }) });
      const queued = await response.json();
      if (!response.ok) throw new Error(`キュー登録失敗: ${JSON.stringify(queued.node_errors ?? queued.error ?? queued)}`);
      await waitDone(queued.prompt_id);
      // The websocket notice can be missed; the saved data on disk is the fallback.
      let saved = savedBySession.get(session);
      if (!saved) {
        const latest = await request({ action: "latest_clip", session });
        if (latest && !made.includes(latest)) saved = latest;
      }
      if (!saved) throw new Error(`記録 #${record.number} の保存データが作られませんでした。`);
      made.push(saved);
      await request({ action: "save_progress", folder, list, progress: { session, made } });
    }
    notify(`バッチ完了：${records.length}本を生成しました。`);
  } finally { batchBusy = false; }
}

export async function openRecords(helper) {
  const list = listId(helper);
  let records = await request({ action: "list", list });
  let tab = "active";
  const dialog = document.createElement("dialog");
  dialog.style.cssText = "width:min(1100px,94vw);max-height:88vh;overflow:auto;background:var(--comfy-menu-bg,#222);color:var(--fg-color,#ddd);padding:16px";
  const title = document.createElement("h3"); title.textContent = `生成の記録：${list}`;
  const tabs = document.createElement("div"); tabs.style.cssText = "display:flex;gap:8px;margin-bottom:8px";
  const activeTab = document.createElement("button"), excludedTab = document.createElement("button");
  tabs.append(activeTab, excludedTab);
  const rows = document.createElement("div");
  const status = document.createElement("p"); status.style.cssText = "white-space:pre-wrap";
  const notify = (text, failed = false) => { status.textContent = text; status.style.color = failed ? "#f66" : ""; };
  const checked = new Set();
  const number = record => `#${records.indexOf(record) + 1}`;
  // The records this one continues from, nearest first.
  const ancestors = record => {
    const chain = [];
    for (let current = record; current.source.kind === "clip";) {
      current = records.find(r => r.clip_id && r.clip_id === current.source.clip_id);
      if (!current || chain.includes(current)) break;
      chain.push(current);
    }
    return chain;
  };
  // The records continued from this one, directly or further down the chain.
  const dependents = record => records.filter(r => ancestors(r).includes(record));
  const setExcluded = async (record, excluded) => {
    try {
      let targets = [record];
      if (excluded) {
        const kept = dependents(record).filter(r => !r.excluded);
        if (kept.length) {
          const names = kept.map(number).join("・");
          if (!confirm(`${names} は ${number(record)} の続きです。${number(record)} を除外すると ${names} も書き出せなくなります。
${names} も一緒に除外しますか？（キャンセルで取りやめ）`)) return;
          targets = [record, ...kept];
        }
      } else {
        targets = [record, ...ancestors(record).filter(r => r.excluded)];
      }
      for (const target of targets) {
        records = await request({ action: "update", list, id: target.id, patch: { excluded } });
        checked.delete(target.id);
      }
      render();
    } catch (error) { notify(error.message, true); }
  };
  function render() {
    const excludedCount = records.filter(r => r.excluded).length;
    activeTab.textContent = `記録（${records.length - excludedCount}）`; excludedTab.textContent = `除外済み（${excludedCount}）`;
    activeTab.disabled = tab === "active"; excludedTab.disabled = tab === "excluded";
    exportArea.hidden = tab !== "active";
    rows.replaceChildren();
    const shown = records.filter(r => Boolean(r.excluded) === (tab === "excluded"));
    if (!shown.length) rows.append(tab === "active" ? "記録はありません。" : "除外した記録はありません。");
    for (const record of shown) {
      const index = records.indexOf(record);
      const row = document.createElement("div");
      row.style.cssText = "display:flex;gap:12px;align-items:flex-start;padding:8px 0;border-bottom:1px solid #444";
      if (tab === "active") {
        const check = document.createElement("input"); check.type = "checkbox"; check.checked = checked.has(record.id);
        check.onchange = () => {
          if (!check.checked) { checked.delete(record.id); return; }
          // A continuation needs the records it continues from.
          for (const r of [record, ...ancestors(record)]) checked.add(r.id);
          render();
        };
        row.append(check);
      }
      if (record.preview || record.video) {
        const video = document.createElement("video"); video.controls = true; video.preload = "metadata"; video.style.cssText = "width:280px;max-height:200px";
        video.src = record.preview
          ? api.apiURL(`/h3_dasiwa/preview?${new URLSearchParams({ list, file: record.preview })}`)
          : api.apiURL(`/view?${new URLSearchParams({ filename: record.video.filename, subfolder: record.video.subfolder ?? "", type: record.video.type ?? "output" })}`);
        row.append(video);
      }
      const info = document.createElement("div"); info.style.cssText = "flex:1;min-width:0";
      const origin = record.source.kind === "clip" ? records.findIndex(r => r.clip_id && r.clip_id === record.source.clip_id) : -1;
      const source = { new: "新規", video: "読み込んだ動画の続き", clip: origin >= 0 ? `#${origin + 1} の続き` : "記録外の動画の続き" }[record.source.kind];
      const head = document.createElement("strong");
      head.textContent = `#${index + 1}　${new Date(record.created).toLocaleString()}　${record.director.mode} ${record.director.duration}秒　${source}`;
      const text = document.createElement("p"); const prompt = promptText(record);
      text.textContent = prompt.length > 200 ? prompt.slice(0, 200) + "…" : prompt; text.title = prompt;
      text.style.cssText = "margin:4px 0;font-size:12px;opacity:.8;white-space:pre-wrap";
      info.append(head, text);
      const toggle = document.createElement("button"); toggle.textContent = tab === "active" ? "除外" : "戻す";
      toggle.onclick = () => setExcluded(record, tab === "active");
      row.append(info, toggle);
      rows.append(row);
    }
  }
  activeTab.onclick = () => { tab = "active"; render(); };
  excludedTab.onclick = () => { tab = "excluded"; render(); };
  const exportArea = document.createElement("div"); exportArea.style.cssText = "display:flex;gap:8px;margin-top:12px;align-items:center";
  const folder = document.createElement("input"); folder.placeholder = "書き出し先（フォルダ名または絶対パス）"; folder.style.cssText = "flex:1";
  // Default: the record name and the current time, so each export gets a new folder.
  const defaultFolder = () => { const t = new Date(), p = n => String(n).padStart(2, "0"); return `${list}_${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}_${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}`; };
  folder.value = defaultFolder();
  const exportIds = async ids => {
    try {
      const result = await request({ action: "export", list, ids, folder: folder.value });
      notify(`${result.count}件を書き出しました：${result.folder}`);
      folder.value = defaultFolder();
    } catch (error) { notify(error.message, true); }
  };
  const exportChecked = document.createElement("button"); exportChecked.textContent = "チェックした回を書き出す";
  exportChecked.onclick = () => exportIds(records.filter(r => !r.excluded && checked.has(r.id)).map(r => r.id));
  const exportAll = document.createElement("button"); exportAll.textContent = "記録の全てを書き出す";
  exportAll.onclick = () => exportIds(records.filter(r => !r.excluded).map(r => r.id));
  exportArea.append(folder, exportChecked, exportAll);
  const close = document.createElement("button"); close.textContent = "閉じる"; close.style.marginTop = "8px";
  close.onclick = () => { dialog.close(); dialog.remove(); };
  dialog.append(title, tabs, rows, exportArea, close, status);
  render();
  document.body.append(dialog); dialog.showModal();
}

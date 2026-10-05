import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { readPlan, updateCut } from "./director_plan.js";
import { sceneAssets, referenceDescriptions } from "./director_llm.js";
import { openDraftDialog } from "./director_dialog.js";
import { DirectorQueue, projectRequest } from "./director_queue.js";

const stylesheet = document.createElement("link");
stylesheet.rel = "stylesheet"; stylesheet.href = new URL("./director.css", import.meta.url).href; document.head.append(stylesheet);

function viewUrl(file) {
  if (typeof file === "object") return api.apiURL(`/view?${new URLSearchParams(file)}`);
  const type = file.endsWith(" [output]") ? "output" : "input";
  const path = file.replaceAll("\\", "/").replace(/ \[(input|output)\]$/, "");
  const split = path.lastIndexOf("/");
  return viewUrl({ filename: path.slice(split + 1), subfolder: path.slice(0, Math.max(0, split)), type });
}

function attachDirector(node) {
  const widgets = Object.fromEntries(node.widgets.map(w => [w.name, w]));
  for (const name of ["plan_json", "scene_json", "run_name", "use_current_settings"]) {
    const w = widgets[name]; if (!w) continue;
    w.hidden = true; w.options = { ...w.options, hidden: true }; w.computeSize = () => [0, -4];
    if (w.element) w.element.hidden = true;
  }
  const root = document.createElement("div"); root.className = "h3-director";
  const top = element(root, "div", "row");
  const project = input(top, "プロジェクト", node.properties.h3_project ?? "MyScenes");
  project.onchange = () => { node.properties.h3_project = project.value; changed(); };
  const tabs = element(root, "div", "tabs section");
  const createTab = button(tabs, "作成", () => switchTab(false));
  const libraryTab = button(tabs, "保存済み・一括生成", () => { switchTab(true); return refreshLibrary(); });
  const create = element(root, "div");
  const library = element(root, "div"); library.hidden = true;
  const editor = element(create, "div");
  const resultArea = element(create, "div", "section");
  const status = element(root, "p", "status muted"); status.setAttribute("role", "status");
  const error = element(root, "p", "status"); error.setAttribute("role", "alert");
  const toolbar = element(root, "div", "toolbar row");
  const draft = button(toolbar, "LLMで作成・修正", () => { collect(); openDraftDialog(node, () => { collect(); return plan; }, value => { plan = value; save(); render(); }, () => structuredClone(scene)); });
  const generate = button(toolbar, "このシーンを生成", async () => { collect(); save(); await busy(() => queue.generate(structuredClone({ plan, scene }))); }); generate.className = "primary";
  button(toolbar, "中止", () => queue.project || queue.busy || node.properties.h3_pending ? queue.stop() : projectRequest(project.value, "stop").then(refreshLibrary));
  let plan, scene, cut = 0, selectedAsset = 0, collect = () => {}, inLibrary = false, selected = new Set();
  const queue = new DirectorQueue(node, message => { status.textContent = message; }, showResult);

  function element(parent, tag, className = "", text = "") { const e = document.createElement(tag); e.className = className; e.textContent = text; parent.append(e); return e; }
  function report(e) { error.textContent = e.message ?? String(e); }
  function button(parent, text, action) { const e = element(parent, "button", "", text); e.type = "button"; e.onclick = async () => { error.textContent = ""; try { await action(); } catch (e) { report(e); } }; return e; }
  function input(parent, label, value, multiline = false) {
    const wrapper = element(parent, "label", "grow"); element(wrapper, "span", "label", label);
    const e = element(wrapper, multiline ? "textarea" : "input"); e.value = value ?? "";
    if (multiline) e.rows = 2; else e.style.width = "100%";
    return e;
  }
  function select(parent, label, options, value, change) {
    const wrapper = element(parent, "label"); element(wrapper, "span", "label", label); const e = element(wrapper, "select");
    for (const [value, title] of options) { const o = element(e, "option", "", title); o.value = value; }
    e.value = value; e.onchange = () => { try { collect(); change(e.value); save(); render(); } catch (e) { report(e); } }; return e;
  }
  function changed() { node.graph?.change(); node.setDirtyCanvas(true, true); }
  function save() { widgets.plan_json.value = JSON.stringify(plan); widgets.scene_json.value = JSON.stringify(scene); changed(); }
  function switchTab(value) {
    inLibrary = value; create.hidden = value; library.hidden = !value;
    createTab.setAttribute("aria-selected", !value); libraryTab.setAttribute("aria-selected", value);
    draft.hidden = value; generate.hidden = value;
  }
  async function busy(action) {
    generate.disabled = true; draft.disabled = true; project.disabled = true;
    try { return await action(); } finally { generate.disabled = false; draft.disabled = false; project.disabled = false; }
  }
  function preview(parent, asset, small = false) {
    if (!asset.file) return element(parent, "span", "symbol", "未選択");
    const e = element(parent, asset.kind === "image" ? "img" : asset.kind);
    e.src = viewUrl(asset.file);
    if (asset.kind === "image") e.alt = asset.file.split(/[\\/]/).pop();
    else { e.preload = "metadata"; e.controls = !small; }
    if (!small) e.style.cssText = "max-width:100%;max-height:140px;display:block";
    return e;
  }
  async function upload(files, replace = null) {
    for (const file of files) {
      const kind = file.type.split("/")[0];
      if (!["image", "audio", "video"].includes(kind)) throw new Error("画像・音声・動画ファイルを選択してください。");
      const form = new FormData(); form.append("image", file); form.append("type", "input"); form.append("subfolder", "h3_scene_director");
      const response = await api.fetchApi("/upload/image", { method: "POST", body: form });
      if (!response.ok) throw new Error("素材をアップロードできませんでした。");
      const data = await response.json();
      const role = kind === "image" && ["I2V", "FL2V"].includes(scene.mode) && !scene.assets.some(a => a.role === "first") ? "first" : kind === "image" && ["L2V", "FL2V"].includes(scene.mode) ? "last" : "reference";
      const asset = { kind, role, file: [data.subfolder, data.name].filter(Boolean).join("/"), enabled: true, note: "" };
      if (replace) {
        Object.assign(replace, { ...asset, note: replace.note ?? "", role: replace.kind === kind ? replace.role : role, enabled: replace.enabled !== false }); replace = null;
      } else { scene.assets.push(asset); selectedAsset = scene.assets.length - 1; }
      save();
    }
    render();
  }
  function chooseFiles(replace = null) {
    const file = document.createElement("input"); file.type = "file"; file.accept = "image/*,audio/*,video/*"; file.multiple = !replace;
    file.onchange = () => upload([...file.files], replace).catch(report); file.click();
  }

  function render() {
    editor.replaceChildren(); collect = () => {};
    const header = element(editor, "div", "row");
    const title = input(header, "シーン名（採用保存時）", node.properties.h3_title ?? ""); title.placeholder = "例：庭を歩く";
    title.oninput = () => { node.properties.h3_title = title.value; changed(); };
    select(header, "生成モード", [["R2V", "R2V · 参照素材"], ["T2V", "T2V · Promptのみ"], ["I2V", "I2V · 始点"], ["L2V", "L2V · 終点"], ["FL2V", "FL2V · 始点＋終点"]], scene.mode, v => { scene.mode = v; });
    const mediaHeader = element(editor, "div", "row spread section"); element(mediaHeader, "strong", "", "参照素材"); button(mediaHeader, "素材を追加", () => chooseFiles());
    const strip = element(editor, "div", "strip");
    strip.ondragover = e => e.preventDefault(); strip.ondrop = e => { e.preventDefault(); upload([...e.dataTransfer.files]).catch(report); };
    const refs = referenceDescriptions(scene); const active = sceneAssets(scene);
    if (!scene.assets.length) element(strip, "div", "empty grow", "画像・音声・動画をここへドロップ、または「素材を追加」");
    scene.assets.forEach((asset, index) => {
      const card = button(strip, "", () => { collect(); selectedAsset = index; render(); });
      card.className = "asset" + (active.includes(asset) ? "" : " inactive"); card.setAttribute("aria-selected", index === selectedAsset);
      card.setAttribute("aria-label", `素材 ${index + 1} ${asset.file.split(/[\\/]/).pop() || "未選択"}`);
      if (asset.kind === "audio") element(card, "span", "symbol", "♫ 音声"); else preview(card, asset, true);
      element(card, "span", "", refs.filter(r => r.asset_index === index).map(r => r.label).join(" / ") || "不使用");
    });
    selectedAsset = Math.min(selectedAsset, scene.assets.length - 1);
    const asset = scene.assets[selectedAsset];
    if (asset) {
      const panel = element(editor, "div", "reference"); const line = element(panel, "div", "row spread");
      const enabledLabel = element(line, "label"); const enabled = element(enabledLabel, "input"); enabled.type = "checkbox"; enabled.checked = asset.enabled !== false; enabledLabel.append(" 使用する");
      enabled.onchange = () => { asset.enabled = enabled.checked; save(); render(); };
      if (asset.kind === "image") select(line, "役割", [["reference", "R2V参照"], ["first", "始点画像"], ["last", "終点画像"]], asset.role ?? "reference", v => { asset.role = v; });
      button(line, "差し替え", () => chooseFiles(asset)); button(line, "削除", () => { collect(); scene.assets.splice(selectedAsset, 1); save(); render(); });
      if (asset.kind !== "image") preview(panel, asset);
      if (asset.kind === "video") {
        const label = element(panel, "label"); const audio = element(label, "input"); audio.type = "checkbox"; audio.checked = asset.use_audio ?? false; label.append(" 動画の音声も参照する");
        audio.onchange = () => { asset.use_audio = audio.checked; save(); render(); };
      }
      const note = input(panel, "素材メモ（LLMに伝える役割・内容）", asset.note, true);
      note.oninput = () => { asset.note = note.value; save(); };
      const details = element(panel, "details"); element(details, "summary", "", "ファイル・参照サイズ");
      const filename = input(details, "input/output内のファイル", asset.file); filename.onchange = () => { asset.file = filename.value; save(); render(); };
      if (scene.mode === "R2V") select(details, "R2V画像サイズ", [["match", "match"], ["max", "max"]], scene.ref_image_size ?? "match", v => { scene.ref_image_size = v; });
    }
    const prefix = input(editor, "共通Prompt", plan.prompt_prefix, true); prefix.rows = 2;
    const cutHeader = element(editor, "div", "row spread section"); element(cutHeader, "strong", "", `カット · ${plan.shots.length}`);
    button(cutHeader, "＋ カット追加", () => {
      collect(); let index = plan.shots.length + 1; while (plan.shots.some(s => s.id === `cut${index}`)) index++;
      plan.shots.push({ id: `cut${index}`, prompt: "", duration_seconds: 15 }); cut = plan.shots.length - 1; save(); render();
    });
    const cutTabs = element(editor, "div", "strip"); cut = Math.min(cut, plan.shots.length - 1);
    plan.shots.forEach((shot, index) => {
      const tab = button(cutTabs, `${index + 1} · ${shot.length != null ? `${shot.length}f` : `${shot.duration_seconds ?? plan.defaults?.duration_seconds ?? 15}s`}`, () => { collect(); cut = index; render(); });
      tab.className = "cut-tab"; tab.setAttribute("aria-selected", index === cut); tab.setAttribute("aria-label", `カット ${index + 1}`);
    });
    const shot = plan.shots[cut]; const line = element(editor, "div", "row spread");
    const seconds = input(line, "生成秒数（overlap込み）", shot.duration_seconds); seconds.style.width = "125px";
    element(line, "span", "muted", "完成尺は重複を除いた長さです");
    button(line, "このカットを削除", () => { if (plan.shots.length === 1) throw new Error("1カットは必要です。"); collect(); plan.shots.splice(cut, 1); cut = Math.max(0, cut - 1); save(); render(); });
    const prompt = input(editor, `カット ${cut + 1} のPrompt`, shot.prompt, true); prompt.className = "prompt"; prompt.rows = 7;
    const advanced = element(editor, "details"); element(advanced, "summary", "", "カット詳細 · seed / ID / 開始・終了状態");
    const fields = element(advanced, "div", "row"); const id = input(fields, "ID", shot.id ?? `cut${cut + 1}`); const seed = input(fields, "seed（空欄は接続seed）", shot.seed);
    const start = input(advanced, "開始状態", shot.start_state, true); const end = input(advanced, "終了状態", shot.end_state, true);
    collect = () => {
      plan.shots[cut] = updateCut(plan.shots[cut], { id: id.value, seconds: seconds.value, seed: seed.value, prompt: prompt.value });
      if (start.value || "start_state" in shot) plan.shots[cut].start_state = start.value;
      if (end.value || "end_state" in shot) plan.shots[cut].end_state = end.value;
      if (prefix.value || "prompt_prefix" in plan) plan.prompt_prefix = prefix.value;
    };
    for (const field of [prefix, seconds, prompt, id, seed, start, end]) field.oninput = () => { try { collect(); save(); error.textContent = ""; } catch (e) { report(e); } };
    const importing = element(editor, "details"); element(importing, "summary", "", "Plan JSONを読み込む");
    const file = element(importing, "input"); file.type = "file"; file.accept = ".json,application/json";
    file.onchange = async () => { try { if (!file.files[0]) return; const imported = readPlan(await file.files[0].text()); if (confirm("編集中のカットを読み込んだPlanで置き換えますか？")) { plan = imported; cut = 0; widgets.use_current_settings.value = false; save(); render(); } } catch (e) { report(e); } };
  }

  function showResult(result, canAdopt = true) {
    resultArea.replaceChildren(); element(resultArea, "strong", "", "完成結果" + (result.duration_seconds != null ? ` · ${result.duration_seconds.toFixed(2)}秒` : ""));
    const video = element(resultArea, "video", "result-video"); video.src = viewUrl(result.video); video.controls = true; video.preload = "metadata";
    if (canAdopt) button(resultArea, "この結果を採用して保存", async () => {
      await projectRequest(project.value, "adopt", { prompt_id: result.prompt_id, node_id: result.node_id, title: node.properties.h3_title });
      status.textContent = `「${project.value}」へ採用保存しました。`; node.properties.h3_project = project.value; changed();
    });
    element(resultArea, "p", "muted", "保存対象はこの動画を生成した時点のPrompt・seed・使用素材です。");
  }

  async function refreshLibrary() {
    const data = await projectRequest(project.value, "list"); const batch = data.batch;
    library.replaceChildren(); element(library, "p", "muted", "採用シーンのPrompt・素材・カット別seedを復元します。モデル・LoRA・steps・解像度は現在のworkflow設定で一括生成します。");
    const actions = element(library, "div", "row");
    button(actions, "更新", refreshLibrary); button(actions, "すべて選択", () => { selected = new Set(data.scenes.map(s => s.id)); return refreshLibrary(); });
    const start = button(actions, "選択シーンを一括生成", async () => { await busy(() => queue.batch(project.value, [...selected])); await refreshLibrary(); }); start.className = "primary";
    const resume = button(actions, "未完了から再開", async () => { await busy(() => queue.batch(project.value, [], true)); await refreshLibrary(); }); resume.disabled = !batch || batch.status === "complete";
    if (batch) {
      const names = { ready: "待機", running: "生成中", submitting: "開始処理中", complete: "完了", stopped: "停止", stopping: "停止要求中", error: "エラー" };
      element(library, "p", "", `${names[batch.status]} · ${batch.completed.length} / ${batch.ids.length} シーン完了 ${batch.error || ""}`);
      for (const result of batch.completed) {
        const link = element(library, "a", "", `生成結果 ${batch.completed.indexOf(result) + 1} `); link.href = viewUrl(result.video); link.target = "_blank"; link.style.color = "#b2c2ff";
      }
    }
    if (!data.scenes.length) element(library, "p", "empty", "保存済みシーンはありません。作成 → 生成 → 採用保存で追加できます。");
    for (const item of data.scenes) {
      const row = element(library, "div", "library-item row"); const check = element(row, "input"); check.type = "checkbox"; check.checked = selected.has(item.id); check.setAttribute("aria-label", `${item.title}を選択`);
      check.onchange = () => check.checked ? selected.add(item.id) : selected.delete(item.id);
      const thumbnail = element(row, "video"); thumbnail.src = viewUrl(item.video); thumbnail.preload = "metadata"; thumbnail.muted = true;
      const label = element(row, "div", "grow"); element(label, "strong", "", item.title); element(label, "div", "muted", `${item.mode} · ${item.cuts}カット · ${item.duration_seconds?.toFixed(2) ?? "?"}秒`);
      button(row, "読み込む", async () => {
        if (!confirm("編集中のシーンを保存済みシーンで置き換えますか？")) return;
        const saved = await projectRequest(project.value, "load", { id: item.id });
        plan = readPlan(JSON.stringify(saved.plan)); scene = saved.scene; cut = 0; selectedAsset = 0; node.properties.h3_title = saved.title;
        widgets.use_current_settings.value = true;
        save(); render(); switchTab(false); showResult({ video: saved.video, duration_seconds: saved.duration_seconds }, false);
        status.textContent = "保存シーンを読み込みました。生成設定は現在のworkflowを使用します。";
      });
    }
    element(library, "p", "muted", `保存先：${data.directory}`);
    element(library, "p", "muted", "一括生成中はこの画面を開いておいてください。閉じた場合は再度開いて「未完了から再開」。失敗したシーンは先頭カットから再生成します。");
  }

  widgets.plan_json.serializeValue = () => { collect(); return JSON.stringify(plan); };
  node.addDOMWidget("cut_editor", "custom", root, { serialize: false, hideOnZoom: false, getMinHeight: () => 600, getHeight: () => 900 });
  function restore() {
    try {
      plan = readPlan(widgets.plan_json.value); scene = JSON.parse(widgets.scene_json.value); sceneAssets(scene);
      project.value = node.properties.h3_project ?? "MyScenes"; render(); switchTab(false);
      if (node.properties.h3_result) showResult(node.properties.h3_result);
    } catch (e) { collect = () => { throw e; }; report(e); }
  }
  const configured = node.onConfigure;
  node.onConfigure = function () { const result = configured?.apply(this, arguments); restore(); return result; };
  const executed = event => {
    const data = event.detail;
    if (!data.output?.h3_scene_result || queue.busy || !data.prompt_id) return;
    const resultNode = node.graph?.getNodeById(Number(data.node));
    const sceneInput = resultNode?.inputs?.find(i => i.name === "scene");
    if (node.graph?.links?.[sceneInput?.link]?.origin_id !== node.id) return;
    node.properties.h3_pending = { prompt_id: data.prompt_id, node_id: String(data.node) };
    queue.stopped = false;
    queue.watch(data.prompt_id, String(data.node)).catch(report);
  };
  api.addEventListener("executed", executed);
  const removed = node.onRemoved;
  node.onRemoved = function () { queue.stopped = true; api.removeEventListener("executed", executed); return removed?.apply(this, arguments); };
  button(toolbar, "結果を更新", async () => {
    queue.stopped = false;
    if (node.properties.h3_pending) await queue.watch(node.properties.h3_pending.prompt_id, node.properties.h3_pending.node_id);
    else if (node.properties.h3_result) showResult(node.properties.h3_result);
    if (inLibrary) await refreshLibrary();
  });
  restore();
}

app.registerExtension({
  name: "H3SceneBatch.Director",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "H3SceneDirector") return;
    const created = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () { const result = created?.apply(this, arguments); attachDirector(this); return result; };
  },
});

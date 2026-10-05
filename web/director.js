import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { readPlan, updateCut } from "./director_plan.js";
import { sceneAssets, referenceDescriptions } from "./director_llm.js";
import { openDraftDialog } from "./director_dialog.js";

function attachSceneEditor(node, parent, report) {
  const widget = node.widgets.find(w => w.name === "scene_json");
  if (!widget) return null;
  widget.hidden = true; widget.options = { ...widget.options, hidden: true }; widget.computeSize = () => [0, -4];
  if (widget.element) widget.element.hidden = true;
  const root = document.createElement("fieldset");
  const legend = document.createElement("legend"); legend.textContent = "シーンのモード・参照素材"; root.append(legend); parent.append(root);
  const body = document.createElement("div"); body.style.cssText = "max-height:320px;overflow:auto"; root.append(body);
  let scene;
  function save() { widget.value = JSON.stringify(scene); node.graph?.change(); node.setDirtyCanvas(true, true); }
  function button(parent, title, action) {
    const element = document.createElement("button"); element.type = "button"; element.textContent = title;
    element.onclick = async () => { try { await action(); report(""); } catch (e) { report(e.message); } };
    parent.append(element); return element;
  }
  function select(parent, title, values, current, change) {
    const label = document.createElement("label"); label.textContent = title + " ";
    const element = document.createElement("select");
    for (const [value, title] of values) { const option = document.createElement("option"); option.value = value; option.textContent = title; element.append(option); }
    element.value = current; element.onchange = () => { change(element.value); save(); render(); };
    label.append(element); parent.append(label);
  }
  function render() {
    body.replaceChildren();
    select(body, "生成モード", ["R2V", "T2V", "I2V", "L2V", "FL2V"].map(v => [v, v]), scene.mode, v => { scene.mode = v; });
    select(body, "R2V画像サイズ", [["match", "match"], ["max", "max"]], scene.ref_image_size ?? "match", v => { scene.ref_image_size = v; });
    const active = sceneAssets(scene);
    const references = referenceDescriptions(scene);
    for (const [index, asset] of scene.assets.entries()) {
      const row = document.createElement("fieldset"); row.style.marginTop = "8px";
      const title = document.createElement("legend"); title.textContent = `${index + 1}. ${asset.kind} ${active.includes(asset) ? references.filter(r => r.asset_index === index).map(r => r.label).join(" / ") : "このモードでは不使用"}`; row.append(title);
      const enabledLabel = document.createElement("label");
      const enabled = document.createElement("input"); enabled.type = "checkbox"; enabled.checked = asset.enabled !== false;
      enabled.onchange = () => { asset.enabled = enabled.checked; save(); render(); };
      enabledLabel.append(enabled, " 有効 "); row.append(enabledLabel);
      if (asset.kind === "image") select(row, "役割", [["reference", "R2V参照"], ["first", "始点画像"], ["last", "終点画像"]], asset.role ?? "reference", v => { asset.role = v; });
      const filenameLabel = document.createElement("label"); filenameLabel.textContent = "input内のファイル ";
      const filename = document.createElement("input"); filename.value = asset.file ?? ""; filename.style.width = "95%";
      filename.onchange = () => { asset.file = filename.value; save(); render(); }; filenameLabel.append(filename); row.append(filenameLabel);
      const file = document.createElement("input"); file.type = "file"; file.accept = `${asset.kind}/*`; file.hidden = true;
      file.onchange = async () => {
        try {
          if (!file.files[0]) return;
          const form = new FormData(); form.append("image", file.files[0]); form.append("type", "input"); form.append("subfolder", "h3_scene_director");
          const response = await api.fetchApi("/upload/image", { method: "POST", body: form });
          if (!response.ok) throw new Error("参照素材をアップロードできませんでした。");
          const data = await response.json();
          if (!scene.assets.includes(asset)) return;
          asset.file = [data.subfolder, data.name].filter(Boolean).join("/"); save(); render(); report("");
        } catch (e) { report(e.message); }
      };
      row.append(file); button(row, "ファイルを選択", () => file.click());
      button(row, "素材を削除", () => { scene.assets.splice(index, 1); save(); render(); });
      if (asset.kind === "video") {
        const label = document.createElement("label"); const audio = document.createElement("input"); audio.type = "checkbox"; audio.checked = asset.use_audio ?? false;
        audio.onchange = () => { asset.use_audio = audio.checked; save(); render(); }; label.append(audio, " 動画の音声も参照"); row.append(label);
      }
      if (asset.file) {
        const preview = document.createElement(asset.kind === "image" ? "img" : asset.kind);
        const path = asset.file.replaceAll("\\", "/").replace(/ \[input\]$/, ""); const split = path.lastIndexOf("/");
        preview.src = api.apiURL(`/view?${new URLSearchParams({ filename: path.slice(split + 1), subfolder: path.slice(0, Math.max(0, split)), type: "input" })}`);
        preview.style.cssText = "display:block;max-width:100%;max-height:160px;margin-top:6px";
        if (asset.kind === "image") preview.alt = `参照画像 ${index + 1}`;
        else { preview.controls = true; preview.preload = "metadata"; }
        row.append(preview);
      }
      const label = document.createElement("label"); label.textContent = "素材の役割・内容メモ（LLMへ渡す）";
      const note = document.createElement("textarea"); note.rows = 2; note.value = asset.note ?? ""; note.style.cssText = "display:block;width:100%;box-sizing:border-box";
      note.oninput = () => { asset.note = note.value; save(); }; label.append(note); row.append(label); body.append(row);
    }
    for (const [kind, label] of [["image", "画像"], ["audio", "音声"], ["video", "動画"]]) button(body, `${label}を追加`, () => {
      scene.assets.push({ kind, role: kind === "image" && scene.mode === "I2V" ? "first" : kind === "image" && scene.mode === "L2V" ? "last" : "reference", file: "", enabled: true, note: "" }); save(); render();
    });
  }
  function restore() { scene = JSON.parse(widget.value); sceneAssets(scene); render(); }
  restore();
  return { restore, get: () => structuredClone(scene) };
}

function attachCutEditor(node) {
  const widget = node.widgets.find((item) => item.name === "plan_json");
  widget.hidden = true;
  widget.options = { ...widget.options, hidden: true };
  widget.computeSize = () => [0, -4];
  if (widget.element) widget.element.hidden = true;
  const editor = document.createElement("div");
  editor.style.cssText = "height:100%;overflow:auto;box-sizing:border-box;background:var(--comfy-menu-bg,#222);color:var(--fg-color,#ddd);padding:10px;font:13px sans-serif;";
  const help = document.createElement("p");
  help.textContent = "1つのシーン内のカットです。秒数は重複込みの生成時間で、完成動画は重複除去後の長さになります。seedが空欄なら接続されたbase_seedを使います。";
  const error = document.createElement("p");
  error.style.color = "#ff9292";
  error.setAttribute("role", "alert");
  const body = document.createElement("div");
  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;gap:12px;flex-wrap:wrap;margin-top:16px";
  editor.append(help, error, body, actions);
  const mediaContainer = document.createElement("div"); editor.insertBefore(mediaContainer, body);
  const media = attachSceneEditor(node, mediaContainer, message => { error.textContent = message; });
  let plan;
  let collect;

  function input(parent, label, value, multiline = false) {
    const wrapper = document.createElement("label");
    wrapper.style.cssText = "display:block;flex:1;margin:8px 0";
    wrapper.append(document.createTextNode(label));
    const field = document.createElement(multiline ? "textarea" : "input");
    field.value = value ?? "";
    field.style.cssText = "display:block;width:100%;min-width:0;box-sizing:border-box;padding:8px;background:var(--comfy-input-bg,#333);color:inherit;border:1px solid #777;resize:vertical";
    if (multiline) field.rows = 4;
    wrapper.append(field);
    parent.append(wrapper);
    return field;
  }
  function attempt(action) {
    try { action(); error.textContent = ""; }
    catch (e) { error.textContent = e.message; }
  }
  function button(parent, label, action) {
    const element = document.createElement("button");
    element.type = "button";
    element.textContent = label;
    element.addEventListener("click", () => attempt(action));
    parent.append(element);
    return element;
  }
  function render() {
    body.replaceChildren();
    const prefix = input(body, "共通Prompt", plan.prompt_prefix, true);
    const rows = plan.shots.map((shot, index) => {
      const row = document.createElement("fieldset");
      row.style.marginTop = "12px";
      const legend = document.createElement("legend");
      legend.textContent = `カット ${index + 1}`;
      row.append(legend);
      body.append(row);
      const line = document.createElement("div");
      line.style.cssText = "display:flex;gap:12px;flex-wrap:wrap";
      row.append(line);
      const id = input(line, "ID", shot.id ?? `cut${index + 1}`);
      const seconds = input(line, shot.length != null ? `生成秒数（未変更なら${shot.length}フレーム指定を保持）` : "生成秒数（空欄はPlan既定値）", shot.duration_seconds);
      const seed = input(line, "seed（空欄はbase_seed）", shot.seed);
      const prompt = input(row, "Prompt", shot.prompt, true);
      button(row, "削除", () => {
        if (plan.shots.length === 1) throw new Error("少なくとも1カット必要です。");
        collect(); plan.shots.splice(index, 1); save(); render();
      });
      return () => updateCut(plan.shots[index], { id: id.value, seconds: seconds.value, seed: seed.value, prompt: prompt.value });
    });
    collect = () => {
      const shots = rows.map((read) => read());
      plan = { ...plan, shots };
      if (prefix.value || "prompt_prefix" in plan) plan.prompt_prefix = prefix.value;
    };
  }

  function save() {
    widget.value = JSON.stringify(plan, null, 2);
    node.graph?.change();
    node.setDirtyCanvas(true, true);
  }
  body.addEventListener("input", () => attempt(() => { collect(); save(); }));
  // Refuse to queue stale values while an inline field contains an invalid edit.
  widget.serializeValue = () => {
    try { collect(); return JSON.stringify(plan, null, 2); }
    catch (e) { error.textContent = e.message; throw e; }
  };

  button(actions, "カット追加", () => {
    collect();
    let index = plan.shots.length + 1;
    while (plan.shots.some((shot) => shot.id === `cut${index}`)) index++;
    plan.shots.push({ id: `cut${index}`, prompt: "", duration_seconds: 15 });
    save(); render();
  });
  const file = document.createElement("input");
  file.type = "file"; file.accept = ".json,application/json"; file.hidden = true;
  file.addEventListener("change", async () => {
    try {
      if (!file.files[0]) return;
      const imported = readPlan(await file.files[0].text());
      if (!window.confirm("編集中のカットを、読み込んだJSONの内容に置き換えますか？")) return;
      plan = imported; save(); render(); error.textContent = "";
    } catch (e) { error.textContent = e.message; }
    finally { file.value = ""; }
  });
  editor.append(file);
  button(actions, "Plan JSONを読み込む", () => file.click());
  if (media) button(actions, "LLMでPromptを作成・修正", () => {
    collect();
    openDraftDialog(node, () => { collect(); return plan; }, value => { plan = value; save(); render(); }, media.get);
  });
  node.addDOMWidget("cut_editor", "custom", editor, {
    serialize: false, hideOnZoom: false, getMinHeight: () => 360, getHeight: () => 600,
  });
  function restore() {
    collect = () => { throw new Error("有効なPlan JSONを読み込んでください。"); };
    body.replaceChildren();
    attempt(() => { plan = readPlan(widget.value); render(); });
  }
  const configured = node.onConfigure;
  node.onConfigure = function () {
    const result = configured?.apply(this, arguments);
    if (media) attempt(media.restore);
    restore();
    return result;
  };
  restore();
}

app.registerExtension({
  name: "H3SceneBatch.Director",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "H3SceneDirector") return;
    const created = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = created?.apply(this, arguments);
      attachCutEditor(this);
      return result;
    };
  },
});

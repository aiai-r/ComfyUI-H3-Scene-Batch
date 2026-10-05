import { app } from "../../scripts/app.js";
import { readPlan, updateCut } from "./director_plan.js";

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

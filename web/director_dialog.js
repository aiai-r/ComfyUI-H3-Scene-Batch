import { api } from "../../scripts/api.js";
import { draftGraph, readDraft, sceneAssets, referenceDescriptions, referenceDefinitions, includeReferenceDefinitions, imageAnalysisKey, SYSTEM_PROMPTS, renderSystemPrompt } from "./director_llm.js";

export class DirectorLLM {
  constructor(node, notify) { this.node = node; this.notify = notify; this.cancelled = false; this.promptId = null; }

  imageRecord(asset) {
    const id = this.node.properties.h3_image_analysis_keys?.[asset.file] ?? JSON.stringify([asset.file, asset.role ?? "reference", asset.note ?? ""]);
    const records = this.node.properties.h3_image_analyses ??= {};
    return records[id] ??= { text: "", key: "" };
  }

  async imageKey(asset) {
    return imageAnalysisKey({ mode: "R2V", assets: [{ kind: "image", file: asset.file }] }, async path => {
      const response = await api.fetchApi(path, { cache: "no-store" });
      if (!response.ok) throw new Error("参照画像を読み込めません。素材を確認してください。");
      return response.arrayBuffer();
    });
  }

  async matchImage(asset) {
    const key = await this.imageKey(asset);
    const previous = this.imageRecord(asset);
    const previousKey = this.node.properties.h3_image_analysis_keys?.[asset.file];
    const records = this.node.properties.h3_image_analyses;
    if (!records[key]) {
      for (const [oldKey, record] of [[previousKey, previous], ...Object.entries(records)]) {
        let parsed;
        try { parsed = JSON.parse(oldKey); }
        catch (error) { if (error instanceof SyntaxError) continue; throw error; }
        if (record.text.trim() && (JSON.stringify({ images: parsed?.images }) === key || !previousKey && Array.isArray(parsed) && record === previous)) {
          records[key] = record;
          break;
        }
      }
    }
    (this.node.properties.h3_image_analysis_keys ??= {})[asset.file] = key;
    const record = this.imageRecord(asset); record.key = key;
    this.node.graph?.change();
    return record;
  }

  async execute(graph, label) {
    if (this.cancelled) throw new Error("LLM処理を中止しました。");
    this.notify(label);
    const response = await api.fetchApi("/prompt", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: graph, client_id: api.clientId }) });
    const queued = await response.json();
    if (!response.ok) throw new Error(`LLMキュー登録失敗: ${JSON.stringify(queued.node_errors ?? queued.error ?? queued)}`);
    this.promptId = queued.prompt_id;
    if (this.cancelled) await this.stop();
    try {
      while (!this.cancelled) {
        const response = await api.fetchApi(`/history/${encodeURIComponent(this.promptId)}`);
        if (!response.ok) throw new Error("LLMの実行履歴を取得できません。キュー画面を確認してください。");
        const history = (await response.json())[this.promptId];
        if (this.cancelled) break;
        if (history?.status?.status_str === "error") {
          const failure = history.status.messages?.find(([name]) => name === "execution_error")?.[1];
          throw new Error(failure?.exception_message ?? "LLM処理が失敗しました。");
        }
        if (history?.status?.completed) {
          const text = history.outputs?.result?.text?.[0];
          if (typeof text !== "string" || !text.trim()) throw new Error("LLMのテキスト出力がありません。");
          return text;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      throw new Error("LLM処理を中止しました。確定Promptは変更していません。");
    } finally { this.promptId = null; }
  }

  async stop() {
    this.cancelled = true;
    if (!this.promptId) return;
    for (const [path, body] of [["/queue", { delete: [this.promptId] }], ["/interrupt", { prompt_id: this.promptId }]]) {
      const response = await api.fetchApi(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error("中止要求に失敗しました。キュー画面を確認してください。");
    }
  }

  async analyze(scene, assets = sceneAssets(scene).filter(a => a.kind === "image"), force = false, instruction = "") {
    const config = this.node.properties.h3_llm;
    if (!config) throw new Error("LLM設定がありません。開発workflowを開いてください。");
    for (const asset of assets) {
      if (this.cancelled) throw new Error("LLM処理を中止しました。");
      const single = { mode: scene.mode, assets: [asset] };
      const record = await this.matchImage(asset), current = record.key;
      if (!force && record.text.trim()) continue;
      const reference = referenceDescriptions(scene).find(r => r.kind === "image" && scene.assets[r.asset_index] === asset);
      const target = { image_number: (asset.slot ?? scene.assets.filter(a => a.kind === "image").indexOf(asset)) + 1,
        label: reference.label, role: asset.role ?? "reference", note: asset.note ?? "" };
      const graph = draftGraph(config, single, { shots: [] }, "analysis", instruction, "", null, "", "", true, target);
      if (force) graph.writer.inputs.seed = crypto.getRandomValues(new Uint32Array(1))[0];
      const text = await this.execute(graph, `画像解析中：${asset.file}`);
      if (current !== await this.imageKey(asset)) throw new Error("処理中に画像が変わりました。解析を再実行してください。");
      if (this.cancelled) throw new Error("LLM処理を中止しました。");
      if (!text.trim()) throw new Error("画像の参照定義が空です。再解析してください。");
      record.text = text; record.key = current; this.node.graph?.change();
    }
    const references = referenceDescriptions(scene).filter(r => r.kind === "image")
      .map(r => ({ label: r.label, ...this.imageRecord(scene.assets[r.asset_index]) }));
    return scene.mode === "R2V" ? referenceDefinitions(references)
      : references.map(r => `${r.label}\n${r.text.replace(/<Subject\s+\d+>/g, "The referenced subject").replace(/<Picture(?:\s+\d+)?>/g, r.label)}`).join("\n\n");
  }

  async create(plan, scene, selected, state, action, onStory) {
    const analysis = await this.analyze(scene, undefined, false, state.instruction);
    const config = this.node.properties.h3_llm;
    let story = action === "prompt" ? state.story : "";
    const graph = stage => {
      const value = draftGraph(config, scene, plan, stage, state.instruction, story, selected, analysis,
        state.includePrevious && (selected !== null || action === "prompt") ? state.sceneStory : "", state.includePrevious);
      value.writer.inputs.seed = crypto.getRandomValues(new Uint32Array(1))[0];
      return value;
    };
    if (action === "story" || action === "all") {
      story = await this.execute(graph("story"), "ストーリー作成中…");
      onStory(story);
    }
    if (action === "story") return null;
    const text = await this.execute(graph("prompt"), "Prompt作成中…");
    const drafts = readDraft(text, plan, selected);
    if (scene.mode === "R2V") for (const draft of drafts) draft.prompt = includeReferenceDefinitions(draft.prompt, analysis);
    return drafts;
  }
}

export function openLLMSettings(node) {
  const config = node.properties.h3_llm;
  if (!config) throw new Error("LLM設定がありません。開発workflowを開いてください。");
  const dialog = document.createElement("dialog");
  dialog.style.cssText = "width:min(900px,90vw);max-height:85vh;overflow:auto;background:var(--comfy-menu-bg,#222);color:var(--fg-color,#ddd);padding:20px";
  const title = document.createElement("h3"); title.textContent = "LLM設定"; dialog.append(title);
  const model = document.createElement("p"); model.textContent = config.loader.model; dialog.append(model);
  for (const [stage, name] of [["story", "ストーリー"], ["prompt", "Prompt・画像解析の整理"]]) {
    for (const [key, label] of [["seed", "seed"], ["max_tokens", "最大出力トークン"], ["temperature", "temperature"]]) {
      if (key === "seed" && stage === "story") continue;
      const owner = key === "seed" ? config[stage].inputs : config[stage].parameters;
      const row = document.createElement("label"); row.style.cssText = "display:block;margin:10px 0"; row.textContent = key === "seed" ? "画像解析 seed " : `${name} ${label} `;
      const input = document.createElement("input"); input.type = "number"; input.value = owner[key]; input.step = key === "temperature" ? "any" : "1";
      input.onchange = () => {
        const value = Number(input.value);
        if (!input.value.trim() || !Number.isFinite(value) || key !== "temperature" && !Number.isSafeInteger(value)) {
          input.setCustomValidity("有効な数値を入力してください。"); input.reportValidity(); return;
        }
        input.setCustomValidity(""); owner[key] = value; node.graph?.change();
      };
      row.append(input); dialog.append(row);
    }
  }
  const heading = document.createElement("h3"); heading.textContent = "システムPrompt"; dialog.append(heading);
  const help = document.createElement("p");
  help.textContent = "対象ごとに編集して「保存」で適用します。「標準に戻す」は選択中のPromptだけをリセットします。変更はworkflow内に保持されるため、workflowも保存してください。保存せず閉じた編集は破棄されます。";
  dialog.append(help);
  const select = document.createElement("select"); select.setAttribute("aria-label", "システムPromptの対象");
  for (const [key, value] of Object.entries(SYSTEM_PROMPTS)) {
    const option = document.createElement("option"); option.value = key; option.textContent = value.label; select.append(option);
  }
  dialog.append(select);
  const editor = document.createElement("textarea"); editor.rows = 16; editor.spellcheck = false;
  editor.setAttribute("aria-label", "システムPrompt本文"); editor.style.cssText = "display:block;width:100%;box-sizing:border-box;margin:10px 0;resize:vertical";
  dialog.append(editor);
  const variables = document.createElement("p");
  variables.textContent = "{{mode_instructions}} はモードの指示、{{continuity_instructions}} は前カット説明の指示、{{output_instructions}} は対象カットと出力形式に展開されます。下の展開例で全文を確認できます。必要に応じて変数も本文に置き換えて編集できます。Prompt作成では shots / prompt のJSON出力形式を維持してください。";
  dialog.append(variables);
  const status = document.createElement("p"); status.setAttribute("role", "status"); dialog.append(status);
  const save = document.createElement("button"); save.textContent = "保存"; dialog.append(save);
  const reset = document.createElement("button"); reset.textContent = "標準に戻す"; dialog.append(reset);
  const details = document.createElement("details"); const summary = document.createElement("summary");
  summary.textContent = "送信されるシステムPromptの展開例"; details.append(summary); dialog.append(details);
  const mode = document.createElement("select"); mode.setAttribute("aria-label", "展開例のモード");
  for (const name of ["R2V", "T2V", "I2V", "L2V", "FL2V"]) {
    const option = document.createElement("option"); option.value = name; option.textContent = name; mode.append(option);
  }
  mode.value = JSON.parse(node.widgets?.find(w => w.name === "scene_json")?.value ?? '{"mode":"R2V"}').mode;
  details.append(mode);
  const check = (text, checked) => {
    const label = document.createElement("label"), input = document.createElement("input");
    input.type = "checkbox"; input.checked = checked; label.append(input, text); details.append(label); return input;
  };
  const partial = check("選択カットのみ", true), continuation = check("前カット説明あり", false);
  const preview = document.createElement("textarea"); preview.readOnly = true; preview.rows = 12;
  preview.setAttribute("aria-label", "送信Promptの展開例"); preview.style.cssText = editor.style.cssText; details.append(preview);
  const drafts = {};
  function renderPreview() {
    const key = select.value;
    const selectedMode = key === "prompt_r2v" ? "R2V" : key === "prompt_base" && mode.value === "R2V" ? "T2V" : mode.value;
    mode.value = selectedMode; mode.disabled = key === "analysis" || key === "prompt_r2v";
    mode.options[0].disabled = key === "prompt_base";
    partial.disabled = continuation.disabled = key === "analysis";
    preview.value = renderSystemPrompt({ system_prompts: { [key]: editor.value } }, selectedMode,
      key.startsWith("prompt_") ? "prompt" : key, partial.checked, continuation.checked);
  }
  function showPrompt() {
    editor.value = drafts[select.value] ?? config.system_prompts?.[select.value] ?? SYSTEM_PROMPTS[select.value].text;
    status.textContent = drafts[select.value] !== undefined ? "未保存の編集があります。" : config.system_prompts?.[select.value] !== undefined ? "保存済みのPrompt" : "標準のPrompt";
    renderPreview();
  }
  select.onchange = showPrompt;
  editor.oninput = () => { drafts[select.value] = editor.value; status.textContent = "未保存の編集があります。"; renderPreview(); };
  for (const input of [mode, partial, continuation]) input.onchange = renderPreview;
  save.onclick = () => {
    const key = select.value;
    const prompts = config.system_prompts ??= {};
    if (editor.value === SYSTEM_PROMPTS[key].text) delete prompts[key]; else prompts[key] = editor.value;
    delete drafts[key]; node.graph?.change(); status.textContent = "保存しました。workflowも保存してください。";
  };
  reset.onclick = () => {
    delete config.system_prompts?.[select.value]; delete drafts[select.value];
    node.graph?.change(); showPrompt(); status.textContent = "標準に戻しました。workflowも保存してください。";
  };
  select.value = "analysis"; showPrompt();
  const close = document.createElement("button"); close.textContent = "閉じる"; close.onclick = () => dialog.close(); dialog.append(close);
  dialog.addEventListener("close", () => dialog.remove(), { once: true }); document.body.append(dialog); dialog.showModal();
}

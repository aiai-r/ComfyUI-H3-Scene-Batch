import { api } from "../../scripts/api.js";
import { draftGraph, readDraft, sceneAssets, referenceDescriptions, imageAnalysisKey } from "./director_llm.js";

export class DirectorLLM {
  constructor(node, notify) { this.node = node; this.notify = notify; this.cancelled = false; this.promptId = null; }

  imageRecord(asset) {
    const id = JSON.stringify([asset.file, asset.role ?? "reference", asset.note ?? ""]);
    const records = this.node.properties.h3_image_analyses ??= {};
    return records[id] ??= { text: "", key: "" };
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

  async analyze(scene, assets = sceneAssets(scene).filter(a => a.kind === "image"), force = false) {
    const config = this.node.properties.h3_llm;
    if (!config) throw new Error("LLM設定がありません。開発workflowを開いてください。");
    for (const asset of assets) {
      if (this.cancelled) throw new Error("LLM処理を中止しました。");
      const single = { ...scene, assets: [{ ...asset, enabled: true }] };
      const key = () => imageAnalysisKey(config, single, async path => {
        const response = await api.fetchApi(path, { cache: "no-store" });
        if (!response.ok) throw new Error("参照画像を読み込めません。素材を確認してください。");
        return response.arrayBuffer();
      });
      const current = await key(), record = this.imageRecord(asset);
      if (!force && record.text.trim() && record.key === current) continue;
      const graph = draftGraph(config, single, { shots: [] }, "analysis", "", "");
      const text = await this.execute(graph, `画像解析中：${asset.file}`);
      if (current !== await key()) throw new Error("処理中に画像が変わりました。解析を再実行してください。");
      if (this.cancelled) throw new Error("LLM処理を中止しました。");
      record.text = text; record.key = current; this.node.graph?.change();
    }
    return referenceDescriptions(scene).filter(r => r.kind === "image")
      .map(r => `${r.label}\n${this.imageRecord(scene.assets[r.asset_index]).text}`).join("\n\n");
  }

  async create(plan, scene, selected, state, action, onStory) {
    const analysis = await this.analyze(scene);
    const config = this.node.properties.h3_llm;
    let story = state.story;
    const graph = stage => draftGraph(config, scene, plan, stage, state.instruction, story, selected, analysis,
      state.includePrevious ? state.sceneStory : "", state.includePrevious);
    if (action === "story" || action === "all") {
      story = await this.execute(graph("story"), "ストーリー作成中…");
      onStory(story);
    }
    if (action === "story") return null;
    const text = await this.execute(graph("prompt"), "Prompt作成中…");
    return readDraft(text, plan, selected);
  }
}

export function openLLMSettings(node) {
  const config = node.properties.h3_llm;
  if (!config) throw new Error("LLM設定がありません。開発workflowを開いてください。");
  const dialog = document.createElement("dialog");
  dialog.style.cssText = "width:min(650px,90vw);max-height:85vh;overflow:auto;background:var(--comfy-menu-bg,#222);color:var(--fg-color,#ddd);padding:20px";
  const title = document.createElement("h3"); title.textContent = "LLM設定"; dialog.append(title);
  const model = document.createElement("p"); model.textContent = config.loader.model; dialog.append(model);
  for (const [stage, name] of [["story", "ストーリー"], ["prompt", "Prompt・画像解析の整理"]]) {
    for (const [key, label] of [["seed", "seed"], ["max_tokens", "最大出力トークン"], ["temperature", "temperature"]]) {
      const owner = key === "seed" ? config[stage].inputs : config[stage].parameters;
      const row = document.createElement("label"); row.style.cssText = "display:block;margin:10px 0"; row.textContent = `${name} ${label} `;
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
  const close = document.createElement("button"); close.textContent = "閉じる"; close.onclick = () => dialog.close(); dialog.append(close);
  dialog.addEventListener("close", () => dialog.remove(), { once: true }); document.body.append(dialog); dialog.showModal();
}

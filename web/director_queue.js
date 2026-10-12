import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { applyPromotedWidgetControl } from "../../scripts/promotedWidgetControl.js";

export async function projectRequest(project, action, values = {}) {
  const response = await api.fetchApi("/h3_scene_director/project", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project, action, ...values }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "プロジェクトの操作に失敗しました。");
  return result;
}

export function batchProgress(batch) {
  const done = batch.completed.length, count = batch.ids.length;
  const position = batch.positions?.[Math.min(done, count - 1)] ?? Math.min(done + 1, count);
  const total = batch.total ?? count;
  const label = { ready: "開始位置", running: "生成中", submitting: "開始中", complete: "完了", stopped: "停止位置", stopping: "停止要求中", error: "エラー位置" }[batch.status];
  return `${label}：シーン ${position}/${total} · 今回 ${done}/${count} シーン完了${batch.error ? ` · ${batch.error}` : ""}`;
}

const loraLoaders = new Set(["Power Lora Loader (rgthree)", "LoraLoader", "LoraLoaderModelOnly"]);

export function restoreLoras(output, saved) {
  const loaders = Object.entries(output).filter(([, n]) => loraLoaders.has(n.class_type));
  const used = new Set();
  for (const entry of saved) {
    let target = loaders.find(([id, n]) => id === entry.id && n.class_type === entry.class_type && !used.has(id));
    if (!target) {
      const matches = loaders.filter(([id, n]) => n.class_type === entry.class_type && !used.has(id));
      if (matches.length === 1) target = matches[0];
    }
    if (!target) throw new Error("保存した追加LoRAの接続を復元できません。保存時と同じLoRAノード構成を使用してください。");
    const [id, node] = target; used.add(id);
    const connections = Object.fromEntries(Object.entries(node.inputs).filter(([key]) => ["model", "clip"].includes(key)));
    node.inputs = { ...connections, ...JSON.parse(JSON.stringify(entry.inputs)) };
  }
  for (const [id, node] of loaders) {
    if (used.has(id)) continue;
    if (node.class_type === "Power Lora Loader (rgthree)") {
      node.inputs = Object.fromEntries(Object.entries(node.inputs).filter(([key]) => ["model", "clip"].includes(key)));
    } else {
      node.inputs.strength_model = 0;
      if ("strength_clip" in node.inputs) node.inputs.strength_clip = 0;
    }
  }
}

export function sceneRequest(template, directorId, record, attempt, currentSettings, batchTurbo = null) {
  const value = JSON.parse(JSON.stringify(template));
  const inputs = value.output[String(directorId)]?.inputs;
  if (!inputs) throw new Error("Directorが実行グラフにありません。");
  const node = value.workflow.nodes.find(n => String(n.id) === String(directorId));
  const scene = { ...record.scene, output: attempt.output ?? { project: record.scene.output?.project ?? node.properties?.h3_project ?? "MyScenes" } };
  delete scene.batch_lora;
  if (batchTurbo !== null) {
    const saved = record.execution;
    if (saved?.additional_loras) restoreLoras(value.output, saved.additional_loras);
    const override = batchTurbo[scene.mode === "R2V" ? "R2V" : "FL2V"];
    if ((override || saved?.turbo) && !Object.values(value.output).some(n => n.class_type === "H3SceneTurboLora")) {
      throw new Error("H3 Scene Turbo LoRAが接続された開発workflowを使用してください。");
    }
    const turbo = override ?? saved?.turbo;
    if (turbo) scene.batch_lora = { lora_name: turbo.lora_name };
  }
  Object.assign(inputs, { plan_json: JSON.stringify(record.plan), scene_json: JSON.stringify(scene), run_name: attempt.run_name, use_current_settings: currentSettings });
  node.widgets_values = [inputs.run_name, inputs.plan_json, inputs.scene_json, currentSettings];
  if (node.widgets_values_named) Object.assign(node.widgets_values_named, { run_name: inputs.run_name, plan_json: inputs.plan_json, scene_json: inputs.scene_json, use_current_settings: currentSettings });
  return value;
}

export async function submitScene(value, promptId) {
  if (Object.values(value.output).some(n => n.class_type === "H3SceneTurboLora")) {
    try {
      const response = await api.fetchApi("/object_info/LoraLoaderModelOnly");
      if (!response.ok) throw new Error("LoRA一覧を取得できませんでした。");
      const names = (await response.json()).LoraLoaderModelOnly.input.required.lora_name[0];
      normalizeLoraPaths(value.output, names);
    } catch (error) { error.rejected = true; throw error; }
  }
  const response = await api.fetchApi("/prompt", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt_id: promptId, prompt: value.output, client_id: api.clientId, extra_data: { extra_pnginfo: { workflow: value.workflow } } }) });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error((result.error?.message ?? "生成を開始できませんでした。") + " " + JSON.stringify(result.node_errors ?? {}));
    error.rejected = true; throw error;
  }
  return result.prompt_id;
}

export function normalizeLoraPaths(output, names) {
  const normalized = name => name.replaceAll("\\", "/");
  const resolve = name => {
    const exact = names.filter(n => normalized(n) === normalized(name));
    const matches = exact.length ? exact : names.filter(n => normalized(n).split("/").at(-1) === normalized(name).split("/").at(-1));
    if (matches.length !== 1) throw new Error(`LoRAが見つからないか、同名ファイルが複数あります：${name}`);
    return matches[0];
  };
  for (const node of Object.values(output)) {
    if (node.class_type === "Power Lora Loader (rgthree)") {
      for (const [key, item] of Object.entries(node.inputs)) {
        if (key.toLowerCase().startsWith("lora_") && item.on && (item.strength !== 0 || (item.strengthTwo ?? item.strength) !== 0)) item.lora = resolve(item.lora);
      }
    } else if (["LoraLoader", "LoraLoaderModelOnly"].includes(node.class_type)) {
      if (typeof node.inputs.lora_name !== "string") throw new Error("保存LoRAの復元にはLoRA名をノードで直接指定してください。");
      node.inputs.lora_name = resolve(node.inputs.lora_name);
    }
  }
}

export function resultNode(template, directorId) {
  const found = Object.entries(template.output).find(([, n]) => n.class_type === "H3SceneResult" && String(n.inputs.scene?.[0]) === String(directorId));
  if (!found) throw new Error("完成版の開発workflowを開いてください。H3 Scene Resultの接続がありません。");
  return found[0];
}

const wait = () => new Promise(resolve => setTimeout(resolve, 1200));

function queueNodes(graph) {
  return graph._nodes.flatMap(node => node.isSubgraphNode?.()
    ? [...queueNodes(node.subgraph), node] : [node]);
}

function controlWidgets(nodes, phase) {
  for (const node of nodes) {
    for (const widget of node.widgets ?? []) widget[phase]?.({ isPartialExecution: false });
    applyPromotedWidgetControl(node, phase);
  }
}

export class DirectorQueue {
  constructor(node, notify, showResult) {
    this.node = node; this.notify = notify; this.showResult = showResult;
    this.owner = crypto.randomUUID(); this.stopped = false; this.busy = false;
  }

  async generate(record) {
    if (this.busy) throw new Error("このDirectorは実行中です。");
    this.busy = true; this.stopped = false;
    try {
      const nodes = queueNodes(app.rootGraph);
      controlWidgets(nodes, "beforeQueued");
      const template = await app.graphToPrompt();
      const output = resultNode(template, this.node.id);
      const attempt = { prompt_id: crypto.randomUUID(), run_name: "director_" + crypto.randomUUID().replaceAll("-", "").slice(0, 16) };
      const value = sceneRequest(template, this.node.id, record, attempt, template.output[String(this.node.id)].inputs.use_current_settings ?? false);
      this.node.properties.h3_pending = { prompt_id: attempt.prompt_id, node_id: output };
      this.notify("生成中：シーン全体を生成しています。");
      await submitScene(value, attempt.prompt_id);
      controlWidgets(nodes, "afterQueued");
      if (this.stopped) { await this.stop(); return; }
      await this.watch(attempt.prompt_id, output);
    } finally { this.busy = false; }
  }

  async watch(promptId, output) {
    while (!this.stopped) {
      const response = await api.fetchApi(`/history/${encodeURIComponent(promptId)}`);
      if (!response.ok) throw new Error("生成履歴を取得できませんでした。履歴を更新して確認してください。");
      const entry = (await response.json())[promptId];
      if (entry) {
        if (entry.status?.status_str !== "success") throw new Error("生成が失敗または中断されました。ComfyUIの実行履歴を確認してください。");
        const result = entry.outputs?.[output]?.h3_scene_result?.[0];
        if (!result) throw new Error("完成動画の結果がありません。");
        const saved = { prompt_id: promptId, node_id: output, video: result.video, duration_seconds: result.duration_seconds };
        this.node.properties.h3_result = saved;
        delete this.node.properties.h3_pending;
        this.showResult(saved); this.notify("生成完了。動画を確認して、良ければ採用保存してください。");
        this.node.graph?.change(); return;
      }
      await wait();
    }
  }

  async batch(project, ids, resume = false, startIndex = null) {
    if (this.busy) throw new Error("このDirectorは実行中です。");
    this.busy = true; this.stopped = false; this.project = project;
    try {
      const template = await app.graphToPrompt();
      const output = resultNode(template, this.node.id);
      let { batch } = await projectRequest(project, resume ? "resume" : "start", { ids, owner: this.owner, result_node: output,
        turbo: this.node.properties.h3_batch_turbo ?? {},
        ...(startIndex !== null ? { start_index: startIndex } : {}) });
      while (!this.stopped && !["complete", "error", "stopped"].includes(batch.status)) {
        this.notify(batchProgress(batch));
        if (batch.status === "ready") {
          ({ batch } = await projectRequest(project, "next", { owner: this.owner }));
          if (this.stopped) break;
          this.notify(batchProgress(batch));
          let submitting = false;
          try {
            const record = await projectRequest(project, "load", { id: batch.ids[batch.completed.length] });
            if (this.stopped) break;
            const value = sceneRequest(template, this.node.id, record, batch.attempt, true, batch.turbo ?? {});
            submitting = true;
            await submitScene(value, batch.attempt.prompt_id);
          }
          catch (e) {
            // A lost response may still have queued the job. Keep its UUID for reconciliation.
            if (!submitting || e.rejected) await projectRequest(project, "fail", { prompt_id: batch.attempt.prompt_id, error: e.message });
            this.notify(batchProgress({ ...batch, status: "error", error: e.message }));
            throw e;
          }
          if (this.stopped) {
            await cancelPrompt(batch.attempt.prompt_id);
            await projectRequest(project, "stop");
            break;
          }
        }
        await wait();
        ({ batch } = await projectRequest(project, "status"));
      }
      if (this.stopped) ({ batch } = await projectRequest(project, "status"));
      this.notify(batchProgress(batch));
      return batch;
    } finally { this.busy = false; this.project = null; }
  }

  async stop() {
    this.stopped = true;
    if (this.project) await projectRequest(this.project, "stop");
    else if (this.node.properties.h3_pending) {
      const { prompt_id } = this.node.properties.h3_pending;
      await cancelPrompt(prompt_id);
    }
    this.notify("中止を要求しました。実行中の処理が停止するまでお待ちください。");
  }
}

async function cancelPrompt(prompt_id) {
  await api.fetchApi("/queue", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ delete: [prompt_id] }) });
  await api.fetchApi("/interrupt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt_id }) });
}

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { applyPromotedWidgetControl } from "../../scripts/promotedWidgetControl.js";

export async function projectRequest(project, action, values = {}) {
  const response = await api.fetchApi("/h3_scene_director/project", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project, action, ...values }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "プロジェクトの操作に失敗しました。");
  return result;
}

export function sceneRequest(template, directorId, record, attempt, currentSettings) {
  const value = JSON.parse(JSON.stringify(template));
  const inputs = value.output[String(directorId)]?.inputs;
  if (!inputs) throw new Error("Directorが実行グラフにありません。");
  Object.assign(inputs, { plan_json: JSON.stringify(record.plan), scene_json: JSON.stringify(record.scene), run_name: attempt.run_name, use_current_settings: currentSettings });
  const node = value.workflow.nodes.find(n => String(n.id) === String(directorId));
  node.widgets_values = [inputs.run_name, inputs.plan_json, inputs.scene_json, currentSettings];
  if (node.widgets_values_named) Object.assign(node.widgets_values_named, { run_name: inputs.run_name, plan_json: inputs.plan_json, scene_json: inputs.scene_json, use_current_settings: currentSettings });
  return value;
}

export async function submitScene(value, promptId) {
  const response = await api.fetchApi("/prompt", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt_id: promptId, prompt: value.output, client_id: api.clientId, extra_data: { extra_pnginfo: { workflow: value.workflow } } }) });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error((result.error?.message ?? "生成を開始できませんでした。") + " " + JSON.stringify(result.node_errors ?? {}));
    error.rejected = true; throw error;
  }
  return result.prompt_id;
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

  async batch(project, ids, resume = false) {
    if (this.busy) throw new Error("このDirectorは実行中です。");
    this.busy = true; this.stopped = false; this.project = project;
    try {
      const template = await app.graphToPrompt();
      const output = resultNode(template, this.node.id);
      let { batch } = await projectRequest(project, resume ? "resume" : "start", { ids, owner: this.owner, result_node: output });
      while (!this.stopped && !["complete", "error", "stopped"].includes(batch.status)) {
        this.notify(`一括生成：${batch.completed.length} / ${batch.ids.length} シーン完了${batch.attempt ? "・生成中" : ""}`);
        if (batch.status === "ready") {
          ({ batch } = await projectRequest(project, "next", { owner: this.owner }));
          if (this.stopped) break;
          const record = await projectRequest(project, "load", { id: batch.ids[batch.completed.length] });
          if (this.stopped) break;
          const value = sceneRequest(template, this.node.id, record, batch.attempt, true);
          try { await submitScene(value, batch.attempt.prompt_id); }
          catch (e) {
            // A lost response may still have queued the job. Keep its UUID for reconciliation.
            if (e.rejected) await projectRequest(project, "fail", { prompt_id: batch.attempt.prompt_id, error: e.message });
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
      this.notify(batch.status === "complete" ? `一括生成完了：${batch.completed.length} シーン` : batch.error || "一括生成を停止しました。");
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

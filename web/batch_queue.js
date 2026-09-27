import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

class SceneBatchQueue {
  pending = null;
  completed = 0;
  timer = null;
  refreshId = 0;

  constructor(node) {
    this.node = node;
    const widget = (name) => node.widgets.find((item) => item.name === name);
    this.index = widget("start_at");
    this.manifest = widget("manifest_path");
    this.root = widget("image_root");
    this.auto = widget("auto_queue");
    this.index.type = "hidden";
    this.index.computeSize = () => [0, -4];
    this.start = node.addWidget("number", "開始シーン（1から）", this.index.value + 1, (value) => {
      this.index.value = Math.max(0, Math.trunc(value) - 1);
      this.start.value = this.index.value + 1;
      this.completed = 0;
      clearTimeout(this.timer);
      this.show(`待機：${this.start.value} / ${this.count.value}`);
    }, { min: 1, step: 10, precision: 0, serialize: false });
    this.count = node.addWidget("text", "総シーン数", "未取得", () => {}, { serialize: false });
    this.progress = node.addWidget("text", "進捗", "待機", () => {}, { serialize: false });
    this.count.disabled = this.progress.disabled = true;
    node.addWidget("button", "件数を更新", null, () => this.refresh(), { serialize: false });
    const changed = this.manifest.callback;
    this.manifest.callback = (...args) => {
      changed?.apply(this.manifest, args);
      this.completed = 0;
      clearTimeout(this.timer);
      this.refresh();
    };
    this.listeners = {
      executed: ({ detail }) => this.executed(detail),
      execution_success: ({ detail }) => this.finish(detail, true),
      execution_error: ({ detail }) => this.finish(detail, false),
      execution_interrupted: ({ detail }) => this.finish(detail, false),
      reconnecting: () => {
        clearTimeout(this.timer);
        if (this.pending) this.show(`接続切断：${this.pending.index + 1} 番目の完了は未確認`);
        this.pending = null;
      },
    };
    for (const [event, listener] of Object.entries(this.listeners)) api.addEventListener(event, listener);
    queueMicrotask(() => this.configure());
  }

  show(text) {
    this.progress.value = `${text} ／ 今回完了 ${this.completed} 件`;
    this.node.setDirtyCanvas(true, true);
  }

  configure() {
    this.start.value = this.index.value + 1;
    const size = this.node.computeSize();
    this.node.setSize([Math.max(this.node.size[0], size[0]), Math.max(this.node.size[1], size[1])]);
    this.refresh();
  }

  async refresh() {
    const id = ++this.refreshId;
    const path = this.manifest.value;
    if (!path) {
      this.count.value = "未取得";
      this.show("manifest_path を指定してください");
      return;
    }
    try {
      const response = await api.fetchApi("/h3_scene_batch/manifest_info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ manifest_path: path }),
      });
      const data = await response.json();
      if (id !== this.refreshId || path !== this.manifest.value) return;
      if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
      this.count.value = String(data.scene_count);
      if (!this.pending) this.show(`待機：${this.index.value + 1} / ${data.scene_count}`);
    } catch (error) {
      if (id !== this.refreshId || path !== this.manifest.value) return;
      this.count.value = "未取得";
      this.show(`件数取得失敗：${error.message}`);
    }
  }

  matches(run) {
    return this.node.graph === app.graph && this.node.mode === 0
      && this.manifest.value === run.manifest && this.root.value === run.root;
  }

  executed(detail) {
    if (String(detail.display_node ?? detail.node) !== String(this.node.id) || this.node.graph !== app.graph) return;
    const message = detail.output;
    const index = message?.start_at?.[0];
    const count = message?.scene_count?.[0];
    if (!detail.prompt_id || !Number.isInteger(index) || !Number.isInteger(count)) return;
    clearTimeout(this.timer);
    this.refreshId += 1;
    this.pending = {
      promptId: detail.prompt_id, index, count, scene: message.scene_id?.[0] ?? "",
      manifest: message.manifest_path?.[0], root: message.image_root?.[0],
    };
    this.count.value = String(count);
    this.show(`実行中：${index + 1} / ${count}（${this.pending.scene}）`);
  }

  finish(detail, success) {
    const run = this.pending;
    if (!run || run.promptId !== detail.prompt_id) return;
    this.pending = null;
    if (!success) {
      this.show(`停止：${run.index + 1} / ${run.count}（${run.scene}）／ 未完了`);
      return;
    }
    this.completed += 1;
    if (!this.matches(run) || this.index.value !== run.index) {
      this.show(`${run.index + 1} 番目完了／設定変更のため自動実行を停止`);
      return;
    }
    if (run.index + 1 === run.count) {
      this.show(`最終シーン完了：${run.count} / ${run.count}`);
      return;
    }
    this.index.value = run.index + 1;
    this.start.value = this.index.value + 1;
    this.show(`${run.index + 1} / ${run.count} 完了／次は ${this.start.value} 番目`);
    if (this.auto.value) {
      this.timer = setTimeout(async () => {
        if (!this.matches(run) || !this.auto.value || this.pending || this.index.value !== run.index + 1) return;
        try {
          await app.queuePrompt(0, 1);
        } catch (error) {
          this.show(`キュー登録失敗：${error.message}`);
        }
      }, 200);
    }
  }

  remove() {
    clearTimeout(this.timer);
    this.refreshId += 1;
    for (const [event, listener] of Object.entries(this.listeners)) api.removeEventListener(event, listener);
  }
}

app.registerExtension({
  name: "h3_scene_batch.queue",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "H3SceneBatchLoad") return;
    const created = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = created?.apply(this, arguments);
      this.h3BatchQueue = new SceneBatchQueue(this);
      return result;
    };
    const configured = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const result = configured?.apply(this, arguments);
      this.h3BatchQueue?.configure();
      return result;
    };
    const removed = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      this.h3BatchQueue?.remove();
      return removed?.apply(this, arguments);
    };
  },
});

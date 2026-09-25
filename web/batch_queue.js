import { app } from "../../scripts/app.js";

app.registerExtension({
  name: "h3_scene_batch.queue",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "H3SceneBatchLoad") return;
    const original = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      original?.apply(this, arguments);
      const startAt = message.start_at?.[0];
      const count = message.scene_count?.[0];
      if (!Number.isInteger(startAt) || !Number.isInteger(count)) return;
      const index = this.widgets.find((widget) => widget.name === "start_at");
      const autoQueue = this.widgets.find((widget) => widget.name === "auto_queue");
      if (startAt + 1 < count) {
        index.value = startAt + 1;
        if (autoQueue.value) setTimeout(() => app.queuePrompt(0, 1), 200);
      } else {
        index.value = 0;
      }
      app.graph.setDirtyCanvas(true, true);
    };
  },
});

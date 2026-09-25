import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

app.registerExtension({
  name: "h3_scene_batch.capture",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "H3SceneCapture") return;
    const original = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = original?.apply(this, arguments);
      this.addWidget("button", "直前の成功シーンを保存", null, async () => {
        const value = (name) => this.widgets.find((widget) => widget.name === name)?.value;
        try {
          const response = await api.fetchApi("/h3_scene_batch/save_latest", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ project_dir: value("project_dir") }),
          });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || `Save failed (${response.status})`);
          app.ui.dialog.show(`${data.scene_id} を保存しました: ${data.path}\n画像 ${data.images} 枚`);
        } catch (error) {
          app.ui.dialog.show(error.message);
        }
      }, { serialize: false });
      return result;
    };
  },
});

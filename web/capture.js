import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

function confirmDuplicate(sceneIds) {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    const message = document.createElement("p");
    message.textContent = `同じ内容のシーン（${sceneIds.join("、")}）が保存済みです。もう一度保存しますか？`;
    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;justify-content:flex-end;gap:12px";
    for (const [label, value] of [["キャンセル", "cancel"], ["保存", "save"]]) {
      const button = document.createElement("button");
      button.textContent = label;
      button.addEventListener("click", () => dialog.close(value));
      actions.append(button);
    }
    dialog.style.cssText = "max-width:520px;padding:24px;border:1px solid #777;border-radius:8px;background:var(--comfy-menu-bg,#222);color:var(--input-text,#eee)";
    dialog.append(message, actions);
    dialog.addEventListener("close", () => {
      const confirmed = dialog.returnValue === "save";
      dialog.remove();
      resolve(confirmed);
    }, { once: true });
    document.body.append(dialog);
    dialog.showModal();
  });
}

app.registerExtension({
  name: "h3_scene_batch.capture",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "H3SceneCapture") return;
    const original = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = original?.apply(this, arguments);
      const notify = (severity, summary, detail) => app.extensionManager.toast.add({ severity, summary, detail, life: severity === "error" ? 8000 : 5000 });
      const request = async (action, fields = {}) => {
        const response = await api.fetchApi(`/h3_scene_batch/${action}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ project_dir: this.widgets.find((widget) => widget.name === "project_dir")?.value, ...fields }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
        return data;
      };
      let saving = false;
      const save = this.addWidget("button", "直前の成功シーンを保存", null, async () => {
        if (saving) return;
        saving = true;
        const previousName = save.name;
        save.name = "保存中…";
        this.setDirtyCanvas(true, true);
        try {
          const project_dir = this.widgets.find((widget) => widget.name === "project_dir")?.value;
          let data = await request("save_latest", { project_dir });
          if (data.duplicates) {
            save.name = "保存の確認中…";
            this.setDirtyCanvas(true, true);
            if (!await confirmDuplicate(data.duplicates)) {
              save.name = previousName;
              return;
            }
            data = await request("save_latest", { project_dir, confirm_fingerprint: data.fingerprint });
          }
          save.name = `${data.scene_id} 保存済み ／ 次の成功シーンを保存`;
          notify("success", `${data.scene_id} を保存しました`, `画像 ${data.images} 枚、音声・動画の参照 ${data.media} 件\n${data.path}`);
        } catch (error) {
          save.name = previousName;
          notify("error", "シーンを保存できませんでした", error.message);
        } finally {
          saving = false;
          this.setDirtyCanvas(true, true);
        }
      }, { serialize: false });
      this.addWidget("button", "保存先フォルダを開く", null, async () => {
        try {
          await request("open_folder");
        } catch (error) {
          notify("error", "フォルダを開けませんでした", error.message);
        }
      }, { serialize: false });
      return result;
    };
  },
});

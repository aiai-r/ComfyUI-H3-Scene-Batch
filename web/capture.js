import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

function confirmDuplicate(sceneIds) {
  return confirmDialog(`同じ内容のシーン（${sceneIds.join("、")}）が保存済みです。もう一度保存しますか？`, "保存");
}

function confirmDialog(text, okLabel) {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    const message = document.createElement("p");
    message.textContent = text;
    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;justify-content:flex-end;gap:12px";
    for (const [label, value] of [["キャンセル", "cancel"], [okLabel, "save"]]) {
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
      const saveLabel = (cuts) => cuts > 1 ? `採用済み ${cuts} カットをシーンとして保存` : cuts === 1 ? "採用済みカットをシーンとして保存" : "直前の成功シーンを保存";
      const status = this.addWidget("text", "カット", "—", () => {}, { serialize: false });
      status.options.read_only = true;
      status.onClick = () => {};
      status.mouse = () => true;
      status.h3SceneOnly = true;
      status.h3CutOnly = true;
      let draftId = 0;
      const refreshDraft = async () => {
        if (!this.properties?.h3_cuts) return;
        const id = ++draftId;
        const project_dir = this.widgets.find((widget) => widget.name === "project_dir")?.value;
        if (!project_dir?.trim()) {
          status.value = "保存先フォルダ未指定";
          save.name = saveLabel(0);
          this.setDirtyCanvas(true, true);
          return;
        }
        try {
          const data = await request("draft_info", { project_dir });
          if (id !== draftId) return;
          status.value = data.cut_count ? `採用済み ${data.cut_count} ／ 次はカット ${data.cut_count + 1}` : "採用なし ／ 次はカット 1";
          save.name = saveLabel(data.cut_count);
        } catch (error) {
          if (id !== draftId) return;
          status.value = `取得失敗：${error.message}`;
        }
        this.setDirtyCanvas(true, true);
      };
      this.h3RefreshDraft = refreshDraft;
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
          const cuts = data.cuts > 1 ? `${data.cuts} カット、` : "";
          notify("success", `${data.scene_id} を保存しました`, `${cuts}画像 ${data.images} 枚、音声・動画の参照 ${data.media} 件\n${data.path}`);
          await refreshDraft();
        } catch (error) {
          save.name = previousName;
          notify("error", "シーンを保存できませんでした", error.message);
        } finally {
          saving = false;
          this.setDirtyCanvas(true, true);
        }
      }, { serialize: false });
      save.h3SceneOnly = true;
      let adopting = false;
      const adopt = this.addWidget("button", "直前の成功結果をカットとして採用", null, async () => {
        if (adopting) return;
        adopting = true;
        try {
          const project_dir = this.widgets.find((widget) => widget.name === "project_dir")?.value;
          const data = await request("adopt_latest", { project_dir });
          notify("success", `カット ${data.cut_count} を採用しました`, "次のカットの指示を書いて実行してください。");
        } catch (error) {
          notify("error", "カットを採用できませんでした", error.message);
        } finally {
          adopting = false;
          await refreshDraft();
        }
      }, { serialize: false });
      adopt.h3SceneOnly = true;
      adopt.h3CutOnly = true;
      const discard = this.addWidget("button", "採用済みカットを破棄", null, async () => {
        if (!await confirmDialog("採用済みのカットをすべて破棄して、カット 1 からやり直しますか？", "破棄")) return;
        try {
          const project_dir = this.widgets.find((widget) => widget.name === "project_dir")?.value;
          await request("discard_draft", { project_dir });
          notify("success", "採用済みカットを破棄しました", "次の実行はカット 1 になります。");
        } catch (error) {
          notify("error", "破棄できませんでした", error.message);
        }
        await refreshDraft();
      }, { serialize: false });
      discard.h3SceneOnly = true;
      discard.h3CutOnly = true;
      const project = this.widgets.find((widget) => widget.name === "project_dir");
      const projectChanged = project.callback;
      project.callback = (...args) => {
        projectChanged?.apply(project, args);
        refreshDraft();
      };
      this.addWidget("button", "保存先フォルダを開く", null, async () => {
        try {
          await request("open_folder");
        } catch (error) {
          notify("error", "フォルダを開けませんでした", error.message);
        }
      }, { serialize: false });
      return result;
    };
    const configured = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const result = configured?.apply(this, arguments);
      queueMicrotask(() => {
        this.h3BatchQueue?.updateVisibility();
        this.h3RefreshDraft?.();
      });
      return result;
    };
  },
});

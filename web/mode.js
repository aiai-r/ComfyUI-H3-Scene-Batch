import { app } from "../../scripts/app.js";

const modes = { "シーン作成": "scene", "バッチ生成": "batch" };

export function switchSceneMode(control, mode) {
  const config = control.properties.scene_batch;
  if (!config) throw new Error("切替対応の video_minimax_h3_r2v_scene_batch.json を開いてください。");
  if (config.mode === mode) return;
  const graph = control.graph;
  const routes = config.routes.map((route) => {
    const target = graph.getNodeById(route.target);
    const slot = target?.inputs.findIndex((input) => input.name === route.input);
    if (!target || slot < 0) throw new Error(`切替先が見つかりません: ${route.target} / ${route.input}`);
    const source = route[mode];
    if (source && !graph.getNodeById(source[0])?.outputs[source[1]]) {
      throw new Error(`切替元が見つかりません: ${source[0]}`);
    }
    return { route, target, slot, source };
  });
  graph.beforeChange();
  try {
    for (const { route, target, slot, source } of routes) {
      const link = graph.links[target.inputs[slot].link];
      route[config.mode] = link ? [link.origin_id, link.origin_slot] : null;
      target.disconnectInput(slot);
      if (source) graph.getNodeById(source[0]).connect(source[1], target, slot);
    }
    for (const [name, nodeModes] of Object.entries(config.node_modes)) {
      for (const id of Object.keys(nodeModes)) {
        const node = graph.getNodeById(Number(id));
        if (!node) continue;
        if (name === config.mode) nodeModes[id] = node.mode;
        node.mode = name === mode ? nodeModes[id] : 4;
      }
    }
    config.mode = mode;
    graph.setDirtyCanvas(true, true);
  } finally {
    graph.afterChange();
  }
}

app.registerExtension({
  name: "h3_scene_batch.mode",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "H3SceneCapture") return;
    const configured = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const result = configured?.apply(this, arguments);
      if (!this.properties.scene_batch) return result;
      let widget = this.widgets?.find((item) => item.name === "実行モード");
      if (!widget) {
        widget = this.addWidget("combo", "実行モード", "バッチ生成", (label) => {
          try {
            switchSceneMode(this, modes[label]);
          } catch (error) {
            app.ui.dialog.show(error.message);
            widget.value = this.properties.scene_batch.mode === "scene" ? "シーン作成" : "バッチ生成";
          }
        }, { values: Object.keys(modes), serialize: false });
      }
      widget.value = this.properties.scene_batch.mode === "scene" ? "シーン作成" : "バッチ生成";
      return result;
    };
  },
});

import { app } from "../../scripts/app.js";

const modes = { "シーン作成": "scene", "バッチ生成": "batch" };

function nodeById(graph, id) {
  return graph.getNodeById(id) ?? graph.getNodeById(Number(id));
}

function batchSlot(name) {
  const fixed = { prompt: 0, noise_seed: 1, value_1: 2, filename_prefix: 12 };
  if (name in fixed) return fixed[name];
  for (const [prefix, offset, count] of [
    ["ref_images.ref_image_", 3, 9], ["ref_audios.ref_audio_", 13, 3],
    ["ref_videos.ref_video_", 16, 3], ["ref_video_audios.ref_video_audio_", 19, 3],
  ]) {
    if (!name.startsWith(prefix)) continue;
    const index = Number(name.slice(prefix.length));
    if (Number.isInteger(index) && index >= 0 && index < count) return offset + index;
  }
  return null;
}

function sceneConfig(control) {
  if (control.properties.scene_batch) return control.properties.scene_batch;
  const graph = control.graph;
  const routes = [];
  for (const id of [817, 92]) {
    const node = nodeById(graph, id);
    if (!node) throw new Error(`切替先が見つかりません: ${id}`);
    for (const input of node.inputs) {
      const slot = batchSlot(input.name);
      if (slot === null) continue;
      const link = graph.links[input.link];
      routes.push({ target: node.id, input: input.name, scene: link ? [link.origin_id, link.origin_slot] : null });
    }
  }
  return {
    mode: "scene", routes,
    node_modes: {
      scene: Object.fromEntries([822, 224, 805].map((id) => nodeById(graph, id)).filter(Boolean).map((node) => [node.id, node.mode])),
      batch: {},
    },
  };
}

export function switchSceneMode(control, mode) {
  const config = sceneConfig(control);
  const graph = control.graph;
  const routes = config.routes.map((route) => {
    const target = nodeById(graph, route.target);
    const slot = target?.inputs.findIndex((input) => input.name === route.input);
    if (!target || slot < 0) throw new Error(`切替先が見つかりません: ${route.target} / ${route.input}`);
    const batch = [control.id, batchSlot(route.input)];
    const source = mode === "batch" ? batch : route.scene;
    if (source && !nodeById(graph, source[0])?.outputs[source[1]]) {
      throw new Error(`切替元が見つかりません: ${source[0]}`);
    }
    return { route, target, slot, source, batch };
  });
  graph.beforeChange();
  try {
    for (const { route, target, slot, source, batch } of routes) {
      if (config.mode !== mode) {
        const link = graph.links[target.inputs[slot].link];
        route[config.mode] = link ? [link.origin_id, link.origin_slot] : null;
      }
      route.batch = batch;
      if (config.mode !== mode || mode === "batch") {
        target.disconnectInput(slot);
        if (source) nodeById(graph, source[0]).connect(source[1], target, slot);
      }
    }
    for (const [id, savedMode] of Object.entries(config.node_modes.scene)) {
      const node = nodeById(graph, id);
      if (!node) continue;
      if (config.mode === "scene") config.node_modes.scene[id] = node.mode;
      node.mode = mode === "scene" ? config.node_modes.scene[id] : 4;
    }
    for (const id of Object.keys(config.node_modes.batch)) {
      const node = nodeById(graph, id);
      if (node && node !== control) node.mode = 4;
    }
    config.node_modes.batch = {};
    config.mode = mode;
    control.properties.scene_batch = config;
    control.widgets.find((item) => item.name === "execution_mode").value = mode === "batch" ? "バッチ生成" : "シーン作成";
    graph.setDirtyCanvas(true, true);
  } finally {
    graph.afterChange();
  }
}

function configureControl(control, nodeData) {
  const mode = control.widgets.find((item) => item.name === "execution_mode");
  if (!mode) return;
  mode.label = "実行モード";
  for (let slot = control.outputs?.length ?? 0; slot < nodeData.output.length; slot++) {
    control.addOutput(nodeData.output_name[slot], nodeData.output[slot]);
  }
  if (!control.properties.h3_unified_controls) {
    const config = control.properties.scene_batch;
    const loader = Object.keys(config?.node_modes.batch ?? {}).map((id) => nodeById(control.graph, id)).find((node) => node?.type === "H3SceneBatchLoad");
    if (loader) {
      for (const name of ["start_at", "auto_queue"]) {
        const saved = loader.widgets.find((item) => item.name === name);
        if (saved) control.widgets.find((item) => item.name === name).value = saved.value;
      }
    }
    if (config) mode.value = config.mode === "batch" ? "バッチ生成" : "シーン作成";
    control.properties.h3_unified_controls = true;
  }
  if (mode.value === "バッチ生成") switchSceneMode(control, "batch");
  control.h3BatchQueue?.configure();
  const size = control.computeSize();
  control.setSize([Math.max(control.size[0], size[0]), Math.max(control.size[1], size[1])]);
}

app.registerExtension({
  name: "h3_scene_batch.mode",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "H3SceneCapture") return;
    const created = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = created?.apply(this, arguments);
      const widget = this.widgets.find((item) => item.name === "execution_mode");
      widget.label = "実行モード";
      widget.callback = (label) => {
        const previous = this.properties.scene_batch?.mode ?? "scene";
        try {
          if (this.h3BatchQueue?.pending) throw new Error("実行を停止してからモードを切り替えてください。");
          switchSceneMode(this, modes[label]);
        } catch (error) {
          widget.value = previous === "batch" ? "バッチ生成" : "シーン作成";
          app.extensionManager.toast.add({ severity: "error", summary: "モードを切り替えられませんでした", detail: error.message, life: 8000 });
        }
      };
      return result;
    };
    const configured = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const result = configured?.apply(this, arguments);
      queueMicrotask(() => {
        if (this.graph) configureControl(this, nodeData);
      });
      return result;
    };
  },
});

import { app } from "../../scripts/app.js";

const widget = (node, name) => node.widgets.find((item) => item.name === name);
const nodeById = (graph, id) => graph.getNodeById(id) ?? graph.getNodeById(Number(id));
const isLink = (value) => Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "number";

export function batchPrompt(output, control) {
  const graph = structuredClone(output);
  const refs = graph["817:136"]?.inputs;
  if (!refs || !graph["817:129"] || !graph["817:819"] || !graph["92"]) {
    throw new Error("H3生成・seed・長さ・動画保存の構成が見つかりません。");
  }
  const project = widget(control, "project_dir").value.replace(/[\\/]+$/, "");
  if (!project) throw new Error("project_dir を指定してください。");
  const loader = String(control.id);
  graph[loader] = { class_type: "H3SceneBatchLoad", inputs: {
    manifest_path: project + "/scenes.json", image_root: project + "/images",
    start_at: widget(control, "start_at").value, auto_queue: widget(control, "auto_queue").value,
  } };
  refs.prompt = [loader, 0];
  graph["817:129"].inputs.noise_seed = [loader, 1];
  graph["817:819"].inputs.value = [loader, 2];
  for (let index = 0; index < 9; index++) {
    const id = `${loader}:batch_image_${index}`;
    graph[id] = { class_type: "H3SceneImagePath", inputs: { path: [loader, 3 + index] } };
    refs[`ref_images.ref_image_${index}`] = [id, 0];
  }
  let slot = 13;
  for (const [group, name] of [["ref_audios", "ref_audio"], ["ref_videos", "ref_video"], ["ref_video_audios", "ref_video_audio"]]) {
    for (let index = 0; index < 3; index++) refs[`${group}.${name}_${index}`] = [loader, slot++];
  }
  graph["92"].inputs.filename_prefix = [loader, 12];
  const needed = {};
  function visit(id) {
    if (needed[id]) return;
    const node = graph[id];
    if (!node) throw new Error(`バッチ生成の接続先が見つかりません: ${id}`);
    needed[id] = node;
    for (const value of Object.values(node.inputs)) if (isLink(value)) visit(value[0]);
  }
  visit("92");
  return needed;
}

function restoreCapture(control) {
  const graph = control.graph;
  const config = control.properties.scene_batch;
  if (config) {
    const loader = Object.keys(config.node_modes.batch ?? {}).map((id) => nodeById(graph, id)).find((node) => node?.type === "H3SceneBatchLoad");
    if (!control.properties.h3_unified_controls && loader) {
      for (const name of ["start_at", "auto_queue"]) widget(control, name).value = widget(loader, name).value;
      widget(control, "execution_mode").value = config.mode === "batch" ? "バッチ生成" : "シーン作成";
    }
    if (config.mode === "batch") {
      for (const route of config.routes) {
        const target = nodeById(graph, route.target);
        const slot = target?.inputs.findIndex((input) => input.name === route.input);
        if (!target || slot < 0) throw new Error(`元の接続先が見つかりません: ${route.target}`);
        const source = route.scene && nodeById(graph, route.scene[0]);
        if (route.scene && !source?.outputs[route.scene[1]]) throw new Error(`元の接続元が見つかりません: ${route.scene[0]}`);
      }
      for (const route of config.routes) {
        const target = nodeById(graph, route.target);
        const slot = target.inputs.findIndex((input) => input.name === route.input);
        target.disconnectInput(slot);
        if (route.scene) nodeById(graph, route.scene[0]).connect(route.scene[1], target, slot);
      }
      for (const [id, mode] of Object.entries(config.node_modes.scene)) {
        const node = nodeById(graph, id);
        if (node) node.mode = mode;
      }
    }
    for (const id of Object.keys(config.node_modes.batch ?? {})) {
      const node = nodeById(graph, id);
      if (node && node !== control) node.mode = 4;
    }
    delete control.properties.scene_batch;
  }
  while (control.outputs?.length) control.removeOutput(control.outputs.length - 1);
  delete control.properties.h3_unified_controls;
  control.h3BatchQueue?.configure();
  control.setSize(control.computeSize());
  control.setDirtyCanvas(true, true);
}

app.registerExtension({
  name: "h3_scene_batch.mode",
  setup() {
    const original = app.graphToPrompt;
    app.graphToPrompt = async function () {
      const result = await original.apply(this, arguments);
      const controls = (app.graph?._nodes ?? []).filter((node) => node.type === "H3SceneCapture" && node.mode === 0 && widget(node, "execution_mode")?.value === "バッチ生成");
      if (controls.length > 1) throw new Error("バッチ生成にするCaptureは1つにしてください。");
      if (controls.length === 1) result.output = batchPrompt(result.output, controls[0]);
      return result;
    };
  },
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "H3SceneCapture") return;
    const created = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = created?.apply(this, arguments);
      widget(this, "execution_mode").label = "実行モード";
      return result;
    };
    const configured = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const result = configured?.apply(this, arguments);
      queueMicrotask(() => {
        if (this.graph) restoreCapture(this);
      });
      return result;
    };
  },
});

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import {
  generationPrompt, scenePrompt, applySettings, changedSettings, configureGeneration,
  applyCuts, copyCutReferences, cutIds, cutInstructions, hasCuts,
  VIDEO_RUN, promptRun, promptOnly, useSavedPrompts,
} from "./generation.js";

const widget = (node, name) => node.widgets.find((item) => item.name === name);
const nodeById = (graph, id) => graph.getNodeById(id) ?? graph.getNodeById(Number(id));
const isLink = (value) => Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "number";

export function batchPrompt(output, control, saved = null) {
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
  const extraCuts = saved?.extra_cuts ?? [];
  if (hasCuts(graph)) {
    copyCutReferences(graph);
    extraCuts.forEach((cut, index) => {
      const ids = cutIds(index + 2);
      if (!graph[ids.cond]) throw new Error(`カット ${index + 2} の生成部分が見つかりません。`);
      graph[ids.cond].inputs.prompt = cut.prompt;
      graph[ids.seconds].inputs.value = cut.duration;
    });
  }
  if (saved) {
    graph[loader].inputs.generation_mode = saved.generation_mode;
    generationPrompt(graph, saved.generation_mode);
    const settings = structuredClone(saved.generation_settings ?? {});
    for (const [id, values] of Object.entries(changedSettings(control, saved.generation_mode))) {
      if (graph[id]) settings[id] = { ...settings[id], ...values };
    }
    applySettings(graph, settings);
  }
  const roots = applyCuts(graph, extraCuts.length + 1, saved?.generation_mode ?? "R2V");
  const needed = {};
  function visit(id) {
    if (needed[id]) return;
    const node = graph[id];
    if (!node) throw new Error(`バッチ生成の接続先が見つかりません: ${id}`);
    needed[id] = node;
    for (const value of Object.values(node.inputs)) if (isLink(value)) visit(value[0]);
  }
  for (const root of roots) visit(root);
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
  configureGeneration(control, app);
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
      if (controls.length === 1) {
        const control = controls[0];
        let saved = null;
        if (control.properties.h3_multimode) {
          const project = widget(control, "project_dir").value.replace(/[\\/]+$/, "");
          const response = await api.fetchApi("/h3_scene_batch/scene_config", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ manifest_path: project + "/scenes.json", start_at: widget(control, "start_at").value }),
          });
          saved = await response.json();
          if (!response.ok) throw new Error(saved.error);
        }
        result.output = batchPrompt(result.output, control, saved);
      } else {
        const control = app.graph?._nodes.find((node) => node.type === "H3SceneCapture" && node.mode === 0 && node.properties.h3_multimode);
        if (control) {
          const mode = control.properties.h3_multimode.mode;
          const count = control.properties.h3_cuts?.count ?? 1;
          result.output = scenePrompt(result.output, mode);
          cutInstructions(result.output, mode, count);
          const run = widget(control, "実行内容")?.value ?? VIDEO_RUN;
          if (control.properties.h3_cuts && run !== VIDEO_RUN) {
            const cut = [1, 2, 3, 4].find((item) => promptRun(item) === run);
            control.h3PromptRuns = promptOnly(result.output, cut, count, mode);
          } else {
            applyCuts(result.output, count, mode);
            control.h3PromptRuns = control.properties.h3_cuts
              ? useSavedPrompts(result.output, count, mode, control.properties.h3_cuts.prompts) : {};
          }
        } else if (hasCuts(result.output)) {
          applyCuts(result.output, 1, "R2V");
        }
      }
      return result;
    };
    // Remember each cut's generated prompt so later runs reuse it.
    api.addEventListener("executed", ({ detail }) => {
      const control = app.graph?._nodes.find((node) => node.type === "H3SceneCapture" && node.properties.h3_cuts);
      const id = String(detail.display_node ?? detail.node);
      const run = control?.h3PromptRuns?.[id];
      const text = detail.output?.text?.[0];
      if (!run || typeof text !== "string") return;
      (control.properties.h3_cuts.prompts ??= {})[run.cut] = { mode: run.mode, instruction: run.instruction, prompt: text };
      delete control.h3PromptRuns[id];
    });
  },
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "H3SceneCapture") return;
    const created = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = created?.apply(this, arguments);
      widget(this, "execution_mode").label = "実行モード";
      configureGeneration(this, app);
      return result;
    };
    const added = nodeType.prototype.onAdded;
    nodeType.prototype.onAdded = function () {
      const result = added?.apply(this, arguments);
      queueMicrotask(() => {
        if (this.graph) configureGeneration(this, app);
      });
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

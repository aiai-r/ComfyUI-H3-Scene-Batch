import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { generationPrompt, scenePrompt, applySettings, changedSettings, configureGeneration } from "./generation.js";

const widget = (node, name) => node.widgets.find((item) => item.name === name);
const nodeById = (graph, id) => graph.getNodeById(id) ?? graph.getNodeById(Number(id));
const isLink = (value) => Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "number";

// Cut chaining nodes inside the generation subgraph of the cut workflow.
const CUT = { context: "817:850", trim: "817:851", load: "817:852", save: "817:853", guider: "817:126" };
const pad = (value) => String(value).padStart(2, "0");

function contextFrames(graph) {
  const value = graph[CUT.context]?.inputs.context_length;
  return Number.isInteger(value) ? value : 39;
}

function firstCut(graph) {
  graph[CUT.guider].inputs.conditioning = ["817:136", 0];
  graph[CUT.trim].inputs.trim_frames = 0;
  delete graph[CUT.context];
  delete graph[CUT.load];
}

function continueCut(graph, contextDir) {
  if (graph["817:136"].inputs.first_frame) throw new Error("2カット目以降の生成モードは R2V か L2V にしてください。");
  graph[CUT.load].inputs.context_dir = contextDir;
}

export async function cutScenePrompt(graph, control) {
  if (!graph[CUT.save]) return graph;
  const project = control ? widget(control, "project_dir").value.trim() : "";
  let draft = { cut_count: 0 };
  if (control?.properties.h3_cuts && project) {
    const response = await api.fetchApi("/h3_scene_batch/draft_info", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project_dir: project }),
    });
    draft = await response.json();
    if (!response.ok) throw new Error(draft.error);
  }
  graph[CUT.save].inputs.frames = contextFrames(graph);
  graph[CUT.save].inputs.context_dir = `h3_scene_context/runs/${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  if (!draft.cut_count) {
    firstCut(graph);
    return graph;
  }
  continueCut(graph, draft.context_dir);
  const seconds = (contextFrames(graph) / 24).toFixed(2);
  const note = `CONTINUATION CUT ${draft.cut_count + 1}: This video continues the previous cut directly, without a scene change. ` +
    `Its first ${seconds} seconds are pinned to the last frames and sound of the previous cut, so start exactly where the previous cut ends: ` +
    `same subjects, positions, outfits, location, lighting, camera and ongoing sound. Do not re-introduce or re-establish the scene. ` +
    `The previous cut's final prompt is given only for continuity; write this cut from the user's instructions.\n` +
    `<previous_cut_prompt>\n${draft.previous_prompt}\n</previous_cut_prompt>\n\n`;
  for (const [id, key] of [["822:492", "value"], ["822:803", "system_prompt"]]) {
    const inputs = graph[id]?.inputs;
    if (typeof inputs?.[key] === "string") inputs[key] = note + inputs[key];
  }
  return graph;
}

function batchCut(graph, loader, saved) {
  if (!graph[CUT.save]) return [];
  const cut = saved?.cut_index ?? 0;
  const count = saved?.cut_count ?? 1;
  const context = (index) => `h3_scene_context/batch/${saved.scene_id}/cut${pad(index + 1)}`;
  graph[loader].inputs.cut_index = cut;
  if (cut === 0) firstCut(graph);
  else continueCut(graph, context(cut - 1));
  if (cut === count - 1) {
    delete graph[CUT.save];
  } else {
    graph[CUT.save].inputs.frames = contextFrames(graph);
    graph[CUT.save].inputs.context_dir = context(cut);
    return [CUT.save];
  }
  if (count === 1) return [];
  const join = `${loader}:join_cuts`;
  graph[join] = { class_type: "H3SceneJoinCuts", inputs: {
    video: graph["92"].inputs.video, cut_prefix: `h3_scenes/${saved.scene_id}/cut`, cut_count: count,
    cleanup_dir: `h3_scene_context/batch/${saved.scene_id}`,
  } };
  graph[`${loader}:save_scene`] = { class_type: "SaveVideo", inputs: {
    ...graph["92"].inputs, video: [join, 0], filename_prefix: `h3_scenes/${saved.scene_id}`,
  } };
  return [`${loader}:save_scene`];
}

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
  if (saved) {
    graph[loader].inputs.generation_mode = saved.generation_mode;
    generationPrompt(graph, saved.generation_mode);
    const settings = structuredClone(saved.generation_settings ?? {});
    for (const [id, values] of Object.entries(changedSettings(control, saved.generation_mode))) {
      if (graph[id]) settings[id] = { ...settings[id], ...values };
    }
    applySettings(graph, settings);
  }
  const roots = ["92", ...batchCut(graph, loader, saved)];
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
            body: JSON.stringify({ manifest_path: project + "/scenes.json", start_at: widget(control, "start_at").value, cut_index: control.h3BatchQueue?.cut ?? 0 }),
          });
          saved = await response.json();
          if (!response.ok) throw new Error(saved.error);
        }
        result.output = batchPrompt(result.output, control, saved);
      } else {
        const control = app.graph?._nodes.find((node) => node.type === "H3SceneCapture" && node.mode === 0 && node.properties.h3_multimode);
        if (control) result.output = scenePrompt(result.output, control.properties.h3_multimode.mode);
        result.output = await cutScenePrompt(result.output, control);
      }
      return result;
    };
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

const widget = (node, name) => node.widgets?.find((item) => item.name === name);
const MODES = ["R2V", "I2V", "L2V", "FL2V"];
const modelWidgets = ["unet_name", "lora_name", "strength_model", "lora_name_1", "strength_model_1", "value"];
const modelInputs = {
  unet_name: ["817:807", "unet_name"],
  lora_name: ["817:808", "lora_name"], strength_model: ["817:808", "strength_model"],
  lora_name_1: ["817:824", "lora_name"], strength_model_1: ["817:824", "strength_model"],
  value: ["817:812", "value"],
};

export function changedSettings(control, mode) {
  const config = control.properties.h3_multimode;
  if (!config?.settingsBaseline) return {};
  const family = mode === "R2V" ? "R2V" : "FL2V";
  const activeFamily = config.mode === "R2V" ? "R2V" : "FL2V";
  const generator = control.graph.getNodeById(817);
  const changes = {};
  for (const [name, [id, input]] of Object.entries(modelInputs)) {
    const value = family === activeFamily ? widget(generator, name)?.value : config.models[family][name];
    if (value !== undefined && value !== config.settingsBaseline[family][name]) {
      (changes[id] ??= {})[input] = value;
    }
  }
  return changes;
}

export function generationPrompt(graph, mode) {
  if (!MODES.includes(mode)) throw new Error(`Unknown H3 mode: ${mode}`);
  const node = graph["817:136"];
  const refs = node.inputs;
  node._meta = { ...node._meta, h3_multimode: true };
  if (mode === "R2V") return graph;
  const images = [refs["ref_images.ref_image_0"], refs["ref_images.ref_image_1"]];
  if (!images[0] || (mode === "FL2V" && !images[1])) throw new Error(`${mode}: 必要な画像を有効にしてください。`);
  node.class_type = "MiniMaxH3ImageToVideo";
  node.inputs = Object.fromEntries(["clip", "vae", "prompt", "width", "height", "length"].map((key) => [key, refs[key]]));
  if (mode !== "L2V") node.inputs.first_frame = images[0];
  if (mode !== "I2V") node.inputs.last_frame = images[mode === "FL2V" ? 1 : 0];
  return graph;
}

// Image input for the LLM in I2V/L2V/FL2V: image 1, or images 1 and 2 for FL2V.
function modeImages(graph, mode) {
  const refs = graph["817:136"]?.inputs ?? {};
  const first = refs["ref_images.ref_image_0"] ?? (graph["600"] ? ["600", 0] : undefined);
  if (mode !== "FL2V") return first;
  const second = refs["ref_images.ref_image_1"] ?? (graph["601"] ? ["601", 0] : undefined);
  graph["830:scene_images"] = { class_type: "ImageTensorList", inputs: { image1: first, image2: second } };
  return ["830:scene_images", 0];
}

function frameLLM(graph, llm, title, instruction, images) {
  for (const id of [`${llm}:210`, `${llm}:803`]) {
    if (graph[id] && images !== undefined) graph[id].inputs.images = images;
  }
  for (const id of [`${llm}:492`, `${llm}:803`]) {
    const inputs = graph[id]?.inputs;
    const key = id.endsWith(":492") ? "value" : "system_prompt";
    if (typeof inputs?.[key] === "string") {
      inputs[key] = `Generate a MiniMax H3 ${title}. ${instruction} No reference audio is supplied. Do not use R2V subject_definitions or retention_analysis. Preserve the user's action, dialogue, duration and sound instructions. Use summary, detailed_description with timed shots, overall_soundscape and non_diegetic_music.\n\n` +
        (id.endsWith(":803") ? inputs[key] : "Describe the visible first/last frames accurately and respect their assigned time positions.");
    }
  }
}

const FRAME_TEXT = {
  I2V: "Image 1 is the exact first frame at 0 seconds.",
  L2V: "Image 1 is the exact last frame at the end of the video. Build the action toward it.",
  FL2V: "Image 1 is the exact first frame; Image 2 is the exact last frame. Connect these endpoints in order.",
};

export function scenePrompt(output, mode) {
  const graph = structuredClone(output);
  if (!graph["817:136"]) throw new Error("H3生成の構成が見つかりません。対応するシーン作成ワークフローを読み込んでください。");
  if (mode !== "R2V") frameLLM(graph, "822", `${mode} video prompt`, FRAME_TEXT[mode], modeImages(graph, mode));
  return generationPrompt(graph, mode);
}

// Cuts 2-4 of the cut workflow: generation nodes inside 817 (chained like the
// MultiRef AV Extension), instruction / prompt preview / seconds at the root.
const EXTRA_CUTS = [2, 3, 4];
const STREAM = "817:931";
const START = "817:930";

export const cutIds = (cut) => ({
  cond: `817:${cut}000`, length: `817:${cut}001`, context: `817:${cut}002`, noise: `817:${cut}003`,
  guider: `817:${cut}004`, sampler: `817:${cut}005`, llm: `95${cut}`, preview: `96${cut}`, seconds: `97${cut}`,
});

export const hasCuts = (graph) => Boolean(graph[STREAM]);

export function copyCutReferences(graph) {
  const refs = graph["817:136"].inputs;
  for (const cut of EXTRA_CUTS) {
    const node = graph[cutIds(cut).cond];
    if (!node) continue;
    for (const [key, value] of Object.entries(refs)) if (key.startsWith("ref_")) node.inputs[key] = value;
  }
}

function convertCut(node, mode, last) {
  if (mode === "R2V") return;
  const refs = node.inputs;
  const images = [refs["ref_images.ref_image_0"], refs["ref_images.ref_image_1"]];
  node.class_type = "MiniMaxH3ImageToVideo";
  node.inputs = Object.fromEntries(["clip", "vae", "prompt", "width", "height", "length"].map((key) => [key, refs[key]]));
  if (last && mode !== "I2V") node.inputs.last_frame = images[mode === "FL2V" ? 1 : 0];
}

// LLM instructions of every cut LLM present in the graph (cut workflow, I2V/L2V/FL2V).
export function cutLLMs(graph, mode, count) {
  if (mode === "R2V") return;
  const images = modeImages(graph, mode);
  const reference = " The supplied images are visual references only, not frames.";
  const first = count === 1 ? FRAME_TEXT[mode]
    : mode === "L2V" ? reference.trim()
    : mode === "FL2V" ? "Image 1 is the exact first frame at 0 seconds. Image 2 is a visual reference only, not a frame."
    : FRAME_TEXT.I2V;
  frameLLM(graph, "822", `${mode} video prompt`, first, images);
  for (const cut of EXTRA_CUTS) {
    const instruction = "This cut continues directly from the end of the previous cut; its opening frames are the previous cut's final frames, so there is no first-frame image." +
      (cut === count && mode !== "I2V"
        ? ` Image ${mode === "FL2V" ? 2 : 1} is the exact last frame at the end of the video. Build the action toward it.`
        : reference);
    frameLLM(graph, cutIds(cut).llm, "video prompt for a continuation cut", instruction, images);
  }
}

// Keeps only the cuts in use and returns the output nodes to run.
export function applyCuts(graph, count, mode) {
  if (!hasCuts(graph)) {
    if (count > 1) throw new Error("複数カットのシーンは、カット連結版のワークフローで生成してください。");
    return ["92"];
  }
  if (count > EXTRA_CUTS.length + 1) throw new Error(`カット数は ${EXTRA_CUTS.length + 1} までです。`);
  for (const cut of EXTRA_CUTS.filter((item) => item > count)) {
    const ids = Object.values(cutIds(cut));
    for (const key of Object.keys(graph)) {
      if (ids.includes(key) || key.startsWith(`${cutIds(cut).llm}:`)) delete graph[key];
    }
  }
  if (count === 1) {
    delete graph[STREAM];
    delete graph[START];
    return ["92"];
  }
  const stream = graph[STREAM].inputs;
  stream.active_extensions = count - 1;
  stream.filename_prefix = graph["92"].inputs.filename_prefix;
  for (let index = count; index <= EXTRA_CUTS.length; index++) delete stream[`extension_${index}`];
  delete graph["92"];
  const used = EXTRA_CUTS.filter((cut) => cut <= count);
  for (const cut of used) {
    graph[cutIds(cut).noise].inputs.noise_seed = graph["817:129"].inputs.noise_seed;
    convertCut(graph[cutIds(cut).cond], mode, cut === count);
  }
  // The end image belongs to the final cut.
  if (mode === "L2V" || mode === "FL2V") delete graph["817:136"].inputs.last_frame;
  graph["817:136"]._meta = { ...graph["817:136"]._meta, h3_cuts: {
    mode, last: cutIds(count).cond,
    cuts: used.map((cut) => ({ cond: cutIds(cut).cond, preview: cutIds(cut).preview, seconds: cutIds(cut).seconds })),
  } };
  return [STREAM];
}

// Per-cut prompt nodes: cut 1 uses the original LLM (822) and preview (224).
export const VIDEO_RUN = "動画生成";
export const promptRun = (cut) => `カット${cut}のPromptだけ`;
const cutPrompt = (cut) => cut === 1
  ? { llm: "822", preview: "224", cond: "817:136" }
  : { llm: cutIds(cut).llm, preview: cutIds(cut).preview, cond: cutIds(cut).cond };

export const promptCut = (run) => [1, 2, 3, 4].find((cut) => promptRun(cut) === run);

// Cuts whose LLM runs in this graph; remembered when their prompt preview arrives.
export function promptRuns(graph, mode, cuts) {
  const runs = {};
  for (const cut of cuts) {
    const ids = cutPrompt(cut);
    if (graph[`${ids.llm}:210`]) runs[ids.preview] = { cut, mode, instruction: graph[`${ids.llm}:495`]?.inputs.value };
  }
  return runs;
}

// A cut whose LLM is bypassed uses the prompt made earlier.
export function useSavedPrompts(graph, count, saved = {}) {
  for (let cut = 1; cut <= count; cut++) {
    const ids = cutPrompt(cut);
    if (graph[`${ids.llm}:210`]) continue;
    const prompt = saved[cut]?.prompt;
    if (!prompt) throw new Error(`カット${cut}のPromptがありません。カット${cut}の指示（Llama-cpp）のバイパスを解除してください。`);
    graph[ids.cond].inputs.prompt = prompt;
    graph[ids.preview].inputs.source = prompt;
  }
}

const savedPrompt = (control, cut) => {
  const saved = control.properties.h3_cuts.prompts?.[cut];
  const llm = control.graph?.getNodeById(cut === 1 ? 822 : 950 + cut);
  return Boolean(saved && llm && saved.mode === control.properties.h3_multimode?.mode && saved.instruction === widget(llm, "value")?.value);
};

// Bypass state shown on the canvas for the selected cut count and run.
export function applyBypass(control) {
  const cuts = control.properties.h3_cuts;
  const graph = control.graph;
  if (!cuts || !graph) return;
  const set = (id, on) => {
    const node = graph.getNodeById(id);
    if (node) node.mode = on ? 0 : 4;
  };
  const batch = widget(control, "execution_mode")?.value === "バッチ生成";
  const only = batch ? undefined : promptCut(widget(control, "実行内容")?.value);
  set(817, !only);
  set(92, !only);
  for (let cut = 1; cut <= 4; cut++) {
    const used = only ? cut === only : cut <= cuts.count;
    const llm = !batch && (only ? cut === only : used && !savedPrompt(control, cut));
    set(cut === 1 ? 822 : 950 + cut, llm);
    if (cut === 1) {
      set(805, llm);
      set(224, !batch && used);
    } else {
      set(960 + cut, !batch && used);
      set(970 + cut, batch || (!only && used));
    }
  }
  graph.setDirtyCanvas(true, true);
}

export function applySettings(graph, settings) {
  for (const [id, values] of Object.entries(settings ?? {})) {
    const node = graph[id];
    if (!node) throw new Error(`保存設定の復元先がありません: ${id}`);
    for (const [key, value] of Object.entries(values)) {
      if (!(key in node.inputs) || !["string", "number", "boolean"].includes(typeof value) || Array.isArray(node.inputs[key])) {
        throw new Error(`保存設定を復元できません: ${id}.${key}`);
      }
      node.inputs[key] = value;
    }
  }
}

export function configureGeneration(control, app) {
  const config = control.properties.h3_multimode ??= { mode: "R2V", models: {}, r2vModes: {} };
  const graph = control.graph;
  const generator = graph?.getNodeById(817);
  const readModel = () => Object.fromEntries(modelWidgets.map((name) => [name, widget(generator, name)?.value]));
  if (generator && !config.settingsBaseline) {
    config.models.R2V ??= readModel();
    config.models.FL2V ??= readModel();
    config.settingsBaseline = structuredClone(config.models);
    config.settingsBaseline[config.mode === "R2V" ? "R2V" : "FL2V"] = readModel();
  }
  let modeWidget = widget(control, "生成モード");
  const refresh = () => {
    const mode = config.mode;
    const count = mode === "R2V" ? 9 : mode === "FL2V" ? 2 : 1;
    const batch = widget(control, "execution_mode").value === "バッチ生成";
    control.h3BatchQueue?.updateVisibility();
    if (!generator) return;
    for (let i = 0; i < 9; i++) {
      const node = graph.getNodeById(600 + i);
      if (node) node.h3Hidden = batch || i >= count;
    }
    for (let i = 1; i < 9; i++) {
      const node = graph.getNodeById(700 + i);
      if (node) node.h3Hidden = batch || i >= count;
    }
    for (const id of [802, 845]) {
      const node = graph.getNodeById(id);
      if (node) node.h3Hidden = batch || mode !== "R2V";
    }
    applyBypass(control);
    graph.setDirtyCanvas(true, true);
  };
  const change = (mode) => {
    if (!generator) {
      config.mode = mode;
      refresh();
      return;
    }
    const previous = config.mode;
    const oldFamily = previous === "R2V" ? "R2V" : "FL2V";
    const family = mode === "R2V" ? "R2V" : "FL2V";
    config.models[oldFamily] = readModel();
    if (previous === "R2V") {
      config.r2vModes = Object.fromEntries(Array.from({ length: 9 }, (_, i) => {
        const node = graph.getNodeById(600 + i);
        return [600 + i, node?.mode ?? 4];
      }));
    }
    config.mode = mode;
    if (oldFamily !== family) {
      for (const [name, value] of Object.entries(config.models[family])) {
        const target = widget(generator, name);
        if (target) { target.value = value; target.callback?.(value); }
      }
    }
    for (let i = 0; i < 9; i++) {
      const node = graph.getNodeById(600 + i);
      if (node) node.mode = mode === "R2V" ? (config.r2vModes[node.id] ?? 4) : i < (mode === "FL2V" ? 2 : 1) ? 0 : 4;
    }
    refresh();
  };
  if (!modeWidget) {
    modeWidget = control.addWidget("combo", "生成モード", config.mode, change, { values: MODES, serialize: false });
    modeWidget.h3SceneOnly = true;
    const execution = widget(control, "execution_mode");
    const callback = execution.callback;
    execution.callback = function () { callback?.apply(this, arguments); configureGeneration(control, app); };
  }
  modeWidget.callback = change;
  modeWidget.value = config.mode;
  if (control.properties.h3_cuts) {
    let cutWidget = widget(control, "カット数");
    if (!cutWidget) {
      cutWidget = control.addWidget("combo", "カット数", control.properties.h3_cuts.count, () => {}, { values: [1, 2, 3, 4], serialize: false });
      cutWidget.h3SceneOnly = true;
    }
    cutWidget.callback = (value) => {
      control.properties.h3_cuts.count = Number(value);
      refresh();
    };
    cutWidget.value = control.properties.h3_cuts.count;
    let runWidget = widget(control, "実行内容");
    if (!runWidget) {
      runWidget = control.addWidget("combo", "実行内容", VIDEO_RUN, () => {}, { values: [VIDEO_RUN, ...[1, 2, 3, 4].map(promptRun)], serialize: false });
      runWidget.h3SceneOnly = true;
    }
    runWidget.callback = () => applyBypass(control);
  }
  refresh();
  control.setSize(control.computeSize());
  if (!generator) return;
  if (!graph.h3VisibilityInstalled) {
    graph.h3VisibilityInstalled = true;
    const hit = graph.getNodeOnPos;
    graph.getNodeOnPos = function (x, y, nodes) {
      return hit.call(this, x, y, (nodes ?? this._nodes).filter((node) => !node.h3Hidden));
    };
  }
  const canvas = app.canvas;
  if (canvas && !canvas.h3VisibilityInstalled) {
    canvas.h3VisibilityInstalled = true;
    const compute = canvas.computeVisibleNodes;
    canvas.computeVisibleNodes = function (nodes, output) {
      return compute.call(this, (nodes ?? this.graph._nodes).filter((node) => !node.h3Hidden), output);
    };
    const render = canvas._renderAllLinkSegments;
    canvas._renderAllLinkSegments = function (ctx, link) {
      if (this.graph?.getNodeById(link?.origin_id)?.h3Hidden || this.graph?.getNodeById(link?.target_id)?.h3Hidden) return;
      return render.apply(this, arguments);
    };
  }
}

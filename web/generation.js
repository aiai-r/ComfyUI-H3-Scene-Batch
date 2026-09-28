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

export function scenePrompt(output, mode) {
  const graph = structuredClone(output);
  if (!graph["817:136"]) throw new Error("H3生成の構成が見つかりません。対応するシーン作成ワークフローを読み込んでください。");
  const refs = graph["817:136"].inputs;
  if (mode !== "R2V") {
    let images = refs["ref_images.ref_image_0"];
    if (mode === "FL2V") {
      graph["830:scene_images"] = { class_type: "ImageTensorList", inputs: {
        image1: images, image2: refs["ref_images.ref_image_1"],
      } };
      images = ["830:scene_images", 0];
    }
    for (const id of ["822:210", "822:803"]) {
      if (graph[id]) graph[id].inputs.images = images;
    }
    const instruction = {
      I2V: "Image 1 is the exact first frame at 0 seconds.",
      L2V: "Image 1 is the exact last frame at the end of the video. Build the action toward it.",
      FL2V: "Image 1 is the exact first frame; Image 2 is the exact last frame. Connect these endpoints in order.",
    }[mode];
    for (const id of ["822:492", "822:803"]) {
      const inputs = graph[id]?.inputs;
      const key = id.endsWith(":492") ? "value" : "system_prompt";
      if (typeof inputs?.[key] === "string") {
        inputs[key] = `Generate a MiniMax H3 ${mode} video prompt. ${instruction} No reference audio is supplied. Do not use R2V subject_definitions or retention_analysis. Preserve the user's action, dialogue, duration and sound instructions. Use summary, detailed_description with timed shots, overall_soundscape and non_diegetic_music.\n\n` +
          (id.endsWith(":803") ? inputs[key] : "Describe the visible first/last frames accurately and respect their assigned time positions.");
      }
    }
  }
  return generationPrompt(graph, mode);
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

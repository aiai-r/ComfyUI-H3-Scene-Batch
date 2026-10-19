import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { readPlan, updateCut } from "./director_plan.js";
import { sceneAssets, referenceDescriptions, applyDraft, SCENE_CUT_SECONDS } from "./director_llm.js";
import { DirectorLLM, openLLMSettings } from "./director_dialog.js";
import { DirectorQueue, projectRequest, batchProgress } from "./director_queue.js";

const stylesheet = document.createElement("link");
stylesheet.rel = "stylesheet"; stylesheet.href = new URL("./director.css", import.meta.url).href; document.head.append(stylesheet);

function viewUrl(file) {
  if (typeof file === "object") return api.apiURL(`${file.project ? '/h3_scene_director/video' : '/view'}?${new URLSearchParams(file)}`);
  const type = file.endsWith(" [output]") ? "output" : "input";
  const path = file.replaceAll("\\", "/").replace(/ \[(input|output)\]$/, "");
  const split = path.lastIndexOf("/");
  return viewUrl({ filename: path.slice(split + 1), subfolder: path.slice(0, Math.max(0, split)), type });
}

const MODES = [["T2V", "T2VA"], ["I2V", "I2VA"], ["FL2V", "FL2VA"], ["L2V", "L2VA"], ["R2V", "REF2VA"]];
const LANES = [["image", "Image", 9], ["video", "Video", 3], ["audio", "Audio", 3]];

function mediaKind(file) {
  const kind = file.type.split("/")[0];
  if (["image", "audio", "video"].includes(kind)) return kind;
  const extension = file.name.split(".").pop().toLowerCase();
  if (["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff", "avif"].includes(extension)) return "image";
  if (["wav", "mp3", "flac", "ogg", "opus", "m4a", "aac", "aiff"].includes(extension)) return "audio";
  if (["mp4", "webm", "mkv", "mov", "avi", "m4v", "mpeg", "mpg"].includes(extension)) return "video";
  throw new Error("画像・音声・動画ファイルを選択してください。");
}

function attachDirector(node) {
  const widgets = Object.fromEntries(node.widgets.map(w => [w.name, w]));
  for (const name of ["plan_json", "scene_json", "run_name", "use_current_settings"]) {
    const w = widgets[name]; if (!w) continue;
    w.hidden = true; w.options = { ...w.options, hidden: true }; w.computeSize = () => [0, -4];
    if (w.element) w.element.hidden = true;
  }
  const root = document.createElement("div"); root.className = "h3-director"; root.tabIndex = 0;
  root.ondragover = event => {
    if (event.dataTransfer?.types.includes("Files")) { event.preventDefault(); event.stopPropagation(); }
  };
  root.ondrop = event => {
    if (!event.dataTransfer?.files.length) return;
    event.preventDefault(); event.stopPropagation(); report(new Error("モードに対応する素材欄へドロップしてください。"));
  };
  // Everyday controls stay in the head and the two panes; rarely used fields live in the settings drawer.
  const head = element(root, "div", "head");
  const headRow = element(head, "div", "head-row");
  const modeSlot = element(headRow, "div", "mode-slot");
  const toolbar = element(headRow, "div", "toolbar row");
  const status = element(head, "p", "status muted"); status.setAttribute("role", "status");
  const error = element(head, "p", "status"); error.setAttribute("role", "alert");
  const create = element(root, "div", "director-grid");
  const editor = element(create, "div", "pane");
  const cutPane = element(create, "div", "pane");
  const cutEditor = element(cutPane, "div");
  const resultArea = element(cutPane, "div", "section");
  const library = element(root, "div"); library.hidden = true;
  const settings = element(root, "details", "settings"); element(settings, "summary", "", "詳細設定（プロジェクト・シーン名・共通Prompt・保存済み・Plan JSON）");
  const tabs = element(settings, "div", "tabs section");
  const createTab = button(tabs, "作成", () => switchTab(false));
  const libraryTab = button(tabs, "保存済み・一括生成", () => { switchTab(true); return refreshLibrary(); });
  const top = element(settings, "div", "row"); top.style.alignItems = "flex-end";
  const settingsBody = element(settings, "div");
  const project = input(top, "プロジェクト", node.properties.h3_project ?? "MyScenes");
  project.placeholder = "プロジェクト名 または サーバー上の絶対パス";
  project.title = "scenes.jsonがあるフォルダを指定します。クラウドではクラウド側のパスを入力してください。";
  project.onchange = () => { node.properties.h3_project = project.value; selected.clear(); changed(); };
  button(top, "読込", async () => {
    node.properties.h3_project = project.value; selected.clear(); changed();
    switchTab(true); await refreshLibrary();
  });
  const openProject = button(top, "開く", async () => {
    const data = await projectRequest(project.value, "open");
    status.textContent = `保存先を開きました：${data.directory}`;
  });
  openProject.title = "プロジェクトの保存フォルダーを開く";
  const draft = button(toolbar, "LLM設定", () => { collect(); openLLMSettings(node); });
  const generate = button(toolbar, "このシーンを生成", async () => { if (uploading) throw new Error("素材の読み込み完了を待ってください。"); collect(); save(); await busy(() => queue.generate(structuredClone({ plan, scene }))); }); generate.className = "primary";
  button(toolbar, "中止", () => queue.busy ? queue.stop() : llmBusy ? llm.stop() : queue.project || node.properties.h3_pending ? queue.stop() : projectRequest(project.value, "stop").then(refreshLibrary));
  let plan, scene, cut = 0, writingAll = false, selectedAsset = -1, selectedLane = "image", collect = () => {}, inLibrary = false, selected = new Set();
  let uploading = false, trackScroll = 0, pastedPlan = "", expanded = null, menuFor = null, menu = null;
  const queue = new DirectorQueue(node, message => { status.textContent = message; }, showResult);
  const llm = new DirectorLLM(node, message => { status.textContent = message; });
  let llmBusy = false;

  function element(parent, tag, className = "", text = "") { const e = document.createElement(tag); e.className = className; e.textContent = text; parent.append(e); return e; }
  function report(e) { error.textContent = e.message ?? String(e); }
  // Explanations sit behind a "?" mark so they do not take up rows.
  function hint(parent, text) { const e = element(parent, "span", "hint", "?"); e.title = text; return e; }
  function closeMenuElement() { menu?.remove(); menu = null; }
  function closeMenu() { menuFor = null; closeMenuElement(); }
  function button(parent, text, action) { const e = element(parent, "button", "", text); e.type = "button"; e.onclick = async () => { error.textContent = ""; try { await action(); } catch (e) { report(e); } }; return e; }
  function input(parent, label, value, multiline = false) {
    const wrapper = element(parent, "label", "grow"); element(wrapper, "span", "label", label);
    const e = element(wrapper, multiline ? "textarea" : "input"); e.value = value ?? "";
    if (multiline) e.rows = 2; else e.style.width = "100%";
    return e;
  }
  function select(parent, label, options, value, change) {
    const wrapper = element(parent, "label"); element(wrapper, "span", "label", label); const e = element(wrapper, "select");
    for (const [value, title] of options) { const o = element(e, "option", "", title); o.value = value; }
    e.value = value; e.onchange = () => { try { collect(); change(e.value); save(); render(); } catch (e) { report(e); } }; return e;
  }
  function changed() { node.graph?.change(); node.setDirtyCanvas(true, true); }
  function save() { scene.output = { project: project.value }; widgets.plan_json.value = JSON.stringify(plan); widgets.scene_json.value = JSON.stringify(scene); changed(); }
  function arrangeAssets() {
    const selected = scene.assets[selectedAsset];
    for (const [kind] of LANES) {
      const assets = scene.assets.filter(a => a.kind === kind), occupied = new Set();
      // Existing first/last records retain their boundary positions when opened.
      const ordered = [...assets].sort((a, b) => Number(b.role === "first" || b.role === "last") - Number(a.role === "first" || a.role === "last"));
      for (const asset of ordered) {
        let slot = asset.slot ?? (asset.role === "first" ? 0 : asset.role === "last" ? 1 : 0);
        if (!Number.isInteger(slot) || slot < 0) slot = 0;
        while (occupied.has(slot)) slot++;
        asset.slot = slot; occupied.add(slot);
      }
    }
    scene.assets.sort((a, b) => LANES.findIndex(l => l[0] === a.kind) - LANES.findIndex(l => l[0] === b.kind) || a.slot - b.slot);
    selectedAsset = scene.assets.indexOf(selected);
  }
  function roleAt(kind, slot) {
    if (kind !== "image" || scene.mode === "R2V") return "reference";
    if (slot === 0 && ["I2V", "FL2V"].includes(scene.mode)) return "first";
    if (slot === 1 && ["L2V", "FL2V"].includes(scene.mode)) return "last";
    return "reference";
  }
  function slotCount(kind) {
    if (scene.mode === "T2V" || (scene.mode !== "R2V" && kind !== "image")) return 0;
    if (scene.mode !== "R2V") return scene.mode === "I2V" ? 1 : 2;
    return Math.max(LANES.find(l => l[0] === kind)[2], ...scene.assets.filter(a => a.kind === kind).map(a => a.slot + 1));
  }
  function locked(kind, slot) { return scene.mode === "L2V" && kind === "image" && slot === 0; }
  function assetAt(kind, slot) { return scene.assets.find(a => a.kind === kind && a.slot === slot); }
  function removeAsset(asset) {
    collect(); scene.assets.splice(scene.assets.indexOf(asset), 1); selectedAsset = -1;
    if (expanded === asset) expanded = null;
    closeMenu(); save(); render();
  }
  function moveAsset(asset, slot) {
    collect(); const other = assetAt(asset.kind, slot), previous = asset.slot;
    asset.slot = slot; asset.role = roleAt(asset.kind, slot);
    if (other && other !== asset) { other.slot = previous; other.role = roleAt(other.kind, previous); }
    arrangeAssets(); save(); render();
  }
  root.onpaste = event => {
    if (llmBusy) { event.preventDefault(); event.stopPropagation(); return; }
    if (/INPUT|TEXTAREA/.test(event.target.tagName) || !event.clipboardData.files.length) return;
    event.preventDefault(); event.stopPropagation(); return upload([...event.clipboardData.files], selectedLane).catch(report);
  };
  root.addEventListener("pointerdown", event => {
    if (menu && !event.target.closest(".asset-menu, .clip-details")) closeMenu();
  }, true);
  root.onkeydown = event => {
    if (event.key === "Escape" && menu) { event.stopPropagation(); closeMenu(); return; }
    if (llmBusy) return;
    if (/INPUT|TEXTAREA|SELECT/.test(event.target.tagName) || inLibrary) return;
    const asset = scene.assets[selectedAsset];
    if ((event.key === "Delete" || event.key === "Backspace") && asset && !locked(asset.kind, asset.slot)) {
      event.preventDefault(); event.stopPropagation(); removeAsset(asset);
    }
  };
  function switchTab(value) {
    if (uploading) throw new Error("素材の読み込み完了を待ってください。");
    closeMenu(); inLibrary = value; create.hidden = value; modeSlot.hidden = value; library.hidden = !value;
    createTab.setAttribute("aria-selected", !value); libraryTab.setAttribute("aria-selected", value);
    draft.hidden = value; generate.hidden = value;
  }
  async function busy(action) {
    generate.disabled = true; draft.disabled = true; project.disabled = true;
    try { return await action(); } finally { generate.disabled = false; draft.disabled = false; project.disabled = false; }
  }
  async function llmTask(action) {
    if (llmBusy || queue.busy || uploading) throw new Error("実行中の処理が終わるまでお待ちください。");
    collect(); save(); llmBusy = true; llm.cancelled = false;
    closeMenu(); for (const pane of [editor, cutEditor, modeSlot, settings]) pane.inert = true; root.dataset.llmBusy = "true";
    try { await busy(action); }
    finally { llmBusy = false; for (const pane of [editor, cutEditor, modeSlot, settings]) pane.inert = false; root.dataset.llmBusy = "false"; render(); }
  }
  function writingState() {
    const state = node.properties.h3_draft ??= {};
    state.instructions ??= { all: state.instruction ?? "" };
    state.stories ??= { all: state.story ?? "" };
    state.previous ??= {};
    delete state.instruction; delete state.story; delete state.storyOn;
    return state;
  }
  function analysisInstruction() {
    const instructions = writingState().instructions;
    return instructions[`cut:${plan.shots[cut]?.id ?? cut}`] || instructions.all || "";
  }
  function renderWriting(parent, selected, totalSlot) {
    const scope = selected === null ? "all" : `cut:${plan.shots[selected].id ?? selected}`;
    const state = writingState();
    const label = selected === null ? "全カット" : `カット ${selected + 1}`;
    const section = element(parent, "div", "cut-writing section");
    const heading = element(section, "div", "row"); element(heading, "strong", "", `${label}のLLM作成`);
    hint(heading, "各画像の用途と、作りたい動画をまとめて指定できます。未解析の画像だけ解析し、解析済みの用途・定義は固定して使います。変更は画像の☰から再解析してください。\n\n「ストーリー→Prompt」で未解析画像の解析から一括作成。「Prompt作成」はストーリーがあれば使用し、空欄なら日本語指示から作成します。");
    const instruction = input(section, `${label}の日本語指示`, state.instructions[scope], true);
    instruction.placeholder = "画像1：同じ女性の顔・正面・側面をまとめた外見資料。画像2：左上から順に使うストーリーボード。\n動画：女性が…";
    instruction.rows = 4; instruction.oninput = () => { state.instructions[scope] = instruction.value; changed(); };
    const storyPanel = element(section, "details"); element(storyPanel, "summary", "", "ストーリー（任意・編集可能）");
    storyPanel.open = Boolean(state.stories[scope]);
    const story = input(storyPanel, `${label}のストーリー`, state.stories[scope], true); story.rows = 4;
    story.oninput = () => { state.stories[scope] = story.value; changed(); };
    if (selected > 0) {
      const wrapper = element(section, "label"); const previous = element(wrapper, "input"); previous.type = "checkbox";
      previous.checked = state.previous[scope] ?? true; wrapper.append(" 前カットの終了状況をPromptに含める");
      previous.onchange = () => { state.previous[scope] = previous.checked; changed(); };
      hint(wrapper, `参照元：カット ${selected}のPrompt・終了状態。ONなら終了状況を短く説明して次の動作へつなげます。映像・音声の継続設定は変わりません。`);
    }
    const wholeScene = selected === null && scene.mode === "R2V";
    let total = null;
    if (wholeScene) {
      const sum = plan.shots.reduce((value, shot) => value + Number(shot.duration_seconds ?? plan.defaults?.duration_seconds ?? 15), 0);
      total = input(totalSlot, "合計生成秒数（overlap込み）", state.total_seconds ?? sum); total.style.width = "160px";
      total.oninput = () => { state.total_seconds = total.value; changed(); };
      hint(totalSlot, `${SCENE_CUT_SECONDS.max}秒以下は1カットで作成します。超える場合はLLMがカット数と各カットの秒数を決め、今のカットを作り直します。`);
    }
    const buttons = element(section, "div", "row");
    // Whole-scene writing is driven by the instruction, so its buttons sit right under it.
    if (selected === null) storyPanel.before(buttons);
    const actions = [["ストーリー作成", "story"], ["Prompt作成", "prompt"], ["ストーリー→Prompt", "all"]];
    if (selected === null || plan.shots.length === 1) actions.push(["ストーリー→Prompt→生成", "generate"]);
    for (const [text, action] of actions) {
      button(buttons, text, () => llmTask(async () => {
        if (wholeScene) {
          const seconds = Number(total.value);
          if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("合計生成秒数は正の数を指定してください。");
          if (seconds > SCENE_CUT_SECONDS.max) {
            const sourcePlan = structuredClone(plan), sourceScene = structuredClone(scene);
            const { cuts, problems } = await llm.createScene(sourceScene, { instruction: state.instructions.all ?? "", story: state.stories.all ?? "" }, action, seconds,
              value => { state.stories.all = value; changed(); });
            collect();
            if (JSON.stringify(scene) !== JSON.stringify(sourceScene) || JSON.stringify(plan) !== JSON.stringify(sourcePlan)) {
              throw new Error("処理中に素材・カットが変わりました。Promptを再作成してください。");
            }
            if (!cuts) { status.textContent = "ストーリー（カット配分表）を作成しました。ストーリー欄で確認・編集できます。"; return; }
            // The LLM's cut list replaces the old cuts, so drop their per-cut drafts.
            for (const values of [state.instructions, state.stories, state.previous]) for (const key of Object.keys(values)) if (key.startsWith("cut:")) delete values[key];
            plan = { ...plan, shots: cuts.map((c, index) => ({ id: `cut${index + 1}`, prompt: c.prompt, duration_seconds: c.duration_seconds })) };
            cut = 0; render(); save();
            status.textContent = `${cuts.length}カット（${cuts.map(c => c.duration_seconds).join("・")}秒）を作成し、各カットのPrompt欄に反映しました。`;
            // Problems are shown with the result in place, and stop the combined action before video generation.
            if (problems.length) throw new Error("LLMの結果に問題があります（結果は各カットに反映済み）：" + problems.join(" "));
            if (action === "generate" && !llm.cancelled) await queue.generate(structuredClone({ plan, scene }));
            return;
          }
          if (plan.shots.length !== 1 || plan.shots[0].duration_seconds !== seconds) {
            const { length, frames, ...first } = plan.shots[0];
            plan = { ...plan, shots: [{ ...first, duration_seconds: seconds }] }; cut = 0; save(); render();
          }
        }
        const baseline = structuredClone(plan), sourceScene = structuredClone(scene);
        const prompts = await llm.create(baseline, sourceScene, selected, {
          instruction: state.instructions[scope] ?? "", story: state.stories[scope] ?? "",
          includePrevious: selected === null || selected > 0 && (state.previous[scope] ?? true), sceneStory: state.stories.all ?? "",
        }, action === "generate" ? "all" : action, value => { state.stories[scope] = value; changed(); });
        if (prompts) {
          collect();
          if (JSON.stringify(scene) !== JSON.stringify(sourceScene)) throw new Error("処理中に素材・モードが変わりました。Promptを再作成してください。");
          plan = applyDraft(plan, baseline, prompts); render(); save();
          if (action === "generate") {
            if (llm.cancelled) return;
            await queue.generate(structuredClone({ plan, scene }));
            return;
          }
        }
        status.textContent = prompts ? `${label}のPromptを作成し、Prompt欄に反映しました。`
          : `${label}のストーリーを作成しました。ストーリー欄で確認・編集できます。`;
      }));
    }
  }
  function preview(parent, asset, small = false) {
    if (!asset.file) return element(parent, "span", "symbol", "未選択");
    const e = element(parent, asset.kind === "image" ? "img" : asset.kind);
    e.src = viewUrl(asset.file);
    if (asset.kind === "image") e.alt = asset.file.split(/[\\/]/).pop();
    else { e.preload = "metadata"; e.controls = !small; }
    if (!small) e.style.cssText = "max-width:100%;max-height:140px;display:block";
    return e;
  }
  async function upload(files, kind, targetSlot = null) {
    if (llmBusy) throw new Error("LLM処理が終わるまでお待ちください。");
    collect();
    if (!files.length) return;
    if (uploading) throw new Error("素材の読み込み完了を待ってください。");
    if (files.some(file => mediaKind(file) !== kind)) throw new Error("ファイルの種類に対応する素材欄へドロップしてください。");
    const available = Array.from({ length: slotCount(kind) }, (_, i) => i).filter(i => !locked(kind, i) && !assetAt(kind, i));
    if (targetSlot != null) {
      if (targetSlot >= slotCount(kind)) throw new Error("現在のモードに対応する素材枠を選んでください。");
      if (locked(kind, targetSlot)) throw new Error("L2VAの先頭スロットは使用しません。2番目へ画像を入れてください。");
      available.splice(0, available.length, targetSlot, ...available.filter(i => i > targetSlot), ...available.filter(i => i < targetSlot));
    }
    if (files.length > available.length) throw new Error("空きスロットが足りません。素材を削除するか、差し替える枠へ1ファイルをドロップしてください。");
    uploading = true; root.dataset.uploading = "true";
    try {
      for (const file of files) {
        const slot = available.shift(), replace = assetAt(kind, slot);
        const form = new FormData(); form.append("image", file); form.append("type", "input"); form.append("subfolder", "h3_scene_director");
        const response = await api.fetchApi("/upload/image", { method: "POST", body: form });
        if (!response.ok) throw new Error("素材をアップロードできませんでした。");
        const data = await response.json();
        const asset = { kind, role: roleAt(kind, slot), slot, file: [data.subfolder, data.name].filter(Boolean).join("/"), enabled: true, note: "" };
        if (replace) {
          selectedAsset = scene.assets.indexOf(replace);
          Object.assign(replace, { ...asset, note: replace.note ?? "" });
        } else { scene.assets.push(asset); selectedAsset = scene.assets.length - 1; }
        arrangeAssets(); save();
        if (kind === "image" && node.properties.h3_llm) await llm.matchImage(asset);
      }
    } finally { uploading = false; root.dataset.uploading = "false"; render(); }
  }
  function chooseFiles(kind, slot = null) {
    const file = document.createElement("input"); file.type = "file"; file.accept = `${kind}/*`; file.multiple = slot == null || !assetAt(kind, slot);
    file.onchange = () => upload([...file.files], kind, slot).catch(report); file.click();
  }
  function importPlan(text) {
    const imported = readPlan(text);
    if (!confirm("編集中のカットを読み込んだPlanで置き換えますか？")) return;
    plan = imported; cut = 0; pastedPlan = ""; widgets.use_current_settings.value = false;
    save(); render(); status.textContent = `Plan JSONを読み込みました（${plan.shots.length}カット）。`;
  }

  function render() {
    trackScroll = editor.querySelector(".media-track")?.scrollLeft ?? trackScroll;
    closeMenuElement();
    for (const pane of [modeSlot, editor, cutEditor, settingsBody]) pane.replaceChildren();
    collect = () => {};
    if (!scene.assets.includes(expanded)) expanded = null;
    if (!scene.assets.includes(menuFor)) menuFor = null;
    const header = element(settingsBody, "div", "row");
    const title = input(header, "シーン名（採用保存時）", node.properties.h3_title ?? ""); title.placeholder = "例：庭を歩く";
    title.oninput = () => { node.properties.h3_title = title.value; changed(); };
    const modeGroup = element(modeSlot, "div", "mode-group");
    const modebar = element(modeGroup, "div", "modebar"); modebar.setAttribute("aria-label", "Model Mode");
    element(modebar, "span", "mode-label", "Model Mode:");
    for (const [mode, label] of MODES) {
      const toggle = button(modebar, label, () => {
        if (uploading) throw new Error("素材の読み込み完了を待ってください。");
        collect(); scene.mode = mode;
        for (const asset of scene.assets) asset.role = roleAt(asset.kind, asset.slot);
        selectedAsset = -1; if (mode !== "R2V") selectedLane = "image";
        save(); render();
      });
      toggle.dataset.mode = mode; toggle.className = "mode-button";
      toggle.setAttribute("aria-pressed", mode === scene.mode);
    }
    hint(modebar, {
      R2V: "REF2VA · Image 9 / Video 3 / Audio 3 · ＋ または D&Dで追加",
      T2V: "T2VA · no input frame",
      I2V: "I2VA · one opening-frame slot",
      FL2V: "FL2VA · opening and closing-frame slots",
      L2V: "L2VA · one closing-frame slot · 先頭はNot Used",
    }[scene.mode]);
    const actions = element(modebar, "div", "media-actions");
    const chosen = scene.assets[selectedAsset];
    if (chosen && !locked(chosen.kind, chosen.slot)) button(actions, "Remove", () => removeAsset(chosen)).className = "remove-media";
    const clear = button(actions, "Clear", () => {
      if (!scene.assets.length || !confirm("すべての素材を外しますか？Promptは保持します。")) return;
      collect(); scene.assets = []; selectedAsset = -1; expanded = null; closeMenu(); save(); render();
    }); clear.className = "clear-media"; clear.disabled = !scene.assets.length;
    const refs = referenceDescriptions(scene); const active = sceneAssets(scene);
    if (scene.mode !== "T2V") {
      const imageHeader = element(editor, "div", "row spread"); element(imageHeader, "strong", "", "素材（シーン共通）");
      const analyze = button(imageHeader, "画像をまとめて解析", () => llmTask(async () => {
        await llm.analyze(scene, undefined, false, analysisInstruction()); status.textContent = "未解析画像の解析が完了しました。解析済みの定義は保持しています。各画像の☰から確認・編集できます。";
      })); analyze.disabled = !active.some(a => a.kind === "image");
      hint(imageHeader, "サムネイルの☰から、使用のON/OFF・解析・差し替え・削除をその場で実行できます。解析結果やメモは☰の「解析結果・メモを開く」で表示します。");
    }
    const media = element(editor, "div", "media-track"); media.hidden = scene.mode === "T2V";
    media.onscroll = closeMenu;
    const tracks = element(media, "div", "media-tracks");
    function drops(target, kind, slot = null) {
      target.ondragover = event => { event.preventDefault(); event.stopPropagation(); target.classList.add("drag-over"); };
      target.ondragleave = () => target.classList.remove("drag-over");
      target.ondrop = async event => {
        event.preventDefault(); event.stopPropagation(); target.classList.remove("drag-over"); error.textContent = "";
        selectedLane = kind;
        try { await upload([...event.dataTransfer.files], kind, slot); } catch (e) { report(e); }
      };
    }
    let menuAnchor = null;
    for (const [kind, title] of LANES) {
      const count = slotCount(kind); if (!count) continue;
      const lane = element(tracks, "div", `media-lane ${kind}`);
      lane.dataset.kind = kind; lane.setAttribute("aria-label", title);
      lane.classList.toggle("selected", selectedLane === kind);
      element(lane, "span", "lane-label", `${title}${selectedLane === kind ? " · selected" : ""}`);
      lane.onclick = () => { collect(); selectedLane = kind; root.focus(); render(); };
      drops(lane, kind);
      const slots = element(lane, "div", "media-slots");
      for (let slot = 0; slot < count; slot++) {
        const asset = assetAt(kind, slot), index = scene.assets.indexOf(asset), dead = locked(kind, slot);
        const tile = element(slots, "div", `media-slot ${asset ? "media-clip" : "empty-slot"}${dead ? " locked" : ""}`);
        tile.dataset.slot = slot; tile.dataset.kind = kind; tile.dataset.role = roleAt(kind, slot);
        tile.tabIndex = dead ? -1 : 0; tile.setAttribute("role", "button");
        tile.setAttribute("aria-label", `${title} ${slot + 1}${dead ? " Not Used" : ""}`);
        tile.setAttribute("aria-selected", !dead && index >= 0 && index === selectedAsset);
        tile.setAttribute("aria-disabled", dead);
        if (asset) {
          if (kind === "audio") element(tile, "span", "audio-symbol", "♫"); else preview(tile, asset, true);
          element(tile, "span", "clip-filename", asset.file.split(/[\\/]/).pop());
          element(tile, "span", "clip-identity", dead ? "Not Used" : refs.filter(r => r.asset_index === index).map(r => r.label.replace(/[<>]/g, "")).join(" / ") || "不使用");
          tile.classList.toggle("inactive", !dead && !active.includes(asset));
          if (!dead) {
            if (kind === "image") {
              const badge = element(tile, "span", "analysis-badge", llm.imageRecord(asset).text.trim() ? "解析済み" : "未解析");
              badge.title = "解析実行・Prompt作成時に画像内容を再確認します。☰から結果を確認・編集できます。";
            }
            if (asset.enabled === false) element(tile, "span", "off-badge", "OFF");
            const remove = button(tile, "×", () => removeAsset(asset)); remove.className = "clip-remove"; remove.setAttribute("aria-label", `${title} ${slot + 1}を削除`);
            const removeClick = remove.onclick; remove.onclick = event => { event.stopPropagation(); return removeClick(); };
            const details = button(tile, "☰", () => { collect(); selectedAsset = index; menuFor = menuFor === asset ? null : asset; render(); });
            details.className = "clip-details"; details.title = "メニュー（ON/OFF・解析・差し替え・削除・詳細）"; details.setAttribute("aria-expanded", menuFor === asset);
            const detailsClick = details.onclick; details.onclick = event => { event.stopPropagation(); return detailsClick(); };
            if (menuFor === asset) menuAnchor = details;
          }
        } else element(tile, "span", "slot-add", dead ? "Not Used" : "+");
        if (dead) element(tile, "span", "slot-lock", "🔒");
        tile.onclick = event => {
          event.stopPropagation(); if (dead) return;
          collect(); selectedLane = kind; root.focus();
          if (asset) { selectedAsset = index; render(); } else chooseFiles(kind, slot);
        };
        tile.onkeydown = event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); tile.onclick(event); } };
        drops(tile, kind, slot);
        if (asset && !dead) tile.onpointerdown = event => {
          if (event.button !== 0 || event.target.closest("button")) return;
          event.stopPropagation(); collect(); selectedAsset = index; selectedLane = kind;
          const origin = event.clientX, zoom = tile.getBoundingClientRect().width / (tile.offsetWidth || 84); let dragged = false;
          tile.setPointerCapture?.(event.pointerId);
          tile.onpointermove = move => { dragged ||= Math.abs(move.clientX - origin) >= 4; if (dragged) { tile.style.transform = `translateX(${(move.clientX - origin) / zoom}px)`; tile.classList.add("dragging"); } };
          tile.onpointerup = up => {
            tile.onpointermove = null; tile.onpointerup = null; tile.onpointercancel = null;
            tile.style.transform = ""; tile.classList.remove("dragging");
            if (!dragged) return;
            const targets = [...slots.children].filter(t => t.getAttribute("aria-disabled") !== "true");
            const distance = t => { const rect = t.getBoundingClientRect(); return Math.abs(rect.left + rect.width / 2 - up.clientX); };
            const nearest = targets.reduce((a, b) => distance(a) < distance(b) ? a : b);
            moveAsset(asset, Number(nearest.dataset.slot));
          };
          tile.onpointercancel = () => { tile.onpointermove = null; tile.onpointerup = null; tile.onpointercancel = null; tile.style.transform = ""; tile.classList.remove("dragging"); };
        };
      }
    }
    media.scrollLeft = trackScroll;
    selectedAsset = Math.min(selectedAsset, scene.assets.length - 1);
    if (menuAnchor) renderMenu(menuFor, menuAnchor, active);
    // The details panel is only for reading or editing the analysis, note and file.
    const asset = expanded;
    if (asset) {
      const panel = element(editor, "div", "reference"); const line = element(panel, "div", "row spread");
      element(line, "strong", "", `${LANES.find(l => l[0] === asset.kind)[1]} ${asset.slot + 1} の詳細`);
      if (asset.enabled === false) element(line, "span", "muted", "（使用OFF）");
      button(line, "閉じる", () => { collect(); expanded = null; render(); });
      preview(panel, asset);
      if (asset.kind === "image" && active.includes(asset)) {
        const record = llm.imageRecord(asset);
        const analysisLine = element(panel, "div", "row");
        const analysis = input(analysisLine, "画像解析結果（確認・編集）", record.text, true); analysis.rows = 6;
        analysis.oninput = () => { record.text = analysis.value; changed(); };
        hint(analysisLine, "保存した用途・定義を再利用します。以前の解析に三面図などの説明がなければ、日本語指示に用途を書いて再解析してください。Subject番号とPicture番号は現在の画像順に合わせてPromptへ組み込みます。");
      }
      const note = input(panel, "素材メモ（LLMに伝える役割・内容）", asset.note, true);
      note.oninput = () => { asset.note = note.value; save(); };
      const details = element(panel, "details"); element(details, "summary", "", "ファイル・参照サイズ");
      const filename = input(details, "input/output内のファイル", asset.file); filename.onchange = () => { asset.file = filename.value; save(); render(); };
      if (scene.mode === "R2V") select(details, "R2V画像サイズ", [["match", "match"], ["max", "max"]], scene.ref_image_size ?? "match", v => { scene.ref_image_size = v; });
    }
    const prefix = input(settingsBody, "共通Prompt", plan.prompt_prefix, true); prefix.rows = 2;
    const cutHeader = element(editor, "div", "row spread section"); element(cutHeader, "strong", "", `カット · ${plan.shots.length}`);
    button(cutHeader, "＋ カット追加", () => {
      collect(); let index = plan.shots.length + 1; while (plan.shots.some(s => s.id === `cut${index}`)) index++;
      plan.shots.push({ id: `cut${index}`, prompt: "", duration_seconds: 15 }); cut = plan.shots.length - 1; save(); render();
    });
    const cutTabs = element(editor, "div", "strip"); cut = Math.min(cut, plan.shots.length - 1);
    plan.shots.forEach((shot, index) => {
      const tab = button(cutTabs, `${index + 1} · ${shot.length != null ? `${shot.length}f` : `${shot.duration_seconds ?? plan.defaults?.duration_seconds ?? 15}s`}`, () => { collect(); cut = index; render(); });
      tab.className = "cut-tab"; tab.setAttribute("aria-selected", index === cut); tab.setAttribute("aria-label", `カット ${index + 1}`);
    });
    const shot = plan.shots[cut]; const line = element(editor, "div", "row spread cut-line");
    const seconds = input(line, `カット ${cut + 1} の生成秒数（overlap込み）`, shot.duration_seconds); seconds.style.width = "125px";
    const secondsNote = hint(line, "完成尺は重複を除いた長さです");
    // R2V whole-scene writing rebuilds every cut from the total, so the total takes the per-cut field's place.
    const wholeScene = writingAll && scene.mode === "R2V";
    seconds.parentElement.hidden = secondsNote.hidden = wholeScene;
    const totalSlot = element(line, "span"); totalSlot.style.display = wholeScene ? "contents" : "none";
    button(line, "このカットを削除", () => {
      if (plan.shots.length === 1) throw new Error("1カットは必要です。");
      collect(); const scope = `cut:${plan.shots[cut].id ?? cut}`, state = writingState();
      for (const values of [state.instructions, state.stories, state.previous]) delete values[scope];
      plan.shots.splice(cut, 1); cut = Math.max(0, cut - 1); save(); render();
    });
    // One LLM form at a time: the selected cut or the whole scene.
    const writingTabs = element(editor, "div", "tabs writing-tabs");
    const cutWriting = button(writingTabs, `カット ${cut + 1} のLLM作成`, () => { collect(); writingAll = false; render(); });
    const allWriting = button(writingTabs, "全カットまとめて作成", () => { collect(); writingAll = true; render(); });
    cutWriting.setAttribute("aria-selected", !writingAll); allWriting.setAttribute("aria-selected", writingAll);
    renderWriting(editor, writingAll ? null : cut, totalSlot);
    const prompt = input(cutEditor, `カット ${cut + 1} のPrompt`, shot.prompt, true); prompt.className = "prompt"; prompt.rows = 12;
    const advanced = element(cutEditor, "details"); element(advanced, "summary", "", "カット詳細 · seed / ID / 開始・終了状態");
    const fields = element(advanced, "div", "row"); const id = input(fields, "ID", shot.id ?? `cut${cut + 1}`); const seed = input(fields, "seed（空欄は接続seed）", shot.seed);
    const start = input(advanced, "開始状態", shot.start_state, true); const end = input(advanced, "終了状態", shot.end_state, true);
    collect = () => {
      const oldScope = `cut:${plan.shots[cut].id ?? cut}`;
      plan.shots[cut] = updateCut(plan.shots[cut], { id: id.value, seconds: seconds.value, seed: seed.value, prompt: prompt.value });
      const newScope = `cut:${plan.shots[cut].id ?? cut}`;
      if (newScope !== oldScope) {
        const state = writingState();
        for (const values of [state.instructions, state.stories, state.previous]) {
          if (oldScope in values) { values[newScope] = values[oldScope]; delete values[oldScope]; }
        }
      }
      if (start.value || "start_state" in shot) plan.shots[cut].start_state = start.value;
      if (end.value || "end_state" in shot) plan.shots[cut].end_state = end.value;
      if (prefix.value || "prompt_prefix" in plan) plan.prompt_prefix = prefix.value;
    };
    for (const field of [prefix, seconds, prompt, id, seed, start, end]) field.oninput = () => { try { collect(); save(); error.textContent = ""; } catch (e) { report(e); } };
    id.onchange = () => { try { collect(); save(); render(); } catch (e) { report(e); } };
    const importing = element(settingsBody, "details"); element(importing, "summary", "", "Plan JSONを読み込む");
    const pasted = input(importing, "Plan JSONを貼り付け", pastedPlan, true); pasted.rows = 6; pasted.spellcheck = false;
    pasted.oninput = () => { pastedPlan = pasted.value; };
    button(importing, "貼り付けたJSONを読み込む", () => importPlan(pasted.value));
    const file = element(importing, "input"); file.type = "file"; file.accept = ".json,application/json";
    file.onchange = async () => { error.textContent = ""; try { if (file.files[0]) importPlan(await file.files[0].text()); } catch (e) { report(e); } };
    const oldAnalysis = node.properties.h3_draft?.analysis;
    if (oldAnalysis) {
      const old = element(settingsBody, "details"); element(old, "summary", "", "以前の画像解析結果");
      input(old, "移行前の解析文（保存済み）", oldAnalysis, true).readOnly = true;
    }
  }
  // Per-asset actions run straight from the ☰ menu without opening the details panel.
  function renderMenu(asset, anchor, active) {
    menu = element(root, "div", "asset-menu"); menu.setAttribute("role", "menu");
    const item = (text, action) => { const e = button(menu, text, () => { closeMenu(); return action(); }); e.setAttribute("role", "menuitem"); return e; };
    const on = asset.enabled !== false;
    item(on ? "使用をOFFにする" : "使用をONにする", () => { collect(); asset.enabled = !on; save(); render(); });
    if (asset.kind === "image" && active.includes(asset)) {
      item(llm.imageRecord(asset).text.trim() ? "この画像を再解析" : "この画像を解析", () => llmTask(async () => {
        await llm.analyze(scene, [asset], true, analysisInstruction()); status.textContent = "現在の日本語指示で、この画像の参照定義を更新しました。";
      }));
    }
    if (asset.kind === "video") {
      item(asset.use_audio ? "動画の音声参照をOFFにする" : "動画の音声も参照する", () => { collect(); asset.use_audio = !asset.use_audio; save(); render(); });
    }
    item("差し替え", () => chooseFiles(asset.kind, asset.slot));
    item("削除", () => removeAsset(asset)).className = "danger";
    item("解析結果・メモを開く", () => { collect(); expanded = asset; render(); editor.querySelector(".reference")?.scrollIntoView({ block: "nearest" }); });
    const box = root.getBoundingClientRect(), at = anchor.getBoundingClientRect();
    const scale = root.offsetWidth ? box.width / root.offsetWidth : 1;
    menu.style.left = `${Math.max(0, Math.min((at.left - box.left) / scale + root.scrollLeft, root.scrollWidth - 200))}px`;
    menu.style.top = `${(at.bottom - box.top) / scale + root.scrollTop + 4}px`;
  }

  function showResult(result, canAdopt = true) {
    resultArea.replaceChildren(); const heading = element(resultArea, "div", "row");
    element(heading, "strong", "", "完成結果" + (result.duration_seconds != null ? ` · ${result.duration_seconds.toFixed(2)}秒` : ""));
    hint(heading, "保存対象はこの動画を生成した時点のPrompt・seed・使用素材です。");
    const video = element(resultArea, "video", "result-video"); video.src = viewUrl(result.video); video.controls = true; video.preload = "metadata";
    const adopted = result.adopted;
    if (adopted) element(resultArea, "p", "", `保存済み：「${adopted.project}」の${adopted.number}シーン目「${adopted.title}」`);
    if (canAdopt) button(resultArea, "この結果を採用して保存",async () => {
      const saved = await projectRequest(project.value, "adopt", { prompt_id: result.prompt_id, node_id: result.node_id, title: node.properties.h3_title });
      result.adopted = { project: project.value, number: saved.number, title: saved.title };
      const where = `「${project.value}」の${saved.number}シーン目「${saved.title}」`;
      showResult(result, canAdopt);
      status.textContent = saved.existing ? `この結果は${where}として保存済みです。` : `${where}として採用保存しました。`;
      node.properties.h3_project = project.value; changed();
    });
  }

  async function refreshLibrary() {
    const data = await projectRequest(project.value, "list"); const batch = data.batch;
    library.replaceChildren(); button(library, "← 作成に戻る", () => switchTab(false));
    element(library, "p", "muted", "Prompt・素材・seed・追加LoRAは保存設定を使用します。Turbo LoRAは系統別に変更できます。stepsはH3 Scene Settingsの共通設定を使います。モデル・サンプラー・解像度も現在のworkflow設定です。");
    element(library, "p", "muted", "LoRA未記録の旧シーンは現在の追加LoRA・stepsとモード別4step用turboを使用します。再開時はバッチ開始時のturbo設定を引き継ぎます。");
    const loraSettings = element(library, "div", "section");
    button(loraSettings, "バッチLoRA設定", async () => {
      const response = await api.fetchApi("/object_info/LoraLoaderModelOnly");
      if (!response.ok) throw new Error("LoRA一覧を取得できませんでした。");
      const names = (await response.json()).LoraLoaderModelOnly.input.required.lora_name[0];
      loraSettings.replaceChildren();
      element(loraSettings, "p", "muted", "追加LoRAは保存内容を維持します。設定は次に開始するバッチへ適用されます。");
      const config = node.properties.h3_batch_turbo ??= {};
      for (const [family, title] of [["R2V", "R2V用"], ["FL2V", "T2V・I2V・L2V・FL2V用"]]) {
        const group = element(loraSettings, "div", "section"); element(group, "strong", "", title);
        const choice = element(group, "select"); choice.style.maxWidth = "100%";
        for (const [value, text] of [["saved", "保存したTurbo LoRAを使用"], ["override", "Turbo LoRAを変更"]]) {
          const option = element(choice, "option", "", text); option.value = value;
        }
        choice.value = config[family] ? "override" : "saved";
        const fields = element(group, "div"); fields.hidden = choice.value === "saved";
        const file = element(fields, "select"); file.style.maxWidth = "100%";
        const available = ["", ...names];
        if (config[family]?.lora_name && !available.includes(config[family].lora_name)) available.push(config[family].lora_name);
        for (const name of available) { const option = element(file, "option", "", name || "turboなし"); option.value = name; }
        file.value = config[family]?.lora_name ?? names.find(n => n.endsWith(family === "R2V"
          ? "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors"
          : "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors")) ?? "";
        const update = () => {
          fields.hidden = choice.value === "saved";
          if (fields.hidden) delete config[family];
          else config[family] = { lora_name: file.value };
          changed();
        };
        for (const control of [choice, file]) control.onchange = update;
      }
    });
    const actions = element(library, "div", "row");
    button(actions, "更新", refreshLibrary); button(actions, "すべて選択", () => { selected = new Set(data.scenes.map(s => s.id)); return refreshLibrary(); });
    const start = button(actions, "選択シーンを一括生成", async () => { await busy(() => queue.batch(project.value, [...selected])); await refreshLibrary(); }); start.className = "primary";
    const from = input(actions, "開始番号", 1); from.type = "number"; from.min = "1"; from.max = String(data.scenes.length); from.step = "1";
    const fromStart = button(actions, "この番号から末尾まで生成", async () => {
      const index = Number(from.value);
      if (!Number.isInteger(index) || index < 1 || index > data.scenes.length) throw new Error(`開始番号は1〜${data.scenes.length}で指定してください。`);
      await busy(() => queue.batch(project.value, [], false, index)); await refreshLibrary();
    }); fromStart.disabled = !data.scenes.length;
    const resume = button(actions, "未完了から再開", async () => { await busy(() => queue.batch(project.value, [], true)); await refreshLibrary(); }); resume.disabled = !batch || batch.status === "complete";
    if (batch) {
      element(library, "p", "", batchProgress(batch));
      for (const result of batch.completed) {
        const link = element(library, "a", "", `生成結果 ${batch.completed.indexOf(result) + 1} `); link.href = viewUrl(result.video); link.target = "_blank"; link.style.color = "#b2c2ff";
      }
    }
    if (!data.scenes.length) element(library, "p", "empty", "保存済みシーンはありません。作成 → 生成 → 採用保存で追加できます。");
    for (const [index, item] of data.scenes.entries()) {
      const row = element(library, "div", "library-item row"); const check = element(row, "input"); check.type = "checkbox"; check.checked = selected.has(item.id); check.setAttribute("aria-label", `${item.title}を選択`);
      check.onchange = () => check.checked ? selected.add(item.id) : selected.delete(item.id);
      if (item.video) { const thumbnail = element(row, "video"); thumbnail.src = viewUrl(item.video); thumbnail.preload = "metadata"; thumbnail.muted = true; }
      const label = element(row, "div", "grow"); element(label, "strong", "", `${index + 1}. ${item.title}`); element(label, "div", "muted", `${item.mode} · ${item.cuts}カット · ${item.duration_seconds?.toFixed(2) ?? "?"}秒`);
      button(row, "読み込む", async () => {
        if (!confirm("編集中のシーンを保存済みシーンで置き換えますか？")) return;
        const saved = await projectRequest(project.value, "load", { id: item.id });
        plan = readPlan(JSON.stringify(saved.plan)); scene = saved.scene; cut = 0; selectedAsset = -1; arrangeAssets(); node.properties.h3_title = saved.title;
        widgets.use_current_settings.value = true;
        save(); render(); switchTab(false); resultArea.replaceChildren();
        if (saved.video) showResult({ video: saved.video, duration_seconds: saved.duration_seconds }, false);
        status.textContent = "保存シーンを読み込みました。生成設定は現在のworkflowを使用します。";
      });
    }
    element(library, "p", "muted", `保存先：${data.directory}`);
    element(library, "p", "muted", "一括生成中はこの画面を開いておいてください。閉じた場合は再度開いて「未完了から再開」。失敗したシーンは先頭カットから再生成します。");
  }

  widgets.plan_json.serializeValue = () => { collect(); return JSON.stringify(plan); };
  widgets.scene_json.serializeValue = () => JSON.stringify({ ...scene, output: { project: project.value } });
  node.addDOMWidget("cut_editor", "custom", root, { serialize: false, hideOnZoom: false, getMinHeight: () => 600, getHeight: () => 900 });
  function restore() {
    try {
      plan = readPlan(widgets.plan_json.value); scene = JSON.parse(widgets.scene_json.value); sceneAssets(scene); selectedAsset = -1; arrangeAssets();
      project.value = node.properties.h3_project ?? "MyScenes"; render(); switchTab(false);
      if (node.properties.h3_result) showResult(node.properties.h3_result);
    } catch (e) { collect = () => { throw e; }; report(e); }
  }
  const configured = node.onConfigure;
  node.onConfigure = function () { const result = configured?.apply(this, arguments); restore(); return result; };
  const executed = event => {
    const data = event.detail;
    if (!data.output?.h3_scene_result || queue.busy || !data.prompt_id) return;
    const resultNode = node.graph?.getNodeById(Number(data.node));
    const sceneInput = resultNode?.inputs?.find(i => i.name === "scene");
    if (node.graph?.links?.[sceneInput?.link]?.origin_id !== node.id) return;
    node.properties.h3_pending = { prompt_id: data.prompt_id, node_id: String(data.node) };
    queue.stopped = false;
    queue.watch(data.prompt_id, String(data.node)).catch(report);
  };
  api.addEventListener("executed", executed);
  const removed = node.onRemoved;
  node.onRemoved = function () { queue.stopped = true; if (llmBusy) llm.stop().catch(report); api.removeEventListener("executed", executed); return removed?.apply(this, arguments); };
  button(toolbar, "結果を更新", async () => {
    queue.stopped = false;
    if (node.properties.h3_pending) await queue.watch(node.properties.h3_pending.prompt_id, node.properties.h3_pending.node_id);
    else if (node.properties.h3_result) showResult(node.properties.h3_result);
    if (inLibrary) await refreshLibrary();
  });
  restore();
}

app.registerExtension({
  name: "H3SceneBatch.Director",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "H3SceneDirector") return;
    const created = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () { const result = created?.apply(this, arguments); attachDirector(this); return result; };
  },
});

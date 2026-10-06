import { api } from "../../scripts/api.js";
import { draftGraph, readDraft, applyDraft, sceneAssets, imageAnalysisKey } from "./director_llm.js";

export function openDraftDialog(node, getPlan, setPlan, getScene) {
  const baseline = structuredClone(getPlan());
  const scene = structuredClone(getScene());
  const config = node.properties.h3_llm;
  if (!config) throw new Error("LLM設定がありません。Scene Directorの開発workflowを開いてください。");
  const dialog = document.createElement("dialog");
  dialog.style.cssText = "width:min(1000px,90vw);max-height:88vh;overflow:auto;background:var(--comfy-menu-bg,#222);color:var(--fg-color,#ddd);padding:20px;border:1px solid #777";
  const heading = document.createElement("h2");
  heading.textContent = "H3 Scene Director — LLM草案";
  const info = document.createElement("p");
  info.textContent = `${scene.mode}・${baseline.shots.length}カット。対象を選び、工程ごとに実行できます。確定Promptは最後の「適用」まで変わりません。`;
  dialog.append(heading, info);
  const saved = node.properties.h3_draft ?? {};
  function field(parent, label, value, rows = 3) {
    const wrapper = document.createElement("label");
    wrapper.style.cssText = "display:block;margin:10px 0";
    wrapper.append(document.createTextNode(label));
    const input = document.createElement("textarea");
    input.rows = rows; input.value = value;
    input.style.cssText = "display:block;width:100%;box-sizing:border-box;background:var(--comfy-input-bg,#333);color:inherit;padding:8px";
    wrapper.append(input); parent.append(wrapper); return input;
  }
  const selectionLabel = document.createElement("label"); selectionLabel.textContent = "作成・修正する対象 ";
  const selection = document.createElement("select"); selection.setAttribute("aria-label", "作成・修正する対象");
  for (const [value, label] of [["all", "全カット"], ...baseline.shots.map((shot, i) => [String(i), `カット ${i + 1} (${shot.id ?? `cut${i + 1}`})`])]) {
    const option = document.createElement("option"); option.value = value; option.textContent = label; selection.append(option);
  }
  selection.value = "all";
  selectionLabel.append(selection); dialog.append(selectionLabel);
  const stories = { all: saved.story ?? "", ...saved.stories };
  const instructions = { all: saved.instruction ?? "", ...saved.instructions };
  let scope = "all";
  const instruction = field(dialog, "日本語指示（選んだ対象の作成・修正）", instructions.all);
  const analysisGroup = document.createElement("fieldset"); dialog.append(analysisGroup);
  const analysisLegend = document.createElement("legend"); analysisLegend.textContent = "① 画像解析 — シーン共通"; analysisGroup.append(analysisLegend);
  const hasImages = sceneAssets(scene).some(a => a.kind === "image");
  const analysisHelp = document.createElement("p");
  analysisHelp.textContent = hasImages
    ? "解析結果を次の工程で再利用します。未解析・素材変更時は後続の実行時にも自動更新します。音声・動画はメモのみを使います。"
    : "このモードには解析対象の画像がないためスキップします。音声・動画はメモのみを使います。";
  analysisGroup.append(analysisHelp);
  let analysisKey = saved.analysisKey ?? "";
  const analysis = field(analysisGroup, "画像解析結果（確認・編集できます）", hasImages ? saved.analysis ?? "" : "", 5);
  analysis.disabled = !hasImages;
  const storyGroup = document.createElement("fieldset"); dialog.append(storyGroup);
  const storyLegend = document.createElement("legend"); storyLegend.textContent = "② ストーリー — 全カット"; storyGroup.append(storyLegend);
  const story = field(storyGroup, "対象のストーリー（編集可能・不要なら空欄）", stories.all, 5);
  const promptGroup = document.createElement("fieldset"); dialog.append(promptGroup);
  const promptLegend = document.createElement("legend"); promptLegend.textContent = "③ MiniMax H3用Prompt — 全カット"; promptGroup.append(promptLegend);
  const promptHelp = document.createElement("p");
  promptHelp.textContent = "Promptだけ作成：上のストーリーを使用します。空欄なら日本語指示から直接作成します。対象が1カットなら、そのカットだけを作成・適用します。";
  promptGroup.append(promptHelp);
  const settings = document.createElement("details");
  const summary = document.createElement("summary"); summary.textContent = "現在のLLM設定"; settings.append(summary);
  const model = document.createElement("p"); model.textContent = config.loader.model; settings.append(model);
  const settingsHelp = document.createElement("p"); settingsHelp.textContent = "モデル・その他のパラメータは移行元の設定です。同じseedと指示では同じ結果になる場合があります。"; settings.append(settingsHelp);
  for (const [key, label] of [["story", "ストーリー"], ["prompt", "Prompt"]]) {
    for (const [property, title] of [["seed", "seed"], ["max_tokens", "最大出力トークン"], ["temperature", "temperature"]]) {
      const owner = property === "seed" ? config[key].inputs : config[key].parameters;
      const input = field(settings, `${label} ${title}`, String(owner[property]), 1);
      input.onchange = () => {
        const value = Number(input.value);
        if (!Number.isFinite(value) || (property !== "temperature" && !Number.isSafeInteger(value))) { input.setCustomValidity("有効な数値を入力してください。"); input.reportValidity(); return; }
        input.setCustomValidity(""); owner[property] = value; node.graph?.change();
      };
    }
  }
  dialog.append(settings);
  const footer = document.createElement("div");
  footer.style.cssText = "position:sticky;bottom:-20px;background:var(--comfy-menu-bg,#222);padding:8px 0;display:flex;gap:8px;flex-wrap:wrap";
  const status = document.createElement("p"); status.setAttribute("role", "status"); status.style.cssText = "width:100%;margin:4px 0"; footer.append(status);
  dialog.append(footer);
  const actions = document.createElement("div"); actions.style.cssText = "display:flex;gap:8px;flex-wrap:wrap"; promptGroup.append(actions);
  const draftBody = document.createElement("div"); promptGroup.append(draftBody);
  let busy = false, cancelled = false, promptId = null, drafts = null;
  const controls = [];
  const remember = () => {
    stories[scope] = story.value; instructions[scope] = instruction.value;
    node.properties.h3_draft = { stories, instructions, analysis: hasImages ? analysis.value : saved.analysis ?? "", analysisKey }; node.graph?.change();
  };
  instruction.oninput = story.oninput = analysis.oninput = remember;
  selection.onchange = () => {
    remember();
    scope = selection.value === "all" ? "all" : `cut:${baseline.shots[Number(selection.value)].id ?? selection.value}`;
    instruction.value = instructions[scope] ?? ""; story.value = stories[scope] ?? "";
    const target = selection.value === "all" ? "全カット" : `カット ${Number(selection.value) + 1}`;
    storyLegend.textContent = `② ストーリー — ${target}`; promptLegend.textContent = `③ MiniMax H3用Prompt — ${target}`;
    drafts = null; draftBody.replaceChildren(); apply.disabled = true;
    status.textContent = selection.value === "all" ? "全カットが対象です。" : `カット ${Number(selection.value) + 1} だけが対象です。他のカットは変更しません。`;
  };
  function button(parent, text, action) {
    const b = document.createElement("button"); b.type = "button"; b.textContent = text;
    b.onclick = async () => { try { await action(); } catch (e) { status.textContent = e.message; } };
    parent.append(b); return b;
  }
  async function execute(action) {
    if (cancelled) throw new Error("LLM草案作成を中止しました。");
    promptId = null;
    const selected = selection.value === "all" ? null : Number(selection.value);
    const graph = draftGraph(config, scene, baseline, action, instruction.value, story.value, selected, analysis.value,
      selected === null ? "" : stories.all);
    const response = await api.fetchApi("/prompt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: graph, client_id: api.clientId }) });
    const queued = await response.json();
    if (!response.ok) throw new Error(`LLMキュー登録失敗: ${JSON.stringify(queued.node_errors ?? queued.error ?? queued)}`);
    promptId = queued.prompt_id;
    if (cancelled) await cancelRequest(promptId);
    status.textContent = { analysis: "画像解析中…", story: "ストーリー作成中…", prompt: "Prompt作成中…" }[action];
    while (!cancelled) {
      const historyResponse = await api.fetchApi(`/history/${encodeURIComponent(promptId)}`);
      if (!historyResponse.ok) throw new Error("LLM実行履歴を取得できません。キュー画面で状態を確認してください。");
      const history = (await historyResponse.json())[promptId];
      if (cancelled) break;
      if (history) {
        if (history.status?.status_str === "error") {
          const failure = history.status.messages?.find(([name]) => name === "execution_error")?.[1];
          throw new Error(failure?.exception_message ?? "LLM処理が中断されました。");
        }
        const text = history.outputs?.result?.text?.[0];
        if (history.status?.completed && typeof text === "string") { promptId = null; return text; }
        if (history.status?.completed) throw new Error("LLMのテキスト出力がありません。");
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error("中止を要求しました。キュー画面で終了を確認してください。確定Promptは変更していません。");
  }
  async function ensureAnalysis(update = false) {
    if (!hasImages) return;
    const key = () => imageAnalysisKey(config, scene, async path => {
      const response = await api.fetchApi(path, { cache: "no-store" });
      if (!response.ok) throw new Error("参照画像を読み込めません。素材を確認してください。");
      return response.arrayBuffer();
    });
    status.textContent = "参照画像と解析結果を確認中…";
    const current = await key();
    if (!update && analysis.value.trim() && analysisKey === current) return;
    const text = await execute("analysis");
    if (!text.trim()) throw new Error("画像解析結果が空です。もう一度実行してください。");
    if (current !== await key()) throw new Error("処理中に参照画像が変わりました。画像解析を再実行してください。");
    analysis.value = text; analysisKey = current; remember();
  }
  async function cancelRequest(id) {
    for (const [path, payload] of [["/queue", { delete: [id] }], ["/interrupt", { prompt_id: id }]]) {
      const response = await api.fetchApi(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!response.ok) throw new Error("中止要求に失敗しました。キュー画面を確認してください。");
    }
  }
  function renderDrafts() {
    draftBody.replaceChildren();
    for (const draft of drafts) {
      const group = document.createElement("fieldset");
      const legend = document.createElement("legend"); legend.textContent = `草案 カット ${draft.index + 1}`; group.append(legend);
      for (const [key, label] of [["start_state", "開始状態"], ["prompt", "Prompt草案"], ["end_state", "終了状態"]]) {
        const input = field(group, label, draft[key], key === "prompt" ? 5 : 2);
        input.oninput = () => { draft[key] = input.value; };
      }
      draftBody.append(group);
    }
  }
  async function run(action) {
    if (busy) return;
    if ([...settings.querySelectorAll("textarea")].some(input => !input.reportValidity())) return;
    busy = true; cancelled = false; drafts = null; draftBody.replaceChildren(); apply.disabled = true;
    for (const control of controls) control.disabled = true;
    stop.disabled = false;
    try {
      if (JSON.stringify(getScene()) !== JSON.stringify(scene)) throw new Error("参照素材またはモードが変わっています。閉じて開き直してください。");
      await ensureAnalysis(action === "analysis");
      if (action === "story" || action === "all") { story.value = await execute("story"); remember(); }
      if (action === "prompt" || action === "all") {
        const text = await execute("prompt");
        try { drafts = readDraft(text, baseline, selection.value === "all" ? null : Number(selection.value)); }
        catch (error) { field(draftBody, "形式を確認するためのLLM出力（未適用）", text, 10).readOnly = true; throw error; }
        renderDrafts(); apply.disabled = false;
      }
      status.textContent = action === "analysis" ? "画像解析が完了しました。結果は編集して次の工程に使えます。"
        : action === "story" ? "ストーリーが完成しました。確認・編集後、「Promptだけ作成」で変換できます。"
        : "Prompt草案を確認し、下の「適用」を押してください。確定Promptはまだ変更していません。";
    } finally {
      busy = false; promptId = null; stop.disabled = true;
      for (const control of controls) control.disabled = false;
      analyze.disabled = analysis.disabled = !hasImages;
    }
  }
  const analyze = button(analysisGroup, "画像解析を実行", () => run("analysis")); analyze.disabled = !hasImages;
  controls.push(analyze, button(storyGroup, "ストーリーだけ作成", () => run("story")),
    button(actions, "Promptだけ作成", () => run("prompt")), button(actions, "ストーリー → Promptをまとめて作成", () => run("all")));
  const stop = button(footer, "中止", async () => {
    cancelled = true;
    stop.disabled = true;
    if (promptId) await cancelRequest(promptId);
  }); stop.disabled = true;
  const apply = button(footer, "確認した草案をノードへ適用", () => {
    if (JSON.stringify(getScene()) !== JSON.stringify(scene)) throw new Error("参照素材またはモードが変わっています。閉じて開き直してください。");
    if (drafts.some(d => !d.prompt.trim())) throw new Error("Prompt草案が空欄です。");
    setPlan(applyDraft(getPlan(), baseline, drafts)); remember(); dialog.close();
  }); apply.disabled = true;
  controls.push(button(footer, "閉じる", () => dialog.close()));
  controls.push(instruction, story, analysis, selection, ...settings.querySelectorAll("textarea"));
  dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  document.body.append(dialog); dialog.showModal();
}

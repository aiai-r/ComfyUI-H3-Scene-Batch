import { api } from "../../scripts/api.js";
import { draftGraph, readDraft, applyDraft } from "./director_llm.js";

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
  info.textContent = `${scene.mode}・${baseline.shots.length}カット。画像は既存キャッシュで解析・再利用します。音声・動画はメモのみをLLMへ渡します。`;
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
  const instruction = field(dialog, "シーン全体の指示／修正指示", saved.instruction ?? "");
  const storyLabel = document.createElement("label");
  const storyOn = document.createElement("input"); storyOn.type = "checkbox"; storyOn.checked = saved.storyOn ?? true;
  storyLabel.append(storyOn, " ストーリーを作成してからPromptを作る"); dialog.append(storyLabel);
  const story = field(dialog, "ストーリー（編集可能）", saved.story ?? "", 5);
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
  const selectionLabel = document.createElement("label"); selectionLabel.textContent = "部分修正の対象 ";
  const selection = document.createElement("select");
  baseline.shots.forEach((shot, i) => { const option = document.createElement("option"); option.value = String(i); option.textContent = `カット ${i + 1} (${shot.id ?? `cut${i + 1}`})`; selection.append(option); });
  selectionLabel.append(selection); dialog.append(selectionLabel);
  const status = document.createElement("p"); status.setAttribute("role", "status"); dialog.append(status);
  const actions = document.createElement("div"); actions.style.cssText = "display:flex;gap:8px;flex-wrap:wrap"; dialog.append(actions);
  const draftBody = document.createElement("div"); dialog.append(draftBody);
  let busy = false, cancelled = false, promptId = null, drafts = null;
  const controls = [];
  const remember = () => { node.properties.h3_draft = { instruction: instruction.value, story: story.value, storyOn: storyOn.checked }; node.graph?.change(); };
  instruction.oninput = story.oninput = storyOn.onchange = remember;
  function button(parent, text, action) {
    const b = document.createElement("button"); b.type = "button"; b.textContent = text;
    b.onclick = async () => { try { await action(); } catch (e) { status.textContent = e.message; } };
    parent.append(b); return b;
  }
  async function execute(action) {
    if (cancelled) throw new Error("LLM草案作成を中止しました。");
    promptId = null;
    const graph = draftGraph(config, scene, baseline, action, instruction.value, storyOn.checked ? story.value : "", Number(selection.value));
    const response = await api.fetchApi("/prompt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: graph, client_id: api.clientId }) });
    const queued = await response.json();
    if (!response.ok) throw new Error(`LLMキュー登録失敗: ${JSON.stringify(queued.node_errors ?? queued.error ?? queued)}`);
    promptId = queued.prompt_id;
    if (cancelled) await cancelRequest(promptId);
    status.textContent = action === "story" ? "ストーリー作成中…" : "Prompt作成中…";
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
      if (action === "story" || action === "all" && storyOn.checked) { story.value = await execute("story"); remember(); }
      if (action !== "story") {
        const text = await execute(action === "revise" ? "revise" : "prompt");
        try { drafts = readDraft(text, baseline, action === "revise" ? Number(selection.value) : null); }
        catch (error) { field(draftBody, "形式を確認するためのLLM出力（未適用）", text, 10).readOnly = true; throw error; }
        renderDrafts(); apply.disabled = false;
      }
      status.textContent = "草案を確認してください。ノードの確定Promptにはまだ適用していません。";
    } finally {
      busy = false; promptId = null; stop.disabled = true;
      for (const control of controls) control.disabled = false;
    }
  }
  for (const [label, action] of [["全カット作成", "all"], ["ストーリーのみ作成", "story"], ["Promptのみ作り直し", "prompt"], ["選択カットを修正", "revise"]]) {
    controls.push(button(actions, label, () => run(action)));
  }
  const stop = button(actions, "中止", async () => {
    cancelled = true;
    stop.disabled = true;
    if (promptId) await cancelRequest(promptId);
  }); stop.disabled = true;
  const apply = button(dialog, "確認した草案をノードへ適用", () => {
    if (JSON.stringify(getScene()) !== JSON.stringify(scene)) throw new Error("参照素材またはモードが変わっています。閉じて開き直してください。");
    if (drafts.some(d => !d.prompt.trim())) throw new Error("Prompt草案が空欄です。");
    setPlan(applyDraft(getPlan(), baseline, drafts)); remember(); dialog.close();
  }); apply.disabled = true;
  controls.push(button(dialog, "閉じる", () => dialog.close()));
  controls.push(instruction, story, storyOn, selection, ...settings.querySelectorAll("textarea"));
  dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  document.body.append(dialog); dialog.showModal();
}

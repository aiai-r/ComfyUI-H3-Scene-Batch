// Exercise the installed ComfyUI control implementation without queuing inference.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { stripTypeScriptTypes } from "node:module";

if (!process.env.H3_FRONTEND_ASSETS) {
  console.log("Seed control integration skipped: set H3_FRONTEND_ASSETS to ComfyUI frontend static/assets.");
  process.exit(0);
}
const sources = {};
for (const file of await readdir(process.env.H3_FRONTEND_ASSETS)) {
  if (!/^(main|settingStore)-.*\.js\.map$/.test(file)) continue;
  const map = JSON.parse(await readFile(join(process.env.H3_FRONTEND_ASSETS, file), "utf8"));
  map.sources.forEach((name, i) => { if (map.sourcesContent[i]) sources[name] = map.sourcesContent[i]; });
}
const sourceFor = suffix => {
  const entry = Object.entries(sources).find(([name]) => name.endsWith(suffix));
  assert.ok(entry, `Missing frontend source: ${suffix}`);
  return entry[1];
};
function compile(source, bindings, result) {
  const text = stripTypeScriptTypes(source.replace(/^import[\s\S]*?from ['"][^'"]+['"]\s*;?\r?\n/gm, ""))
    .replaceAll("export ", "");
  return new Function(...Object.keys(bindings), text + `\nreturn ${result};`)(...Object.values(bindings));
}
const IS_CONTROL_WIDGET = Symbol(), HAS_EXECUTED = Symbol();
const isComboWidget = w => w.type === "combo";
const controls = compile(sourceFor("/scripts/valueControl.ts"), { IS_CONTROL_WIDGET, isComboWidget },
  "({nextValueForLinkedTarget,isValueControlWidget})");
let timing = "after";
const widgetsSource = sourceFor("/scripts/widgets.ts");
const addControlSource = widgetsSource.slice(widgetsSource.indexOf("export function addValueControlWidgets("), widgetsSource.indexOf("export const ComfyWidgets"));
const addControls = compile(addControlSource, {
  IS_CONTROL_WIDGET, HAS_EXECUTED, isComboWidget, ...controls,
  updateControlWidgetLabel() {}, controlValueRunBefore: () => timing === "before",
}, "addValueControlWidgets");
const promotedControl = compile(sourceFor("/scripts/promotedWidgetControl.ts"), {
  ...controls, useSettingStore: () => ({ get: () => timing }),
  promotedInputSource: (node, input) => input.source,
  resolveConcretePromotedWidget: node => ({ status: "resolved", resolved: { widget: node.sourceWidget } }),
}, "applyPromotedWidgetControl");
const queueSource = (await readFile(new URL("./web/director_queue.js", import.meta.url), "utf8"))
  .replace(/^import .*;\r?\n/gm, "").replaceAll("export ", "");

function fixture(layout, mode) {
  const seed = { name: "seed", type: "number", value: 40, options: { min: 0, max: 100, step2: 1 } };
  const seedNode = { id: 1, widgets: [seed], inputs: [{ widget: { name: "seed" }, link: null }],
    isSubgraphNode: () => false, isInputConnected(i) { return this.inputs[i].link != null; },
    addWidget(type, name, value, callback, options) {
      const w = { type, name, value, callback, options }; this.widgets.push(w); return w;
    },
  };
  seed.linkedWidgets = addControls(seedNode, seed, mode);
  const wrap = node => ({ id: node.id + 10, subgraph: { _nodes: [node] }, widgets: [], inputs: [], isSubgraphNode: () => true });
  let root = seedNode, target = seed;
  if (layout !== "outer") root = wrap(root);
  if (layout.startsWith("promoted")) {
    seedNode.inputs[0].link = 1;
    target = { name: "seed", value: seed.value, type: seed.type, options: seed.options };
    root.sourceWidget = seed;
    root.inputs = [{ widgetId: "inner-seed", source: { nodeId: seedNode.id, widgetName: "seed" } }];
    root.isInputConnected = () => false;
    root.getWidgetFromSlot = () => root.widgets[0];
    root.widgets = [target];
    if (layout === "promoted-nested") {
      root.isInputConnected = () => true;
      root = { ...wrap(root), sourceWidget: seed,
        inputs: [{ widgetId: "outer-seed", source: { nodeId: 11, widgetName: "seed" } }],
        isInputConnected: () => false, getWidgetFromSlot: () => target, widgets: [target] };
    }
  } else if (layout === "nested") root = wrap(root);
  return { root, target };
}

const record = { plan: { shots: [{ prompt: "Garden" }, { prompt: "Pond", seed: "123" }] }, scene: { mode: "T2V", assets: [] } };
const random = Math.random;
let cases = 0;
try {
  for (timing of ["before", "after"]) for (const layout of ["outer", "internal", "nested", "promoted", "promoted-nested"]) {
    for (const mode of ["fixed", "increment", "decrement", "randomize"]) {
      const { root, target } = fixture(layout, mode), sent = [];
      let draws = 0;
      Math.random = () => [0.25, 0.75][draws++];
      const app = { rootGraph: { _nodes: [root] }, graph: { _nodes: [] },
        graphToPrompt: async () => ({ output: {
          "1200": { class_type: "H3SceneDirector", inputs: { base_seed: target.value } },
          "1211": { class_type: "H3SceneResult", inputs: { scene: ["1200", 2] } },
        }, workflow: { nodes: [{ id: 1200 }] } }),
      };
      const api = { fetchApi: async (path, request) => {
        assert.equal(path, "/prompt"); const body = JSON.parse(request.body); sent.push(body);
        return { ok: true, json: async () => ({ prompt_id: body.prompt_id }) };
      } };
      const Queue = new Function("app", "api", "applyPromotedWidgetControl", queueSource + "\nreturn DirectorQueue;")(app, api, promotedControl);
      const queue = new Queue({ id: 1200, properties: {} }, () => {}, () => {});
      queue.watch = async () => {};
      await queue.generate(record); await queue.generate(record);
      const next = { fixed: 40, increment: 41, decrement: 39, randomize: 25 }[mode];
      assert.deepEqual(sent.map(v => v.prompt[1200].inputs.base_seed), [40, next], `${timing}/${layout}/${mode}`);
      const final = timing === "before" ? next : { fixed: 40, increment: 42, decrement: 38, randomize: 75 }[mode];
      assert.equal(target.value, final, `${timing}/${layout}/${mode}: update exactly once`);
      for (const body of sent) assert.deepEqual(JSON.parse(body.prompt[1200].inputs.plan_json), record.plan);
      cases++;
    }
  }
} finally { Math.random = random; }
console.log(`Director seed controls: ${cases} cases passed using native ComfyUI controls; root, internal, nested, promoted, before/after timing, and explicit cut seeds.`);

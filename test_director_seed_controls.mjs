// Exercise Director seed control against the installed ComfyUI control widgets without queuing inference.
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
  if (!file.endsWith(".js.map")) continue;
  const map = JSON.parse(await readFile(join(process.env.H3_FRONTEND_ASSETS, file), "utf8"));
  map.sources.forEach((name, i) => { if (map.sourcesContent?.[i]) sources[name] = map.sourcesContent[i]; });
}
// Frontend 1.57 moved these files; accept either location.
const sourceFor = (...suffixes) => {
  const entry = Object.entries(sources).find(([name]) => suffixes.some(suffix => name.endsWith(suffix)));
  assert.ok(entry, `Missing frontend source: ${suffixes.join(" or ")}`);
  return entry[1];
};
function compile(source, bindings, result) {
  const text = stripTypeScriptTypes(source.replace(/^import[\s\S]*?from ['"][^'"]+['"]\s*;?\r?\n/gm, ""))
    .replaceAll("export ", "");
  return new Function(...Object.keys(bindings), text + `\nreturn ${result};`)(...Object.values(bindings));
}
const IS_CONTROL_WIDGET = Symbol(), HAS_EXECUTED = Symbol();
const CONTROL_OPTIONS = ["fixed", "increment", "decrement", "randomize"];
const isComboWidget = w => w.type === "combo";
const findComboValueIndex = (values, value) => values.indexOf(value);
const isControlOption = value => CONTROL_OPTIONS.includes(value);
const controls = compile(sourceFor("/scripts/valueControl.ts", "/core/graph/widgets/valueControl.ts"),
  { IS_CONTROL_WIDGET, isComboWidget, findComboValueIndex, isControlOption },
  "({nextValueForLinkedTarget,isValueControlWidget,isValueControlMode:typeof isValueControlMode==='function'?isValueControlMode:undefined})");
let timing = "after";
const newWidgets = Object.keys(sources).find(name => name.endsWith("/core/graph/widgets/valueControlWidgets.ts"));
const addControls = newWidgets
  ? compile(sources[newWidgets], {
    IS_CONTROL_WIDGET, isComboWidget, CONTROL_OPTIONS, t: key => key,
    useSettingStore: () => ({ get: () => timing }),
    nextValueForLinkedTarget: controls.nextValueForLinkedTarget, isValueControlMode: controls.isValueControlMode,
  }, "addValueControlWidgets")
  : (() => {
    const widgetsSource = sourceFor("/scripts/widgets.ts");
    const addControlSource = widgetsSource.slice(widgetsSource.indexOf("export function addValueControlWidgets("), widgetsSource.indexOf("export const ComfyWidgets"));
    return compile(addControlSource, {
      IS_CONTROL_WIDGET, HAS_EXECUTED, isComboWidget, ...controls,
      updateControlWidgetLabel() {}, controlValueRunBefore: () => timing === "before",
    }, "addValueControlWidgets");
  })();
const queueSource = (await readFile(new URL("./web/director_queue.js", import.meta.url), "utf8"))
  .replace(/^import .*;\r?\n/gm, "").replaceAll("export ", "");

// A subgraph node whose input `seed` is linked to `inner`'s input slot.
function subgraphHost(id, inner, innerInput) {
  return { id, widgets: [], inputs: [{ name: "seed", widgetId: `${id}-seed`, link: null }],
    isSubgraphNode: () => true, isInputConnected(i) { return this.inputs[i].link != null; },
    subgraph: { _nodes: [inner], inputNode: { slots: [{ name: "seed", linkIds: [id] }] },
      getLink: linkId => linkId === id ? { resolve: () => ({ inputNode: inner, input: innerInput }) } : undefined },
  };
}

function fixture(layout, mode) {
  const seed = { name: "seed", type: "number", value: 40, options: { min: 0, max: 100, step2: 1 } };
  const seedNode = { id: 1, widgets: [seed], inputs: [{ name: "seed", widget: { name: "seed" }, link: null }],
    isSubgraphNode: () => false, isInputConnected(i) { return this.inputs[i].link != null; },
    getWidgetFromSlot(input) { return this.widgets.find(w => w.name === input.widget?.name); },
    addWidget(type, name, value, callback, options) {
      const w = { type, name, value, callback, options }; this.widgets.push(w); return w;
    },
  };
  seed.linkedWidgets = addControls(seedNode, seed, mode);
  const wrap = node => ({ id: node.id + 10, subgraph: { _nodes: [node] }, widgets: [], inputs: [], isSubgraphNode: () => true });
  let root = seedNode, target = seed;
  if (layout.startsWith("promoted")) {
    seedNode.inputs[0].link = 1;
    root = subgraphHost(11, seedNode, seedNode.inputs[0]);
    target = { name: "seed", value: seed.value, type: seed.type, options: seed.options };
    root.getWidgetFromSlot = () => target;
    if (layout === "promoted-nested") {
      root.inputs[0].link = 2;
      root = subgraphHost(12, root, root.inputs[0]);
      root.getWidgetFromSlot = () => target;
    }
  } else if (layout !== "outer") {
    root = wrap(root);
    if (layout === "nested") root = wrap(root);
  }
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
        extensionManager: { setting: { get: key => key === "Comfy.WidgetControlMode" ? timing : undefined } },
        graphToPrompt: async () => ({ output: {
          "1200": { class_type: "H3SceneDirector", inputs: { base_seed: target.value } },
          "1211": { class_type: "H3SceneResult", inputs: { scene: ["1200", 2] } },
        }, workflow: { nodes: [{ id: 1200 }] } }),
      };
      const api = { fetchApi: async (path, request) => {
        assert.equal(path, "/prompt"); const body = JSON.parse(request.body); sent.push(body);
        return { ok: true, json: async () => ({ prompt_id: body.prompt_id }) };
      } };
      const Queue = new Function("app", "api", queueSource + "\nreturn DirectorQueue;")(app, api);
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
console.log(`Director seed controls: ${cases} cases passed with ComfyUI control widgets; root, internal, nested, promoted, before/after timing, and explicit cut seeds.`);

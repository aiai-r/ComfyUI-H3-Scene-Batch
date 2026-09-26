import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let extension;
let dialog;
let replies = [];
const requests = [];
const notices = [];
globalThis.captureApp = {
  registerExtension(value) { extension = value; },
  extensionManager: { toast: { add(value) { notices.push(value); } } },
};
globalThis.captureApi = {
  async fetchApi(url, options) {
    requests.push(JSON.parse(options.body));
    const data = replies.shift();
    return { ok: !data.error, status: data.error ? 400 : 200, async json() { return data; } };
  },
};
globalThis.document = {
  createElement(tag) {
    return {
      tag, style: {}, children: [], events: {},
      append(...children) { this.children.push(...children); },
      addEventListener(name, callback) { this.events[name] = callback; },
      showModal() { dialog = this; },
      close(value = "") { this.returnValue = value; this.events.close(); },
      remove() { dialog = null; },
    };
  },
  body: { append() {} },
};
const source = readFileSync(new URL("web/capture.js", import.meta.url), "utf8")
  .replace('import { app } from "../../scripts/app.js";', "const app = globalThis.captureApp;")
  .replace('import { api } from "../../scripts/api.js";', "const api = globalThis.captureApi;");
await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
class Node {
  widgets = [{ name: "project_dir", value: "project" }];
  addWidget(type, name, value, callback) {
    const widget = { name, value, callback };
    this.widgets.push(widget);
    return widget;
  }
  setDirtyCanvas() {}
}
await extension.beforeRegisterNodeDef(Node, { name: "H3SceneCapture" });
const node = new Node();
node.onNodeCreated();
const save = node.widgets[1];
const success = { scene_id: "scene02", images: 1, media: 0, path: "project/scenes.json" };
const duplicate = { duplicates: ["scene01"], fingerprint: "content-hash" };
const tick = () => new Promise((resolve) => setImmediate(resolve));

replies = [success];
await save.callback();
assert.equal(notices.at(-1).severity, "success");
const savedName = save.name;

for (const cancel of ["button", "escape"]) {
  replies = [duplicate];
  const count = requests.length;
  const pending = save.callback();
  await tick();
  assert.match(dialog.children[0].textContent, /scene01/);
  await save.callback();
  assert.equal(requests.length, count + 1);
  if (cancel === "button") dialog.children[1].children[0].events.click();
  else dialog.close();
  await pending;
  assert.equal(requests.length, count + 1);
  assert.equal(save.name, savedName);
}

replies = [duplicate, success];
const pending = save.callback();
await tick();
node.widgets[0].value = "changed-project";
dialog.children[1].children[1].events.click();
await pending;
assert.deepEqual(requests.at(-1), { project_dir: "project", confirm_fingerprint: "content-hash" });
assert.equal(dialog, null);

replies = [duplicate, { error: "Scene changed" }];
const failed = save.callback();
await tick();
dialog.children[1].children[1].events.click();
await failed;
assert.equal(notices.at(-1).severity, "error");
assert.equal(save.name, savedName);
console.log("Capture save, duplicate confirmation, cancellation, double-click, and error tests passed.");

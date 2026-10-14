import { readFile, writeFile } from 'node:fs/promises';
import { draftGraph, readDraft, sceneAssets, referenceDescriptions, referenceDefinitions, includeReferenceDefinitions, imageAnalysisKey } from '../web/director_llm.js';

const [workflowPath, outputPath] = process.argv.slice(2);
const workflow = JSON.parse(await readFile(workflowPath, 'utf8'));
const config = workflow.nodes.find(n => n.type === 'H3SceneDirector').properties.h3_llm;
const source = (await readFile(new URL('../web/director_dialog.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\r?\n/gm, '').replaceAll('export ', '');
const DirectorLLM = new Function('draftGraph', 'readDraft', 'sceneAssets', 'referenceDescriptions', 'referenceDefinitions', 'includeReferenceDefinitions', 'imageAnalysisKey', 'crypto', source + '\nreturn DirectorLLM;')(
  draftGraph, readDraft, sceneAssets, referenceDescriptions, referenceDefinitions, includeReferenceDefinitions, imageAnalysisKey, crypto);
const scene = { mode: 'R2V', assets: [
  { kind: 'image', file: 'worker.png' }, { kind: 'image', file: 'workshop.png' }, { kind: 'image', file: 'supervisor.png' },
  { kind: 'audio', file: 'worker.wav' }, { kind: 'audio', file: 'supervisor.wav' },
] };
const analysis = '<Subject 1> is an adult female craft worker in <Picture 1>, with black hair tied back and a blue work apron.\n<Subject 2> is the bright workshop in <Picture 2>, with a wooden desk, paper, a pencil, a wooden box, a small lamp and a shelf.\n<Subject 3> is an adult male supervisor in <Picture 3>, with short gray hair and a gray work apron. The two adults are the only people in the room.';
const instruction = '画像1の成人女性は音声1、画像3の成人男性は音声2を声質の参照として使用する。部屋にはこの2人だけ。画像2の作業室で、女性が机のノートに設計図を描き、男性が横から見守る。最初の15秒は2人とも無言で、鉛筆と紙の音だけ。その後、男性の一人称視点で設計図と机上の木箱を見る。男性が「この箱を棚に置こう」と一度だけ言う。女性が「はい、運びます」と一度だけ返事をして鉛筆を置く。2人で木箱を持ち上げて棚まで運び、棚に置く。最後は作業台へ戻り、女性がノートを閉じ、男性が机のランプを消す。話すのは指定した2つの台詞だけ。その他は無言。BGMなし。台詞以外は環境音と動作音のみ。指定された全カットの秒数を使って、この一連の展開を順番に配分する。';
const cases = [];
for (const maxTokens of [2048, 4096]) for (const count of [4, 5, 6]) for (const seed of [101, 202, 303]) {
  const settings = structuredClone(config);
  settings.story.parameters.max_tokens = maxTokens;
  const plan = { shots: Array.from({ length: count }, (_, i) => ({ id: `cut${i + 1}`, duration_seconds: 15, prompt: '' })) };
  const llm = new DirectorLLM({ properties: { h3_llm: settings } }, () => {});
  llm.analyze = async () => analysis;
  let graph;
  llm.execute = async value => { graph = value; return ''; };
  await llm.create(plan, scene, null, { instruction, story: '', includePrevious: true, sceneStory: '' }, 'story', () => {});
  graph.writer.inputs.seed = seed;
  cases.push({ name: `${count}cuts_${maxTokens}tokens_seed${seed}`, count, max_tokens: maxTokens, seed, graph });
}
await writeFile(outputPath, JSON.stringify({ instruction, cases }, null, 2));
console.log(`Prepared ${cases.length} story-only cases from the current Director code.`);

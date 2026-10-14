import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as llmModule from './web/director_llm.js';
import { DirectorBindings } from './web/director_bindings.js';
import { referenceDescriptions } from './web/director_llm.js';

const analysis = '<Subject 1> is an adult female worker in <Picture 1>.\n<Subject 2> is the workshop in <Picture 2>.\n<Subject 3> is an adult male supervisor in <Picture 3>.';
const scene = {mode:'R2V', assets:[{kind:'image'},{kind:'image'},{kind:'image'},{kind:'audio'},{kind:'audio'}]};
const instruction = '画像1は音声1、画像3は音声2を参照音声として使用する。男性が「運ぼう」と言う。女性が「はい」と返事する。';
const bindings = new DirectorBindings(analysis, referenceDescriptions(scene), scene.assets, instruction);
assert.deepEqual(bindings.voices.map(v=>[v.label,v.speaker,v.audio]), [['<Subject 1>','S1','<Audio 1>'],['<Subject 3>','S2','<Audio 2>']]);
const male = bindings.voices[1].id;
const room = bindings.entries.find(e=>e.label==='<Subject 2>').id;
assert.equal(bindings.decode(`[[${room}]] contains [[${male}]].`),'<Subject 2> contains <Subject 3>.');
const sparse = {mode:'R2V',assets:[{kind:'image',slot:0},{kind:'image',slot:2},{kind:'audio',slot:1}]};
const sparseAnalysis = '<Subject 1> is the room in <Picture 1>.\n<Subject 2> is the man in <Picture 2>.';
const sparseBindings = new DirectorBindings(sparseAnalysis, referenceDescriptions(sparse), sparse.assets, '画像3は音声2を参照音声として使用する。');
assert.deepEqual(sparseBindings.voices.map(v=>[v.label,v.audio]),[['<Subject 2>','<Audio 1>']]);
assert.throws(()=>new DirectorBindings(analysis+'\n<Subject 4> is another man in <Picture 3>.',referenceDescriptions(scene),scene.assets,instruction),/一意/);
const savedLayout = '<Subject 1> is the woman in <Picture 1>.\n\n<Picture 2> is the workshop background.\n\n<Picture 3> defines <Subject 2>, a man seen from three views.\n\n<Subject 2> is an adult man with gray hair.';
const savedBindings = new DirectorBindings(savedLayout,referenceDescriptions(scene),scene.assets,instruction);
assert.deepEqual(savedBindings.voices.map(v=>[v.label,v.audio]),[['<Subject 1>','<Audio 1>'],['<Subject 2>','<Audio 2>']]);
assert.equal(savedBindings.entries.find(e=>e.label==='<Picture 2>').id,'picture_2');

const content = `At 2–5s [[${male}]] (S2) [[audio_2]] says <d>[Japanese] 運ぼう</d>.
No speech for the first second. Room tone. Music: soft piano.
Start: waiting. End: holding the box.`;
const expected = content.replaceAll(`[[${male}]]`, '<Subject 3>').replaceAll('[[audio_2]]', '<Audio 2>');
assert.equal(bindings.decode(content), expected, 'Only reference labels may change');
assert.equal(bindings.decode('No dialogue. 「はい」 0–15s BGMあり'), 'No dialogue. 「はい」 0–15s BGMあり');
assert.throws(()=>bindings.decode('[[unknown]]'), /未定義/);
const graph = {writer:{inputs:{custom_prompt:JSON.stringify({instruction,story:content}),system_prompt:'Existing story and sound instructions.'}}};
bindings.prepare(graph);
const request = JSON.parse(graph.writer.inputs.custom_prompt);
assert.equal(request.instruction,instruction);
assert.equal(request.story,content);
assert.deepEqual(request.voice_bindings.map(v=>v.speaker),['S1','S2']);
assert.ok(!('allowed_dialogue' in request));
assert.doesNotMatch(graph.writer.inputs.system_prompt,/say:|cut:|caller inserts the dialogue|remain silent/);

const source=(await readFile(new URL('./web/director_dialog.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'').replaceAll('export ','');
const LLM=new Function(...Object.keys(llmModule),'crypto',source+'\nreturn DirectorLLM;')(...Object.values(llmModule),crypto);
const llm=new LLM({properties:{h3_llm:{loader:{},story:{inputs:{},parameters:{}},prompt:{inputs:{},parameters:{}}}}},()=>{});
llm.analyze=async()=>analysis;
let calls=0;
const generatedPrompt=`subject_definitions:
summary: A scene.
retention_analysis: Preserved.
detailed_description: ${content}
overall_soundscape: Room tone only.
non_diegetic_music: soft piano`;
llm.execute=async graph=>{
  calls++;
  if(graph.writer.inputs.system_prompt.includes('Return a concise editable story')) return content;
  return JSON.stringify({shots:[{prompt:generatedPrompt,start_state:`[[${male}]] waits.`,end_state:'Box on shelf.'}]});
};
const plan={shots:[{id:'cut2',duration_seconds:15},{id:'cut3',duration_seconds:15}]};
const state={instruction,story:'',sceneStory:'',includePrevious:true};
let returnedStory;
const single=await llm.create(plan,scene,1,state,'all',story=>{returnedStory=story;});
assert.equal(calls,2);
assert.equal(returnedStory,expected);
const expectedPrompt=llmModule.includeReferenceDefinitions(bindings.decode(generatedPrompt),analysis);
assert.equal(single[0].prompt,expectedPrompt);
assert.equal(single[0].start_state,'<Subject 3> waits.');
calls=0;
const all=await llm.create(plan,scene,null,state,'all',()=>{});
assert.equal(calls,3);
assert.equal(all.length,2);
for(const draft of all) assert.equal(draft.prompt,expectedPrompt,'No dialogue, silence, music or continuity may be inserted');
console.log('PASS: reference mappings, sparse media slots, saved analysis layout, unchanged narrative/audio text, and individual/whole-scene call counts.');

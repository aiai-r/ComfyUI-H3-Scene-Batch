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
assert.throws(()=>bindings.decode('<Subject 2> speaks.'),/固定ID/);
assert.throws(()=>bindings.decode('[[unknown]]'),/未定義/);
assert.throws(()=>bindings.decode(`[[say:${room}:line1:2:5]]`,15),/話者/);
assert.throws(()=>bindings.decode(`[[say:${male}:line1:14:18]]`,15),/範囲外/);
assert.throws(()=>bindings.decode(`[[say:${male}:invented:2:5]]`,15),/不正/);
const prompt = `subject_definitions:\nsummary: [reference generation]\nretention_analysis: reference\ndetailed_description: [[${male}]] stands in [[${room}]]. [[say:${male}:line1:2:5]]\noverall_soundscape: Room tone.\nnon_diegetic_music: N/A`;
const draft = bindings.finish({prompt,start_state:`[[${male}]] stands.`,end_state:'Box on shelf.'},analysis,15);
assert.match(draft.prompt, /<Subject 3> \(S2\) <Audio 2> says <d>\[Japanese\] 運ぼう<\/d>/);
assert.match(draft.prompt, /<Subject 3> stands in <Subject 2>/);
assert.equal((draft.prompt.match(/<d>/g)||[]).length,1);
assert.doesNotMatch(draft.prompt,/\[\[/);
assert.match(draft.prompt,/<Audio 2> is the voice-timbre reference for <Subject 3> \(S2\)/);
const silent = bindings.finish({prompt:prompt.replace(`[[say:${male}:line1:2:5]]`,'No dialogue or vocalizations.'),start_state:'Start',end_state:'End'},analysis,15);
assert.doesNotMatch(silent.prompt,/<d>/);
assert.match(silent.prompt,/All people remain silent throughout this cut/);
const collapsed = prompt.replace('subject_definitions:\n','subject_definitions: copied voice (S1), ').replaceAll('\n',' ')
  .replace(`[[say:${male}:line1:2:5]]`, '').replace('non_diegetic_music:', 'on_diegetic_music:') + ` [[say:[[${male}]]:line1:2:5]`;
const recovered = bindings.finish({prompt:collapsed,start_state:'Start',end_state:'End'},analysis,15,'The pencil is resting on the notebook.');
assert.match(recovered.prompt,/Opening continuity: The pencil is resting on the notebook/);
assert.match(recovered.prompt,/detailed_description:[\s\S]*<d>\[Japanese\] 運ぼう<\/d>[\s\S]*overall_soundscape:/);
assert.doesNotMatch(recovered.prompt,/copied voice|\[\[/);
assert.equal((recovered.prompt.match(/<d>/g)||[]).length,1);
const misplaced = prompt.replace(`[[say:${male}:line1:2:5]]`, `「運ぼう」 [[say:[[${male}]]:line1:2:5]`)
  + `, start_state: [[${male}]] is standing., end_state: [[${male}]] has set down the box.`;
const restored = bindings.finish({prompt:misplaced,start_state:'',end_state:''},analysis,15);
assert.equal(restored.start_state,'<Subject 3> is standing.');
assert.equal(restored.end_state,'<Subject 3> has set down the box.');
assert.equal((restored.prompt.match(/運ぼう/g)||[]).length,1);
assert.throws(()=>bindings.finish({prompt:prompt+' 「勝手な台詞」',start_state:'',end_state:''},analysis,15),/指定形式/);
const sparse = {mode:'R2V',assets:[{kind:'image',slot:0},{kind:'image',slot:2},{kind:'audio',slot:1}]};
const sparseAnalysis = '<Subject 1> is the room in <Picture 1>.\n<Subject 2> is the man in <Picture 2>.';
const sparseBindings = new DirectorBindings(sparseAnalysis, referenceDescriptions(sparse), sparse.assets, '画像3は音声2を参照音声として使用する。');
assert.deepEqual(sparseBindings.voices.map(v=>[v.label,v.audio]),[['<Subject 2>','<Audio 1>']]);
assert.throws(()=>new DirectorBindings(analysis+'\n<Subject 4> is another man in <Picture 3>.',referenceDescriptions(scene),scene.assets,instruction),/一意/);
const savedLayout = '<Subject 1> is the woman in <Picture 1>.\n\n<Picture 2> is the workshop background.\n\n<Picture 3> defines <Subject 2>, a man seen from three views.\n\n<Subject 2> is an adult man with gray hair.';
const savedBindings = new DirectorBindings(savedLayout,referenceDescriptions(scene),scene.assets,instruction);
assert.deepEqual(savedBindings.voices.map(v=>[v.label,v.audio]),[['<Subject 1>','<Audio 1>'],['<Subject 2>','<Audio 2>']]);
assert.equal(savedBindings.entries.find(e=>e.label==='<Picture 2>').id,'picture_2');
const female = bindings.voices[0].id;
const plan = {shots:[{id:'cut2',duration_seconds:15},{id:'cut3',duration_seconds:15}]};
const allocation = bindings.story(`[[cut:cut2]]\n[[${male}]] points to the box. [[say:[[${male}]]:line1:2:5]\n[[cut:cut3]]\n[[${female}]] nods. [[say:${female}:line2:0:2]]`,plan);
assert.match(allocation,/「運ぼう」/);
assert.match(allocation,/「はい」/);
assert.throws(()=>bindings.story('[[cut:cut2]]\nNo speech.',plan),/不完全/);
assert.throws(()=>bindings.story('[[cut:cut2]]\nNo speech.\n[[cut:cut3]]\nNo speech.',plan),/欠落/);
const droppedSpeech = prompt.replace(`[[say:${male}:line1:2:5]]`, '').replace('subject_definitions:\n','');
const inserted = bindings.finish({prompt:droppedSpeech,start_state:'Start',end_state:'End'},analysis,15,'',bindings.dialogueFor(allocation,'cut3'));
assert.match(inserted.prompt,/<Subject 1> \(S1\) <Audio 1> says <d>\[Japanese\] はい<\/d>/);
assert.doesNotMatch(inserted.prompt,/<d>\[Japanese\] 運ぼう/);
const timingConflict=bindings.finish({prompt:droppedSpeech.replace('reference\ndetailed_description:', 'reference\ndetailed_description: There is no dialogue for the first 5 seconds before he speaks.'),start_state:'',end_state:'End'},analysis,15,'Prior ending',bindings.dialogueFor(allocation,'cut3'));
assert.doesNotMatch(timingConflict.prompt,/no dialogue for the first 5 seconds/);
assert.equal(timingConflict.start_state,'Prior ending');
const copied=droppedSpeech.replace('detailed_description:',`detailed_description: At 3–4s, [[${female}]] [[audio_1]] says <d>[Japanese] はい</d>.`);
const once=bindings.finish({prompt:copied,start_state:'Start',end_state:'End'},analysis,15,'',bindings.dialogueFor(allocation,'cut3'));
assert.equal((once.prompt.match(/<d>/g)||[]).length,1);
assert.match(once.prompt,/At 0–2s, <Subject 1> \(S1\) <Audio 1>/);
console.log('Fixed references: visual/audio namespaces, sparse slots, exact dialogue, silent cuts, unknown IDs, ambiguous speakers and time bounds passed.');

const source=(await readFile(new URL('./web/director_dialog.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'').replaceAll('export ','');
const LLM=new Function(...Object.keys(llmModule),'crypto',source+'\nreturn DirectorLLM;')(...Object.values(llmModule),crypto);
const llm=new LLM({properties:{h3_llm:{loader:{},story:{inputs:{},parameters:{}},prompt:{inputs:{},parameters:{}}}}},()=>{});
llm.analyze=async()=>analysis;
let requests=[];
llm.execute=async graph=>{
  const request=JSON.parse(graph.writer.inputs.custom_prompt); requests.push(request);
  if(graph.writer.inputs.system_prompt.includes('Return a concise editable story')) {
    return request.selected_cut===null
      ? `[[cut:cut2]]\nMale moves. [[say:${male}:line1:0:3]]\n[[cut:cut3]]\nFemale responds. [[say:${female}:line2:0:2]]`
      : `[[cut:cut3]]\nFemale responds. [[say:${female}:line2:0:2]]`;
  }
  return JSON.stringify({shots:[{prompt:droppedSpeech,start_state:'Start',end_state:'Box on shelf.'}]});
};
const state={instruction,story:'',sceneStory:'',includePrevious:true};
const single=await llm.create(plan,scene,1,state,'all',()=>{});
assert.equal(requests.length,2,'Individual cut still uses one story and one Prompt call');
assert.match(single[0].prompt,/<d>\[Japanese\] はい<\/d>/);
assert.doesNotMatch(single[0].prompt,/<d>\[Japanese\] 運ぼう/);
requests=[];
const all=await llm.create(plan,scene,null,state,'all',()=>{});
assert.equal(requests.length,3,'Whole scene uses one story plus one Prompt per cut');
assert.equal(all.length,2);
assert.match(all[0].prompt,/<d>\[Japanese\] 運ぼう<\/d>/);
assert.match(all[1].prompt,/<d>\[Japanese\] はい<\/d>/);
assert.ok(all[1].prompt.includes(all[0].end_state));
console.log('Director integration: scoped individual allocation, whole-scene dialogue insertion and unchanged LLM call counts passed.');

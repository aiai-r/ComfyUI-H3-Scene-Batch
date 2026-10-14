import { readFile, writeFile } from 'node:fs/promises';

const [source, destination] = process.argv.slice(2);
const report = JSON.parse(await readFile(source,'utf8'));
const lines = [...report.instruction.matchAll(/「([^」]+)」/g)].map(m=>m[1]);
const rows = report.reports.map(run=>{
  const drafts=run.drafts??[];
  const spoken=drafts.flatMap(d=>[...d.prompt.matchAll(/<d>\[Japanese\] ([\s\S]*?)<\/d>/g)].map(m=>m[1]));
  const sections=['subject_definitions','summary','retention_analysis','detailed_description','overall_soundscape','non_diegetic_music'];
  const body=d=>d.prompt.split('detailed_description:')[1]?.split('overall_soundscape:')[0]??'';
  return {seed:run.seed, pipeline_completed:run.success, calls:run.calls.length,error:run.error,
    checks:{
      all_cuts:drafts.length===run.count,
      all_sections:drafts.length>0&&drafts.every(d=>sections.every(s=>d.prompt.includes(s+':'))),
      no_unresolved_ids:drafts.every(d=>!d.prompt.includes('[[')),
      visual_definitions:drafts.length>0&&drafts.every(d=>d.prompt.includes(report.analysis)),
      voice_mapping:drafts.length>0&&drafts.every(d=>d.prompt.includes('<Audio 1> is the voice-timbre reference for <Subject 1> (S1)')&&d.prompt.includes('<Audio 2> is the voice-timbre reference for <Subject 3> (S2)')),
      exact_dialogue_once:spoken.length===lines.length&&lines.every(line=>spoken.filter(s=>s===line).length===1),
      correct_dialogue_speakers:drafts.some(d=>d.prompt.includes(`<Subject 3> (S2) <Audio 2> says <d>[Japanese] ${lines[0]}</d>`))&&drafts.some(d=>d.prompt.includes(`<Subject 1> (S1) <Audio 1> says <d>[Japanese] ${lines[1]}</d>`)),
      silent_first_cut:drafts.length>0&&!body(drafts[0]).includes('<d>')&&/silent|no dialogue/i.test(body(drafts[0])),
      no_music:drafts.length>0&&drafts.every(d=>/non_diegetic_music:\s*N\/A\.?\s*$/.test(d.prompt)),
      previous_end_in_prompt:drafts.length>1&&drafts.slice(1).every((d,i)=>body(d).includes(drafts[i].end_state)),
      no_background_as_actor:drafts.every(d=>!/<Subject 2>\s+(?:says|speaks|watches|reaches|stands|walks)\b/i.test(body(d))),
      normal_completion:run.calls.every(c=>c.finish_reason==='stop'),
    },usage:run.calls.map(c=>({name:c.name,...c.usage}))};
});
await writeFile(destination,JSON.stringify({scope:'Controlled adult workshop scenario. Automated checks do not replace semantic reading or verify generated video/audio.',rows},null,2));
console.log(JSON.stringify(rows,null,2));

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import * as llmModule from '../web/director_llm.js';

const [destination, seedList = '101,202,303', replayDirectory] = process.argv.slice(2);
const output = resolve(destination);
await mkdir(output, { recursive: true });
const workflow = JSON.parse(await readFile('../../user/default/workflows/video_minimax_h3_scene_director_dev.json', 'utf8'));
const config = workflow.nodes.find(n => n.type === 'H3SceneDirector').properties.h3_llm;
config.story.parameters.max_tokens = 4096;
const originalCases = JSON.parse(await readFile('../../user/default/h3_story_verification/cases.json', 'utf8'));
const initial = JSON.parse(originalCases.cases[0].graph.writer.inputs.custom_prompt);
const scene = { mode: 'R2V', assets: [{kind:'image',file:'worker.png'}, {kind:'image',file:'workshop.png'}, {kind:'image',file:'supervisor.png'}, {kind:'audio',file:'worker.wav'}, {kind:'audio',file:'supervisor.wav'}] };
const source = (await readFile(new URL('../web/director_dialog.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '').replaceAll('export ', '');
const LLM = new Function(...Object.keys(llmModule), 'crypto', source + '\nreturn DirectorLLM;')(...Object.values(llmModule), crypto);
const log = createWriteStream(resolve(output, 'worker.log'));
const worker = spawn(resolve('../../venv/Scripts/python.exe'), [resolve('tools/reference_probe_worker.py')], { windowsHide:true, stdio:['pipe','pipe','pipe'], env:{...process.env, PYTHONIOENCODING:'utf-8'} });
worker.stderr.pipe(log);
let pending;
const exited = new Promise(resolveExit => worker.on('exit', (code) => { if (pending) pending.reject(new Error(`worker exited: ${code}`)); resolveExit(code); }));
createInterface({ input:worker.stdout }).on('line', line => {
  if (line.startsWith('PROBE_RESULT ')) { const result=JSON.parse(line.slice(13)); const current=pending; pending=null; current.resolve(result); }
  else log.write(line + '\n');
});
const reports = [];
try {
  for (const seed of seedList.split(',').map(Number)) {
    const run = {seed, count:4, calls:[], story:'', drafts:null};
    const plan = {shots:Array.from({length:4}, (_,i)=>({id:`cut${i+2}`,duration_seconds:15,prompt:''}))};
    const llm = new LLM({properties:{h3_llm:config}},()=>{});
    llm.analyze = async () => initial.image_analysis;
    llm.execute = async graph => {
      graph.writer.inputs.seed=seed;
      const name = `seed${seed}_call${run.calls.length+1}`;
      const request = {name,graph,output:resolve(output, name+'.json')};
      const cachedPath = replayDirectory && resolve(replayDirectory, name+'.json');
      if (cachedPath && existsSync(cachedPath)) {
        const cached = JSON.parse(await readFile(cachedPath,'utf8'));
        if (JSON.stringify(cached.graph) === JSON.stringify(graph)) {
          await writeFile(request.output,JSON.stringify({...cached,output:request.output,replayed_from:cachedPath},null,2));
          run.calls.push({name,finish_reason:cached.finish_reason,usage:cached.usage,replayed_from:cachedPath});
          console.log('REPLAY '+name);
          return cached.text;
        }
      }
      console.log('START '+name);
      const result = await new Promise((resolveResult,reject)=>{pending={resolve:resolveResult,reject};worker.stdin.write(JSON.stringify(request)+'\n');});
      run.calls.push({name,finish_reason:result.finish_reason,usage:result.usage});
      console.log('RETURN '+JSON.stringify(run.calls.at(-1)));
      return result.text;
    };
    try {
      run.drafts = await llm.create(plan,scene,null,{instruction:initial.instruction,story:'',sceneStory:'',includePrevious:true},'all',story=>{run.story=story;});
      run.success=true;
    } catch (error) {run.success=false;run.error=error.message;}
    reports.push(run);
    await writeFile(resolve(output,'report.json'),JSON.stringify({instruction:initial.instruction,analysis:initial.image_analysis,reports},null,2));
    console.log('RUN '+JSON.stringify({seed,success:run.success,error:run.error}));
    if (!run.success) break;
  }
} finally {
  worker.stdin.end();
  const code = await exited;
  log.end();
  console.log('WORKER_EXIT '+code);
}

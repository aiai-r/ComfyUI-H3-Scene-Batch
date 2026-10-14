import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DirectorBindings, readDraft, referenceDescriptions } from '../web/director_llm.js';

const [directory, destination] = process.argv.slice(2);
const report = JSON.parse(await readFile(resolve(directory,'report.json'),'utf8'));
const scene = {mode:'R2V',assets:[{kind:'image'},{kind:'image'},{kind:'image'},{kind:'audio'},{kind:'audio'}]};
for (const run of report.reports) {
  const bindings = new DirectorBindings(report.analysis,referenceDescriptions(scene),scene.assets,report.instruction);
  const plan = {shots:Array.from({length:run.count},(_,i)=>({id:`cut${i+2}`,duration_seconds:15}))};
  run.drafts=[];
  try {
    const first = JSON.parse(await readFile(resolve(directory,`seed${run.seed}_call1.json`),'utf8'));
    run.story=bindings.story(first.text,plan);
    for (let i=0;i<run.count;i++) {
      const response=JSON.parse(await readFile(resolve(directory,`seed${run.seed}_call${i+2}.json`),'utf8'));
      const [draft]=readDraft(response.text,plan,i);
      bindings.finish(draft,report.analysis,15,run.drafts[i-1]?.end_state??'',bindings.dialogueFor(run.story,plan.shots[i].id));
      run.drafts.push(draft);
    }
    run.success=true;
    delete run.error;
  } catch(error) {run.success=false;run.error=error.message;}
}
report.compilation='Saved real LLM responses recompiled using the current deterministic builder; no new LLM requests. Original input context remains in the per-call records.';
await writeFile(destination,JSON.stringify(report,null,2));
console.log(JSON.stringify(report.reports.map(r=>({seed:r.seed,success:r.success,error:r.error,drafts:r.drafts.length})),null,2));

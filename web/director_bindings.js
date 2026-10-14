// Keep media labels and voice assignments outside the writer's free-form text.
export class DirectorBindings {
  constructor(analysis, references, assets, instruction) {
    this.entries = [];
    const definitions = [...analysis.matchAll(/(?:^|\n)\s*<Subject\s+(\d+)>\s*(?:is\s+|:)?([^\n]+)/g)];
    for (const [, number, description] of definitions) {
      const label = `<Subject ${number}>`;
      if (this.entries.some(entry => entry.label === label)) continue;
      const name = description.split(/\s+(?:in|from|with|referenced)\b|[.<]/)[0]
        .replace(/^(?:an?|the)\s+/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60);
      const id = `${name || 'entity'}_${number}`;
      this.entries.push({ id, label, description, pictures: [...description.matchAll(/<Picture\s+(\d+)>/g)].map(m => Number(m[1])) });
    }
    // Picture-before-Subject introductions and separate definition paragraphs are common in saved analyses.
    for (const block of analysis.split(/\n\s*\n/)) {
      const subjects = [...new Set([...block.matchAll(/<Subject\s+(\d+)>/g)].map(m => `<Subject ${m[1]}>`))];
      if (subjects.length !== 1) continue;
      const entry = this.entries.find(e => e.label === subjects[0]);
      if (entry) entry.pictures = [...new Set([...entry.pictures, ...[...block.matchAll(/<Picture\s+(\d+)>/g)].map(m => Number(m[1]))])];
    }
    for (const reference of references) this.entries.push({ id: reference.label.slice(1, -1).toLowerCase().replace(' ', '_'), label: reference.label });
    this.voices = [];
    for (const match of instruction.matchAll(/画像\s*(\d+)[^、。\n]{0,40}?(?:音声|オーディオ)\s*(\d+)/g)) {
      if (!/参照音声|音声.{0,12}参照|声質|voice/i.test(instruction)) continue;
      const picture = references.find(r => r.kind === 'image' && (assets[r.asset_index].slot ?? assets.filter(a => a.kind === 'image').indexOf(assets[r.asset_index])) + 1 === Number(match[1]));
      const audio = references.find(r => r.kind === 'audio' && assets[r.asset_index].kind === 'audio' && (assets[r.asset_index].slot ?? assets.filter(a => a.kind === 'audio').indexOf(assets[r.asset_index])) + 1 === Number(match[2]));
      if (!picture || !audio) throw new Error(`画像${match[1]}と音声${match[2]}の参照素材が見つかりません。`);
      const subjects = this.entries.filter(e => e.pictures?.includes(Number(picture.label.match(/\d+/)[0])));
      if (subjects.length !== 1) throw new Error(`画像${match[1]}の話者を一意に特定できません。画像解析のSubject定義を確認してください。`);
      const existing = this.voices.find(v => v.id === subjects[0].id);
      if (existing && existing.audio !== audio.label) throw new Error(`画像${match[1]}の参照音声が重複しています。`);
      if (!existing) this.voices.push({ id: subjects[0].id, label: subjects[0].label, audio: audio.label, speaker: `S${this.voices.length + 1}` });
    }
    this.lines = [...instruction.matchAll(/「([^」]+)」/g)].map((m, i) => ({ id: `line${i + 1}`, text: m[1] }));
    this.noMusic = /BGM\s*(?:は)?\s*なし|音楽\s*(?:は)?\s*なし|no\s+(?:background\s+)?music/i.test(instruction);
  }

  encode(text) {
    return text.replace(/<(?:Subject|Picture|Audio|Video)\s+\d+>/g, label => {
      const entry = this.entries.find(e => e.label === label);
      return entry ? `[[${entry.id}]]` : label;
    });
  }

  prepare(graph, stage) {
    const request = JSON.parse(graph.writer.inputs.custom_prompt);
    const cutId = request.selected_cut_id ?? request.cuts.at(-1)?.id;
    const assigned = stage === 'prompt' ? this.dialogueFor(request.story, cutId) : null;
    const withoutDefinitions = text => text?.replace(/^subject_definitions\s*:[\s\S]*?(?=\bsummary\s*:)/i, '').replace(/\(S\d+\)/g, '');
    if (request.previous_prompt) request.previous_prompt = withoutDefinitions(request.previous_prompt);
    for (const cut of request.cuts ?? []) if (cut.prompt) cut.prompt = withoutDefinitions(cut.prompt);
    graph.writer.inputs.custom_prompt = this.encode(JSON.stringify(request));
    const encoded = JSON.parse(graph.writer.inputs.custom_prompt);
    encoded.fixed_references = this.entries.map(e => ({ id: `[[${e.id}]]`, definition: this.encode(e.description ?? e.label) }));
    encoded.voice_bindings = this.voices.map(v => ({ entity: `[[${v.id}]]`, voice: this.encode(v.audio) }));
    encoded.allowed_dialogue = this.lines;
    if (stage === 'prompt') encoded.selected_cut_id = cutId;
    graph.writer.inputs.custom_prompt = JSON.stringify(encoded);
    graph.writer.inputs.system_prompt = graph.writer.inputs.system_prompt.split('\n').filter(line => ![
      'Convert numbered user media references', 'In a speaking cut, include the voice mapping',
      'For requested speech, use stable speaker IDs', 'subject_definitions: The caller inserts',
    ].some(prefix => line.startsWith(prefix))).join('\n');
    graph.writer.inputs.system_prompt += '\n' + [
      'Use ONLY the exact [[fixed_reference_id]] tokens from fixed_references for subjects and media. The caller converts these to H3 labels. Never write numbered Subject/Picture/Audio/Video tags or S1/S2 speaker IDs yourself. Do not rename or change an entity identity. An environment is not a person.',
      'Voice assignments are fixed by voice_bindings and inserted by the caller. Never redefine them or write additional voice definitions.',
      stage === 'story'
        ? 'Return ONE section per requested cut, starting with [[cut:EXACT_CUT_ID]] (use its supplied ID, not its index). No closing cut marker is needed. No second outline or repeated reference definitions. Include duration, starting state, actions/camera, ending state and sound. Use Japanese prose when the instruction is Japanese. Allocate each allowed_dialogue line exactly once, inside its cut, using [[say:entity_id:line_id:start_seconds:end_seconds]]. IDs inside a say token are bare IDs without nested brackets. Times are local to the cut. Use the speaker requested by the user, not a different person. A silent cut has no say token. Do not copy dialogue words into action summaries; the caller inserts the original words.'
        : assigned !== null
          ? 'The caller inserts the dialogue already allocated in the story for selected_cut_id. Do not write say tokens, dialogue words or speaker/audio definitions in this prompt. Describe matching actions, reactions and pauses only. Do not change which cut contains each spoken line. Keep the existing shots JSON with prompt/start_state/end_state strings and the summary, retention_analysis, detailed_description, overall_soundscape and non_diegetic_music sections. The caller inserts subject_definitions.'
          : 'For each actual spoken line in detailed_description, write [[say:entity_id:line_id:start_seconds:end_seconds]]. Use REAL bare IDs from the supplied tables; do not nest [[brackets]] inside a say token. Times are local to this cut, numeric seconds, within its duration. The caller inserts exact words, voice and speaker IDs. Do not write dialogue text, <d> tags or speech elsewhere. A silent cut has no say token. Keep the existing shots JSON with prompt/start_state/end_state strings and all six prompt sections. Keep subject_definitions empty; the caller inserts all visual and voice definitions.',
    ].join('\n');
  }

  speechTokens(text) {
    return [...text.matchAll(/\[\[say:(?:\[\[)?([a-z0-9_]+)(?:\]\])?:([a-z0-9_]+):([\d.]+):([\d.]+)\]{1,2}/gi)]
      .map(([, id, line, start, end]) => `[[say:${id}:${line}:${Math.min(Number(start), Number(end))}:${Math.max(Number(start), Number(end))}]]`);
  }

  dialogueFor(story, id) {
    const blocks = [...story.matchAll(/\[\[cut:([^\]]+)\]\]([\s\S]*?)(?=\[\[cut:|$)/g)];
    if (!blocks.length) return null;
    const block = blocks.find(m => m[1] === id);
    if (!block) throw new Error(`ストーリーにカット ${id} の割り振りがありません。`);
    return this.speechTokens(block[2]);
  }

  story(text, plan, allDialogue = true) {
    const blocks = [...text.matchAll(/\[\[cut:([^\]]+)\]\]([\s\S]*?)(?=\[\[cut:|$)/g)];
    const expected = plan.shots.map((shot, i) => shot.id ?? `cut${i + 1}`);
    const missing = expected.filter(id => !blocks.some(m => m[1] === id));
    if (blocks.length !== expected.length || missing.length) throw new Error(`ストーリーのカット割り振りが不完全です。必要: ${expected.join(', ')} / 返答: ${blocks.map(m => m[1]).join(', ') || 'IDなし'}`);
    const assigned = [];
    const result = expected.map((id, i) => {
      const block = blocks.find(m => m[1] === id)[2];
      const tokens = this.speechTokens(block);
      this.decode(tokens.join('\n'), plan.shots[i].duration_seconds ?? plan.defaults?.duration_seconds ?? 15);
      assigned.push(...tokens.map(token => token.split(':')[2]));
      const prose = block.replace(/\[\[say:(?:\[\[)?([a-z0-9_]+)(?:\]\])?:([a-z0-9_]+):([\d.]+):([\d.]+)\]{1,2}/gi, '').replaceAll('[[/cut]]', '').trim();
      return `[[cut:${id}]]\n${this.decode(prose)}\n${tokens.map(token => `${token} 「${this.lines.find(line => line.id === token.split(':')[2]).text}」`).join('\n')}`;
    });
    if (this.lines.some(line => assigned.filter(id => id === line.id).length > 1 || allDialogue && !assigned.includes(line.id))) throw new Error('ストーリーの指定台詞に欠落または重複があります。');
    return result.join('\n\n');
  }

  decode(text, duration = null) {
    text = text.replace(/\{\{([a-z0-9_]+)\}\}/gi, '[[$1]]');
    if (/<(?:Subject|Picture|Audio|Video)\s+\d+>|\bS\d+\b/.test(text)) throw new Error('LLMが固定IDではなく参照番号を直接返しました。再作成してください。');
    const used = new Set();
    let result = text.replace(/\[\[say:([^:\]]+):([^:\]]+):([\d.]+):([\d.]+)\]\]/g, (_, id, lineId, start, end) => {
      const voice = this.voices.find(v => v.id === id);
      const entity = this.entries.find(e => e.id === id && e.pictures);
      const line = this.lines.find(l => l.id === lineId);
      if (!entity || !line) throw new Error(`台詞の参照が不正です: ${id}/${lineId}`);
      if (!voice) throw new Error(`台詞の話者が音声対応表にありません: ${id}`);
      if (!(Number(start) >= 0 && Number(end) > Number(start) && duration !== null && Number(end) <= duration)) throw new Error(`台詞${lineId}の時刻がカットの範囲外です: ${start}–${end}秒`);
      if (used.has(lineId)) throw new Error(`台詞${lineId}が同じカットで重複しています。`);
      used.add(lineId);
      return `At ${start}–${end}s, ${entity.label} (${voice.speaker}) ${voice.audio} says <d>[Japanese] ${line.text}</d>.`;
    });
    result = result.replace(/\[\[([^\]]+)\]\]/g, (_, id) => {
      const entry = this.entries.find(e => e.id === id);
      if (!entry) throw new Error(`LLMが未定義の参照IDを返しました: ${id}`);
      return entry.label;
    });
    return result;
  }

  finish(draft, analysis, duration, previousEnd = '', assigned = null) {
    if (!draft.start_state && !draft.end_state) {
      const states = draft.prompt.match(/[,;\n]\s*start_state:\s*([\s\S]*?)[,;\n]\s*end_state:\s*([\s\S]*)$/i);
      if (states) {
        draft.start_state = states[1].trim(); draft.end_state = states[2].trim();
        draft.prompt = draft.prompt.slice(0, states.index);
      }
    }
    const speech = [];
    draft.prompt = draft.prompt.replace(/\[\[say:(?:\[\[)?([a-z0-9_]+)(?:\]\])?:([a-z0-9_]+):([\d.]+):([\d.]+)\]{1,2}/gi, (_, id, line, start, end) => {
      speech.push(`[[say:${id}:${line}:${start}:${end}]]`);
      return '';
    }).replace(/\bon_diegetic_music\s*:/gi, 'non_diegetic_music:');
    const chosen = assigned ?? speech;
    const dialogue = this.decode(chosen.join('\n'), duration);
    draft.prompt = draft.prompt.replace(/\bAt\s+[\d.]+[–-][\d.]+s,\s*(?:(?:\[\[[a-z0-9_]+\]\]|\(S\d+\))\s*)+says\s*<d>\[Japanese\]\s*([^<]+)<\/d>\.?/gi,
      (clause, words) => this.lines.some(line => line.text === words.trim()) ? '' : clause);
    for (const line of this.lines) {
      if (chosen.some(token => token.includes(`:${line.id}:`))) draft.prompt = draft.prompt.replaceAll(`「${line.text}」`, '');
    }
    if (/<d>|「|」/.test(draft.prompt) || this.lines.some(line => draft.prompt.includes(line.text))) throw new Error('LLMが台詞を指定形式の外に書きました。Promptを再作成してください。');
    draft.start_state = this.decode(draft.start_state);
    draft.end_state = this.decode(draft.end_state);
    if (!draft.start_state && previousEnd) draft.start_state = previousEnd;
    const voiceDefinitions = this.voices.map(v => `${v.audio} is the voice-timbre reference for ${v.label} (${v.speaker}); reference only, not a recording to play. It is audible only for explicitly marked dialogue.`).join('\n');
    const sections = ['subject_definitions', 'summary', 'retention_analysis', 'detailed_description', 'overall_soundscape', 'non_diegetic_music'];
    if (/^\s*summary\s*:/i.test(draft.prompt)) draft.prompt = 'subject_definitions:\n' + draft.prompt;
    const headings = [...draft.prompt.matchAll(/\b(subject_definitions|summary|retention_analysis|detailed_description|overall_soundscape|non_diegetic_music)\s*:/gi)];
    for (const [index, name] of sections.entries()) if (headings[index]?.[1].toLowerCase() !== name) throw new Error(`Promptの${name}セクションが欠落または順序不正です。`);
    if (headings.length !== sections.length) throw new Error('Promptのセクションが重複しています。');
    const values = headings.map((h, i) => i === 0 ? `${analysis}\n${voiceDefinitions}` : this.decode(draft.prompt.slice(h.index + h[0].length, headings[i + 1]?.index).trim()));
    // Speech timing comes from the allocation, not a second description of silence from the writer.
    values[3] = values[3].replace(/\bThere (?:is|will be) no (?:dialogue|speech)[^.!?\n]*[.!?]?/gi, '').trim();
    if (dialogue) values[3] += `\n${dialogue}`;
    const speechRule = /<d>/.test(values[3])
      ? 'Speak only the marked dialogue in its assigned intervals, once each. No other dialogue, monologue, narration or vocalizations.'
      : 'All people remain silent throughout this cut. No dialogue, monologue, narration or vocalizations; attached voice references must not be heard.';
    values[3] += `\n${speechRule}`;
    values[4] += `\n${speechRule}`;
    if (this.noMusic) values[5] = 'N/A';
    if (previousEnd) values[3] = `Opening continuity: ${previousEnd}\n${values[3]}`;
    if (!/\[Shot\s+1\]/i.test(values[3])) values[3] = `[Shot 1] ${values[3]}`;
    draft.prompt = sections.map((name, i) => `${name}:\n${values[i]}`).join('\n\n');
    return draft;
  }
}

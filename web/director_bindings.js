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
  }

  encode(text) {
    return text.replace(/<(?:Subject|Picture|Audio|Video)\s+\d+>/g, label => {
      const entry = this.entries.find(e => e.label === label);
      return entry ? `[[${entry.id}]]` : label;
    });
  }

  prepare(graph) {
    const request = JSON.parse(this.encode(graph.writer.inputs.custom_prompt));
    request.fixed_references = this.entries.map(e => ({ id: `[[${e.id}]]`, definition: this.encode(e.description ?? e.label) }));
    request.voice_bindings = this.voices.map(v => ({ entity: `[[${v.id}]]`, voice: this.encode(v.audio), speaker: v.speaker }));
    graph.writer.inputs.custom_prompt = JSON.stringify(request);
    graph.writer.inputs.system_prompt = graph.writer.inputs.system_prompt.split('\n')
      .filter(line => !line.startsWith('Convert numbered user media references')).join('\n');
    graph.writer.inputs.system_prompt += '\nUse the exact [[fixed_reference_id]] tokens from fixed_references instead of numbered Subject/Picture/Audio/Video tags. The caller substitutes only these reference tokens with their H3 labels. Keep the identities and voice/speaker associations in voice_bindings. Write the story, actions, dialogue, timing and sound instructions yourself in the existing output format.';
  }

  decode(text) {
    return text.replace(/\[\[([^\]]+)\]\]/g, (_, id) => {
      const entry = this.entries.find(e => e.id === id);
      if (!entry) throw new Error(`LLMが未定義の参照IDを返しました: ${id}`);
      return entry.label;
    });
  }
}

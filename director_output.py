import json
import os
import sys
from pathlib import Path
from uuid import uuid4

import folder_paths
import nodes
from comfy_extras.nodes_audio import load as load_audio

from .director_project import contained, write_json


def context_loop():
    # Use the installed loop's media/timing helpers without changing its nodes.
    return sys.modules[nodes.NODE_CLASS_MAPPINGS['MiniMaxH3ChainLoopEnd'].__module__]


class H3SceneSegmentSave:
    @classmethod
    def INPUT_TYPES(cls):
        return {'required': {'state': ('H3_CHAIN_STATE',), 'images': ('IMAGE',), 'audio': ('AUDIO',)}}

    RETURN_TYPES = ('H3_CHAIN_SEGMENT', 'STRING')
    RETURN_NAMES = ('segment', 'status')
    FUNCTION = 'save'
    OUTPUT_NODE = True
    CATEGORY = 'H3 Scene Batch'

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float('nan')

    def save(self, state, images, audio):
        chain = context_loop()
        plan, index = state['plan'], int(state['index'])
        shot = plan['shots'][index - 1]
        if int(images.shape[0]) != int(shot['delivered_frames']):
            raise ValueError('Loop Trimの出力をH3 Scene Segment Saveへ接続してください。')
        waveform, sample_rate = chain._validate_audio(audio, 'Director delivered audio', expected_frames=shot['delivered_frames'])
        overlap = audio.get(chain.AUDIO_WITH_OVERLAP_WAVEFORM_KEY)
        if overlap is not None:
            if int(audio[chain.AUDIO_WITH_OVERLAP_FRAMES_KEY]) != int(shot['raw_frames']):
                raise ValueError('Directorの音声とカットのフレーム数が一致しません。')
            chain._validate_audio({'waveform': overlap, 'sample_rate': sample_rate}, 'Director overlap audio', expected_frames=shot['raw_frames'])
        root = Path(folder_paths.get_output_directory()).resolve()
        run = contained(root / 'h3_chains', plan['run_name'])
        stem = f'clip_{index:04d}.{uuid4().hex}'
        video = run / 'segments' / (stem + '.mp4')
        sound = run / 'generated_audio' / (stem + '.wav')
        metadata = run / 'segments' / (stem + '.json')
        chain._write_segment_video(images, str(video), chain.FPS, plan['segment_crf'], metadata={'comment': shot['prompt']})
        chain._atomic_float_wav({'waveform': waveform, 'sample_rate': sample_rate}, str(sound))
        segment = {key: shot[key] for key in ('id', 'raw_frames', 'delivered_frames', 'seed', 'steps', 'prompt', 'scene_prompt')}
        segment.update(index=index, segment=video.relative_to(root).as_posix(), metadata=metadata.relative_to(root).as_posix(),
                       generated_audio=sound.relative_to(root).as_posix(), sample_rate=sample_rate,
                       continuation_mode=shot.get('continuation_mode', plan['compatibility']['continuation_mode']),
                       context_length=shot.get('context_length', plan['compatibility']['context_length']),
                       audio_context_length=shot.get('audio_context_length', plan['compatibility']['audio_context_length']))
        if shot.get('resolution'):
            segment['resolution'] = shot['resolution']
        record = {'format': 'h3_director_segment_v1', 'segment': segment}
        if overlap is not None:
            overlap_path = sound.with_name(stem + '.overlap.wav')
            chain._atomic_float_wav({'waveform': overlap, 'sample_rate': sample_rate}, str(overlap_path))
            record['audio_with_overlap'] = overlap_path.relative_to(root).as_posix()
        write_json(metadata, record)
        return segment, f'カット {index}/{len(plan["shots"])}：動画・音声を保存しました。'


class H3SceneAssemble:
    @classmethod
    def INPUT_TYPES(cls):
        return {'required': {'manifest': ('H3_CHAIN_MANIFEST',),
                             'filename': ('STRING', {'default': 'scene'}),
                             'audio_bitrate': ('INT', {'default': 256, 'min': 64, 'max': 512})}}

    RETURN_TYPES = ('STRING',)
    RETURN_NAMES = ('video_path',)
    FUNCTION = 'assemble'
    OUTPUT_NODE = True
    CATEGORY = 'H3 Scene Batch'

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float('nan')

    def assemble(self, manifest, filename, audio_bitrate):
        chain = context_loop()
        root = Path(folder_paths.get_output_directory()).resolve()
        run = contained(root / 'h3_chains', manifest['run_name'])
        segments = manifest['segments']
        if len(segments) != manifest['clip_count'] or not segments:
            raise ValueError('Directorの完成カットが揃っていません。')
        records, paths, lengths = [], [], []
        sample_rate = None
        for index, segment in enumerate(segments, 1):
            if segment['index'] != index:
                raise ValueError('Directorのカット順序が一致しません。')
            saved = json.loads(contained(root, segment['metadata']).read_text(encoding='utf-8'))
            if saved['format'] != 'h3_director_segment_v1' or saved['segment']['segment'] != segment['segment']:
                raise ValueError('Directorの保存カットと動画が一致しません。')
            waveform, rate = load_audio(str(contained(root, segment['generated_audio'])))
            if sample_rate is not None and rate != sample_rate:
                raise ValueError('カット間で音声のサンプルレートが異なります。')
            sample_rate = rate
            overlap = None
            if saved.get('audio_with_overlap'):
                overlap, overlap_rate = load_audio(str(contained(root, saved['audio_with_overlap'])))
                if overlap_rate != rate:
                    raise ValueError('カットの音声と接続音声のサンプルレートが異なります。')
            records.append({'segment': segment, 'delivered': waveform, 'overlap': overlap,
                            'delivered_frames': segment['delivered_frames'], 'raw_frames': segment['raw_frames'],
                            'repeated_frames': segment['raw_frames'] - segment['delivered_frames'],
                            'mode': segment['continuation_mode']})
            paths.append(str(contained(root, segment['segment'])))
            lengths.append(segment['delivered_frames'])
        if sum(lengths) != manifest['total_delivered_frames']:
            raise ValueError('Directorの完成尺とカットの合計尺が一致しません。')
        audio = chain._assemble_generated_audio_records(records, sample_rate)
        directory = run / 'final'
        directory.mkdir(parents=True, exist_ok=True)
        target = contained(directory, filename + '.mp4')
        target.parent.mkdir(parents=True, exist_ok=True)
        suffix = 1
        while target.exists():
            target = contained(directory, f'{filename}_{suffix:03d}.mp4'); suffix += 1
        temporary = target.with_name(target.stem + '.' + uuid4().hex + '.tmp.mp4')
        picture = temporary.with_name(temporary.stem + '.video.mp4')
        try:
            chain._pyav_concat_video(paths, lengths, str(picture), {'comment': manifest.get('prompt_prefix', '')})
            chain._pyav_mux_audio(str(picture), audio, str(temporary), audio_bitrate, sum(lengths))
            os.replace(temporary, target)
        finally:
            picture.unlink(missing_ok=True)
            temporary.unlink(missing_ok=True)
        return (str(target),)

import importlib
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

import av
import torch

from test_media import package
from remove_director_checkpoints import migrate, connect_project_outputs, director_loop
from comfy_execution.graph import DynamicPrompt

output = importlib.import_module(package.__name__ + '.director_output')
project = importlib.import_module(package.__name__ + '.director_project')


class DirectorOutputTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = Path(__file__).resolve().parents[2]
        package = types.ModuleType('director_output_loop_test')
        package.__path__ = [str(root / 'custom_nodes/ComfyUI-MiniMaxH3-Context-Loop')]
        sys.modules[package.__name__] = package
        server = types.ModuleType('server'); server.PromptServer = None
        with patch.dict(sys.modules, {'server': server}):
            cls.chain = importlib.import_module(package.__name__ + '.chain_nodes')

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(); self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.enterContext(patch.dict(sys.modules, {self.chain.__name__: self.chain}))
        self.enterContext(patch.object(project.folder_paths, 'get_output_directory', return_value=str(self.root / 'comfy-output')))
        self.enterContext(patch.dict(output.nodes.NODE_CLASS_MAPPINGS, {'MiniMaxH3ChainLoopEnd': self.chain.MiniMaxH3ChainLoopEnd}))
        self.enterContext(patch.object(self.chain, '_st_save', side_effect=AssertionError('No checkpoint writes')))
        self.enterContext(patch.object(self.chain, '_st_load', side_effect=AssertionError('No checkpoint reads')))
        self.enterContext(patch.object(self.chain, '_load_run_editorial', side_effect=AssertionError('No editorial reads')))
        self.enterContext(patch.object(self.chain, '_run_archive_paths', side_effect=AssertionError('No archive checks')))
        self.enterContext(patch.object(self.chain, '_run_dir', side_effect=AssertionError('No Context Loop output access')))

    def test_two_cut_audio_video_and_live_continuity_without_checkpoints(self):
        for external in (False, True):
            with self.subTest(external=external):
                self.check_two_cut_output(external)

    def check_two_cut_output(self, external):
        root = self.root / 'cloud upload' if external else project.project_path('MyScenes')
        root.mkdir(parents=True, exist_ok=True)
        project.write_json(root / 'scenes.json', [])
        destination = {'project': str(root) if external else 'MyScenes',
                       **({'directory': 'batches/batch-test/scene_0012_attempt1'} if external else {})}
        scene = {'mode': 'T2V', 'assets': [], 'output': destination}
        chain = self.chain
        policy = chain.MiniMaxH3GenerationProfile().build('Hard picture + smooth audio', 'Generate audio')[0]
        authored = json.dumps({'shots': [{'id': 'a', 'prompt': 'First', 'length': 73}, {'id': 'b', 'prompt': 'Second', 'length': 73}]})
        plan = chain.MiniMaxH3ChainPlanModern().build(plan_json=authored, chain_policy=policy, run_name='director_test',
            generation_fingerprint='director-output-test',
            width=64, height=64, encode_mode='video', crop='disabled', default_duration_seconds=3, default_steps=4,
            base_seed=1, segment_crf=18, video_blend_frames=0)[0]
        state = chain.MiniMaxH3ChainLoopStart().start(plan, 1)[1]
        latent = {'samples': [torch.ones(1, 32, 18, 8, 8), torch.ones(1, 8, 2, 122)]}
        end = output.H3SceneLoopEnd()
        delivered, original_audio = [], []
        for index in (1, 2):
            shot = plan['shots'][index - 1]
            frames = shot['delivered_frames']
            images = torch.full((frames, 64, 64, 3), 0.25 * index)
            count = chain.sample_boundary_from_frames(frames, 32000)
            waveform = torch.full((1, 2, count), 0.1 * index)
            audio = {'waveform': waveform, 'sample_rate': 32000}
            if index == 2:
                raw = chain.sample_boundary_from_frames(shot['raw_frames'], 32000)
                audio.update({chain.AUDIO_WITH_OVERLAP_WAVEFORM_KEY: torch.full((1, 2, raw), 0.2),
                              chain.AUDIO_WITH_OVERLAP_FRAMES_KEY: shot['raw_frames'],
                              chain.AUDIO_TRIM_FRAMES_KEY: shot['raw_frames'] - frames})
            segment = output.H3SceneSegmentSave().save(state, images, audio, scene)[0]
            delivered.append(segment)
            original_audio.append({'segment': segment, 'delivered': waveform[0],
                'overlap': audio[chain.AUDIO_WITH_OVERLAP_WAVEFORM_KEY][0] if index == 2 else None,
                'delivered_frames': frames, 'raw_frames': shot['raw_frames'],
                'repeated_frames': shot['raw_frames'] - frames, 'mode': segment['continuation_mode']})
            if index == 1:
                with patch.object(chain.MiniMaxH3ChainLoopEnd, '_recurse', side_effect=lambda flow, next_state, *args: next_state):
                    next_state = end.end(['start', 0], state, images, latent, segment)
                torch.testing.assert_close(next_state['previous_frames'], images[-39:])
                torch.testing.assert_close(next_state['previous_latent']['samples'][0], latent['samples'][0])
                state = chain.MiniMaxH3ChainLoopStart().start(plan, 1, initial_state=next_state)[1]
                self.assertIs(chain._selected_context_state(state), state)
            else:
                manifest, manifest_json, _, _ = end.end(['start', 0], state, images, latent, segment)
        real_assembly = chain._assemble_generated_audio_records
        seen = []
        def assemble_audio(records, rate):
            audio = real_assembly(records, rate); seen.append(audio); return audio
        with patch.object(chain, '_assemble_generated_audio_records', side_effect=assemble_audio):
            path = output.H3SceneAssemble().assemble(manifest, 'scene', 256, scene)[0]
        self.assertEqual(Path(path).relative_to(root).as_posix(),
                         'batches/batch-test/scene_0012_attempt1/scene.mp4' if external else 'renders/director_test/scene.mp4')
        boundary = chain.sample_boundary_from_frames(73 - 39, 32000)
        torch.testing.assert_close(seen[0]['waveform'][..., :boundary], torch.full((2, boundary), 0.1))
        torch.testing.assert_close(seen[0]['waveform'], real_assembly(original_audio, 32000)['waveform'], rtol=0, atol=0)
        torch.testing.assert_close(seen[0]['waveform'][..., boundary:boundary + 100], torch.full((2, 100), 0.2))
        with av.open(path) as container:
            self.assertEqual(container.streams.video[0].frames, sum(s['delivered_frames'] for s in delivered))
            self.assertEqual(len(container.streams.audio), 1)
            self.assertEqual(sum(1 for _ in container.decode(video=0)), manifest['total_delivered_frames'])
        scene['execution'] = {'run_name': plan['run_name'], 'plan': {'shots': [{}, {}]}, 'asset_hashes': {}}
        result = project.H3SceneResult().record(path, scene, manifest_json)['ui']
        self.assertEqual(project.video_file(result['h3_scene_result'][0]['video']), Path(path))
        queue = types.SimpleNamespace(get_history=lambda pid: {pid: {'status': {'status_str': 'success'}, 'outputs': {'result': result}}})
        project.adopt(root, queue, 'test', 'result', 'Two cuts')
        saved = json.loads((root / 'scenes.json').read_text(encoding='utf-8'))[0]
        self.assertNotIn('output', saved['scene'])
        self.assertEqual([s['prompt'] for s in saved['plan']['shots']], ['First', 'Second'])
        self.assertEqual(list(self.root.rglob('*.safetensors')), [])
        self.assertEqual(list(self.root.rglob('checkpoints')), [])
        self.assertEqual(list(self.root.rglob('h3_chains')), [])
        self.assertNotEqual(output.H3SceneAssemble().assemble(manifest, 'scene', 256, scene)[0], path)
        with self.assertRaises(ValueError):
            output.H3SceneAssemble().assemble(manifest, '../../../../../escape', 256, scene)
        with self.assertRaises(ValueError):
            output.run_directory({'output': {**destination, 'directory': '../escape'}}, 'trial')

    def test_director_loop_recurses_without_cloning_final_outputs(self):
        graph = {
            'start': {'class_type': 'MiniMaxH3ChainLoopStart', 'inputs': {'plan': ['director', 0], 'start_clip': 1}},
            'director': {'class_type': 'H3SceneDirector', 'inputs': {}},
            'current': {'class_type': 'MiniMaxH3ChainCurrent', 'inputs': {'state': ['start', 1]}},
            'sampler': {'class_type': 'SamplerCustomAdvanced', 'inputs': {'noise': ['current', 5]}},
            'decode': {'class_type': 'VAEDecode', 'inputs': {'samples': ['sampler', 0]}},
            'save': {'class_type': 'H3SceneSegmentSave', 'inputs': {'state': ['current', 0], 'images': ['decode', 0], 'scene': ['director', 2]}},
            'end': {'class_type': 'H3SceneLoopEnd', 'inputs': {'flow': ['start', 0], 'state': ['current', 0],
                    'images': ['decode', 0], 'sampled_latent': ['sampler', 0], 'segment': ['save', 0]}},
            'assemble': {'class_type': 'H3SceneAssemble', 'inputs': {'manifest': ['end', 0], 'scene': ['director', 2]}},
            'result': {'class_type': 'H3SceneResult', 'inputs': {'video_path': ['assemble', 0], 'scene': ['director', 2]}},
        }
        self.enterContext(patch.dict(output.nodes.NODE_CLASS_MAPPINGS, package.NODE_CLASS_MAPPINGS))
        dynamic = DynamicPrompt(graph)
        end_id, start_id = 'end', 'start'
        plan = {'shots': [{}, {}, {}], 'compatibility': {'context_length': 1}, 'run_name': 'three',
                'plan_hash': 'test', 'total_delivered_frames': 3}
        state = {'plan': plan, 'index': 1, 'segments': []}
        latent = {'samples': [torch.ones(1, 32, 18, 8, 8), torch.ones(1, 8, 2, 122)]}
        for index in (1, 2):
            expanded = output.H3SceneLoopEnd().end([start_id, 0], state, torch.ones(1, 2, 2, 3),
                latent, {'index': index}, dynamic, end_id)
            self.assertEqual(sorted(n['class_type'] for n in expanded['expand'].values()),
                             sorted(graph[key]['class_type'] for key in ('start', 'current', 'sampler', 'decode', 'save', 'end')))
            for key, node in expanded['expand'].items():
                dynamic.add_ephemeral_node(key, node, end_id, node['override_display_id'])
            end_id = expanded['result'][0][0]
            start_id = dynamic.get_node(end_id)['inputs']['flow'][0]
            state = dynamic.get_node(start_id)['inputs']['initial_state']
            self.assertEqual(state['index'], index + 1)
        result = output.H3SceneLoopEnd().end([start_id, 0], state, torch.ones(1, 2, 2, 3),
            latent, {'index': 3}, dynamic, end_id)
        self.assertEqual([s['index'] for s in result[0]['segments']], [1, 2, 3])

    def test_director_loop_migration_preserves_other_settings(self):
        root = Path(__file__).resolve().parents[2]
        source = json.loads((root / 'user/default/workflows/video_minimax_h3_scene_director_dev.director-loop-backup.json').read_bytes())
        updated = director_loop(source)
        self.assertEqual(director_loop(updated), updated)
        for before, after in zip([source, *source['definitions']['subgraphs']], [updated, *updated['definitions']['subgraphs']]):
            self.assertEqual(before['links'], after['links'])
            for old, new in zip(before['nodes'], after['nodes']):
                if old['type'] != 'MiniMaxH3ChainLoopEnd':
                    self.assertEqual(old, new)
                else:
                    self.assertEqual(new['type'], 'H3SceneLoopEnd')
                    self.assertEqual(old['outputs'], new['outputs'])
                    self.assertEqual(old['pos'], new['pos'])
                    self.assertEqual(old.get('title'), new.get('title'))

    def test_project_output_wiring_preserves_workflow(self):
        root = Path(__file__).resolve().parents[2]
        source = json.loads((root / 'user/default/workflows/video_minimax_h3_scene_director_dev.project-output-backup.json').read_bytes())
        actual = connect_project_outputs(source)
        self.assertEqual(connect_project_outputs(actual), actual)
        for before, after in zip([source, *source['definitions']['subgraphs']], [actual, *actual['definitions']['subgraphs']]):
            old_links = {l['id'] if isinstance(l, dict) else l[0] for l in before['links']}
            added = [l for l in after['links'] if (l['id'] if isinstance(l, dict) else l[0]) not in old_links]
            self.assertEqual(len(added), 1)
            for old, new in zip(before['nodes'], after['nodes']):
                expected = json.loads(json.dumps(new))
                if old['type'] in ('H3SceneSegmentSave', 'H3SceneAssemble'):
                    self.assertEqual(expected['inputs'][-1]['name'], 'scene')
                    expected['inputs'].pop()
                for output in expected.get('outputs', []):
                    if output.get('links'): output['links'] = [i for i in output['links'] if i in old_links]
                self.assertEqual(expected, old)

    def test_workflow_migration_preserves_other_nodes_and_wiring(self):
        root = Path(__file__).resolve().parents[2]
        source = json.loads((root / 'user/default/workflows/video_minimax_h3_scene_director_dev.json').read_bytes())
        migrated = migrate(source)
        for before, after in zip([source, *source['definitions']['subgraphs']], [migrated, *migrated['definitions']['subgraphs']]):
            changed_links = {l['id'] if isinstance(l, dict) else l[0]: l for l in after['links']}
            for old, new in zip(before['nodes'], after['nodes']):
                if old['id'] not in (1205, 1207):
                    expected = json.loads(json.dumps(old))
                    for item in expected.get('outputs', []):
                        if item.get('links'): item['links'] = [i for i in item['links'] if i in changed_links]
                    self.assertEqual(new, expected)
                self.assertEqual(new.get('title'), old.get('title'))
                for slot, item in enumerate(new.get('inputs', [])):
                    if item.get('link') is not None:
                        link = changed_links[item['link']]
                        self.assertEqual(link['target_slot'] if isinstance(link, dict) else link[4], slot)
        self.assertEqual(migrate(migrated), migrated)


if __name__ == '__main__':
    unittest.main()

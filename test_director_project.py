import copy
import importlib
import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import av
import numpy as np
from PIL import Image

from test_media import package

project = importlib.import_module(package.__name__ + '.director_project')
director = importlib.import_module(package.__name__ + '.director')
from complete_director_workflow import complete, clean_layout, REMOVED_INPUTS


class Queue:
    def __init__(self):
        self.history = {}
        self.running = []
        self.pending = []
        self.interrupted = []

    def get_history(self, prompt_id):
        return {prompt_id: self.history[prompt_id]} if prompt_id in self.history else {}

    def get_current_queue(self):
        return self.running, self.pending

    def delete_queue_item(self, predicate):
        self.pending = [item for item in self.pending if not predicate(item)]

    def interrupt_if_running(self, prompt_id):
        self.interrupted.append(prompt_id)


class DirectorProjectTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.input = self.root / 'input'; self.input.mkdir()
        self.output = self.root / 'output'; self.output.mkdir()
        self.enterContext(patch.object(project.folder_paths, 'get_input_directory', return_value=str(self.input)))
        self.enterContext(patch.object(project.folder_paths, 'get_output_directory', return_value=str(self.output)))
        Image.new('RGB', (32, 32), 'green').save(self.input / 'ref.png')
        with av.open(str(self.output / 'result.mp4'), 'w') as container:
            stream = container.add_stream('libx264', rate=24)
            stream.width = stream.height = 32
            stream.pix_fmt = 'yuv420p'
            for _ in range(24):
                for packet in stream.encode(av.VideoFrame.from_ndarray(np.zeros((32, 32, 3), dtype=np.uint8), format='rgb24')):
                    container.mux(packet)
            for packet in stream.encode():
                container.mux(packet)
        self.queue = Queue()
        self.plan = {'shots': [{'id': 'one', 'prompt': 'A garden.', 'duration_seconds': 15, 'seed': '18446744073709551615'},
                               {'id': 'two', 'prompt': 'Continue past the gate.', 'duration_seconds': 15, 'seed': '0'}]}

    def result(self, mode='R2V', run_name='trial'):
        assets = [] if mode == 'T2V' else [{'kind': 'image', 'file': 'ref.png', 'role': 'reference' if mode == 'R2V' else 'first', 'note': 'A garden.'}]
        scene = director.H3SceneDirector().build(run_name, json.dumps(self.plan), 736, 416, 4, 7,
                                                json.dumps({'mode': mode, 'assets': assets}))['result'][2]
        manifest = {'run_name': run_name, 'prompt_prefix': '', 'segments': [
            {'scene_prompt': shot['prompt'], 'seed': shot['seed'], 'steps': 4, 'raw_frames': 362, 'delivered_frames': 362 if index == 0 else 323}
            for index, shot in enumerate(self.plan['shots'])]}
        return project.H3SceneResult().record(str(self.output / 'result.mp4'), scene, json.dumps(manifest))['ui']

    def success(self, prompt_id, mode='R2V', run_name='trial'):
        self.queue.history[prompt_id] = {'status': {'status_str': 'success'}, 'outputs': {'1211': self.result(mode, run_name)}}

    def action(self, action, **values):
        return project.project_action({'project': 'test', 'action': action, **values}, self.queue)

    def save(self, prompt_id, mode='R2V'):
        self.success(prompt_id, mode)
        return self.action('adopt', prompt_id=prompt_id, node_id='1211', title=mode)['id']

    def test_exact_history_save_copy_roundtrip_and_duplicate(self):
        first = self.save('first')
        second = self.save('second', 'T2V')
        self.assertNotEqual(first, second)
        again = self.action('adopt', prompt_id='first', node_id='1211', title='Changed form title')['id']
        self.assertEqual(first, again)
        listing = self.action('list')['scenes']
        self.assertEqual([(s['mode'], s['cuts'], s['duration_seconds']) for s in listing], [('R2V', 2, 1.0), ('T2V', 2, 1.0)])
        saved = self.action('load', id=first)
        expected = {**self.plan, 'prompt_prefix': '', 'shots': [{**shot, 'length': 362, 'steps': 4} for shot in self.plan['shots']]}
        self.assertEqual(saved['plan'], expected)
        self.assertEqual(saved['frame_count'], 24)
        self.assertEqual([cut['delivered_frames'] for cut in saved['execution']['cuts']], [362, 323])
        self.assertEqual(saved['scene']['assets'][0]['note'], 'A garden.')
        self.assertTrue(saved['scene']['assets'][0]['file'].endswith(' [output]'))
        self.assertEqual(director.file_digest(director.reference_path(saved['scene']['assets'][0]['file'])), director.file_digest(self.input / 'ref.png'))
        (self.input / 'ref.png').unlink()
        self.assertTrue(director.reference_path(self.action('load', id=first)['scene']['assets'][0]['file']).exists())

    def test_rejects_failed_result_and_reference_changed_after_render(self):
        self.queue.history['bad'] = {'status': {'status_str': 'error'}, 'outputs': {'1211': self.result()}}
        with self.assertRaises(ValueError): self.action('adopt', prompt_id='bad', node_id='1211')
        self.success('good')
        Image.new('RGB', (32, 32), 'red').save(self.input / 'ref.png')
        with self.assertRaisesRegex(ValueError, '変更'): self.action('adopt', prompt_id='good', node_id='1211')
        self.assertEqual(self.action('list')['scenes'], [])

    def test_batch_success_failure_resume_changes_run_and_keeps_saved_files(self):
        ids = [self.save('first'), self.save('second', 'T2V')]
        manifest = project.project_path('test') / 'scenes.json'
        before = manifest.read_bytes()
        self.action('start', ids=ids, owner='one', result_node='1211')
        attempt = self.action('next', owner='one')['batch']['attempt']
        self.success(attempt['prompt_id'], run_name=attempt['run_name'])
        state = self.action('status')['batch']
        self.assertEqual(state['status'], 'ready'); self.assertEqual(len(state['completed']), 1)
        failed = self.action('next', owner='one')['batch']['attempt']
        self.queue.history[failed['prompt_id']] = {'status': {'status_str': 'error'}}
        self.assertEqual(self.action('status')['batch']['status'], 'error')
        self.action('resume', owner='two')
        retry = self.action('next', owner='two')['batch']['attempt']
        self.assertNotEqual(retry['run_name'], failed['run_name'])
        self.success(retry['prompt_id'], 'T2V', retry['run_name'])
        state = self.action('status')['batch']
        self.assertEqual(state['status'], 'complete')
        self.assertEqual([s['id'] for s in state['completed']], ids)
        self.assertEqual(manifest.read_bytes(), before)

    def test_reconnect_inflight_and_targeted_stop(self):
        identity = self.save('first')
        self.action('start', ids=[identity], owner='one', result_node='1211')
        attempt = self.action('next', owner='one')['batch']['attempt']
        self.queue.running = [(1, attempt['prompt_id'])]
        self.queue.pending = [(2, 'unrelated')]
        self.assertEqual(self.action('status')['batch']['status'], 'running')
        self.assertEqual(self.action('resume', owner='two')['batch']['attempt'], attempt)
        with self.assertRaises(ValueError): self.action('start', ids=[identity], owner='other', result_node='1211')
        self.action('stop')
        self.assertEqual(self.queue.interrupted, [attempt['prompt_id']])
        self.assertEqual(self.queue.pending, [(2, 'unrelated')])
        self.queue.running = []
        self.assertEqual(self.action('status')['batch']['status'], 'stopped')

    def test_missing_queue_response_reconciles_by_saved_uuid(self):
        identity = self.save('first')
        self.action('start', ids=[identity], owner='one', result_node='1211')
        attempt = self.action('next', owner='one')['batch']['attempt']
        self.assertEqual(self.action('status')['batch']['status'], 'submitting')
        self.success(attempt['prompt_id'], run_name=attempt['run_name'])
        self.assertEqual(self.action('status')['batch']['status'], 'complete')

    def test_containment_legacy_and_current_settings(self):
        for name in ('../escape', 'a/b', 'C:\\x', '..', 'bad.'):
            with self.assertRaises(ValueError): project.project_path(name)
        with self.assertRaises(ValueError): project.contained(self.root, '../escape.png')
        legacy = project.project_path('old'); legacy.mkdir(parents=True)
        (legacy / 'scenes.json').write_text('[{"id":"legacy"}]')
        with self.assertRaises(ValueError): project.records(legacy)
        original = copy.deepcopy(self.plan)
        original['shots'][0]['steps'] = 2
        graph = {'model': {'class_type': 'UNETLoader', 'inputs': {'unet_name': 'missing-test-model', 'weight_dtype': 'default'}}}
        result = director.H3SceneDirector().build('auto', json.dumps(original), 1280, 720, 12, 7, '{"mode":"T2V","assets":[]}', True, graph)
        execution = result['result'][2]['execution']
        self.assertEqual([s['steps'] for s in execution['plan']['shots']], [12, 12])
        self.assertEqual([s['seed'] for s in execution['plan']['shots']], ['18446744073709551615', '0'])
        self.assertEqual((execution['width'], execution['height']), (1280, 720))
        self.assertEqual(original['shots'][0]['steps'], 2)
        self.assertTrue(execution['generation_fingerprint'])
        graph['model']['inputs']['weight_dtype'] = 'fp8_e4m3fn'
        changed = director.H3SceneDirector().build('auto', json.dumps(original), 1280, 720, 12, 7, '{"mode":"T2V","assets":[]}', True, graph)
        self.assertNotEqual(execution['generation_fingerprint'], changed['result'][2]['execution']['generation_fingerprint'])

    def test_completed_workflow_preserves_unrelated_nodes(self):
        path = Path(__file__).resolve().parents[2] / 'user/default/workflows/video_minimax_h3_scene_director_dev.stage2-backup.json'
        source = json.loads(path.read_bytes()); before = copy.deepcopy(source)
        result = complete(source)
        self.assertEqual(source, before)
        nodes = {n['id']: n for n in result['nodes']}
        for old in source['nodes']:
            new = copy.deepcopy(nodes[old['id']]); old = copy.deepcopy(old)
            if old['id'] == 1200:
                new['size'] = old['size']; new['widgets_values'] = old['widgets_values']
                if 'widgets_values_named' in old: new['widgets_values_named'] = old['widgets_values_named']
            if old['id'] in (1200, 1206, 1207): new['outputs'] = old['outputs']
            self.assertEqual(new, old)
        self.assertEqual(result['groups'], source['groups'])
        for link_id, origin, output, target, slot, _ in result['links']:
            self.assertIn(link_id, nodes[origin]['outputs'][output]['links'])
            self.assertEqual(nodes[target]['inputs'][slot]['link'], link_id)
        self.assertNotIn('title', nodes[1211])

    def test_clean_layout_removes_only_disconnected_legacy_inputs(self):
        path = Path(__file__).resolve().parents[2] / 'user/default/workflows/video_minimax_h3_scene_director_dev.pre-input-cleanup.json'
        source = json.loads(path.read_bytes())
        before = copy.deepcopy(source)
        result = clean_layout(source)
        self.assertEqual(source, before)
        nodes = {n['id']: n for n in result['nodes']}
        self.assertFalse(set(nodes) & REMOVED_INPUTS.keys())
        for old in source['nodes']:
            if old['id'] in REMOVED_INPUTS:
                continue
            new = copy.deepcopy(nodes[old['id']])
            new['outputs'] = old.get('outputs', [])
            if 'outputs' not in old:
                new.pop('outputs')
            if old['id'] in (159, 801, 841):
                new['pos'] = old['pos']
            self.assertEqual(new, old)
        self.assertEqual(nodes[1200]['widgets_values'], next(n for n in source['nodes'] if n['id'] == 1200)['widgets_values'])
        for link_id, origin, output, target, slot, _ in result['links']:
            self.assertIn(link_id, nodes[origin]['outputs'][output]['links'])
            self.assertEqual(nodes[target]['inputs'][slot]['link'], link_id)
        self.assertEqual(result['definitions']['subgraphs'], [])
        self.assertEqual(clean_layout(result), result)
        broken = copy.deepcopy(source)
        broken['links'].append([9999, 600, 0, 1210, 0, 'IMAGE'])
        with self.assertRaises(ValueError): clean_layout(broken)


if __name__ == '__main__':
    unittest.main()

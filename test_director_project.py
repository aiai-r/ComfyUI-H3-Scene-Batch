import copy
import importlib
import json
import os
import shutil
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

    def test_identical_assets_are_shared_across_names_modes_and_legacy_paths(self):
        first = self.save('first')
        root = project.project_path('test')
        items = project.records(root)
        relative = items[0]['scene']['assets'][0]['file']
        self.assertEqual(relative, f'assets/{director.file_digest(self.input / "ref.png")}.png')
        shutil.copy2(self.input / 'ref.png', self.input / 'renamed.PNG')
        with patch.object(project.shutil, 'copy2', wraps=shutil.copy2) as copies:
            self.success('second', 'I2V')
            self.queue.history['second']['outputs']['1211']['h3_scene_result'][0]['scene']['assets'][0]['file'] = 'renamed.PNG'
            self.action('adopt', prompt_id='second', node_id='1211')
        self.assertEqual(copies.call_count, 1, 'Only the preview is copied for a reused asset')
        self.assertEqual(project.records(root)[1]['scene']['assets'][0]['file'], relative)
        legacy = f'assets/{first}/000.png'
        (root / legacy).parent.mkdir(parents=True)
        (root / relative).rename(root / legacy)
        items = project.records(root)
        for item in items: item['scene']['assets'][0]['file'] = legacy
        project.write_json(root / 'scenes.json', items)
        self.save('third')
        self.assertEqual(project.records(root)[2]['scene']['assets'][0]['file'], legacy)
        self.assertEqual(len(list((root / 'assets').rglob('*.png'))), 1)
        Image.new('RGB', (32, 32), 'red').save(self.input / 'ref.png')
        self.save('different')
        self.assertNotEqual(project.records(root)[3]['scene']['assets'][0]['file'], legacy)
        self.assertEqual(len(list((root / 'assets').rglob('*.png'))), 2)
        self.assertTrue(director.reference_path(self.action('load', id=first)['scene']['assets'][0]['file']).exists())

    def test_progress_polling_writes_only_on_state_changes(self):
        identity = self.save('first', 'T2V')
        self.action('start', ids=[identity], owner='one', result_node='1211')
        attempt = self.action('next', owner='one')['batch']['attempt']
        with patch.object(project, 'write_json', wraps=project.write_json) as writes:
            self.action('status'); self.action('status')
            writes.assert_not_called()
            self.queue.running = [(1, attempt['prompt_id'])]
            self.assertEqual(self.action('status')['batch']['status'], 'running')
            self.assertEqual(writes.call_count, 1)
            self.action('status'); self.action('status')
            self.assertEqual(writes.call_count, 1)
            self.success(attempt['prompt_id'], 'T2V', attempt['run_name'])
            self.assertEqual(self.action('status')['batch']['status'], 'complete')
            self.assertEqual(writes.call_count, 2)
            self.action('status')
            self.assertEqual(writes.call_count, 2)

    def test_external_project_path_media_loading_and_optional_preview(self):
        identity = self.save('first')
        external = self.root / 'cloud upload' / 'MyScenes'
        external.parent.mkdir()
        shutil.move(str(project.project_path('test')), external)
        manifest = (external / 'scenes.json').read_bytes()
        (self.input / 'ref.png').unlink()
        action = lambda name, **values: project.project_action({'project': str(external), 'action': name, **values}, self.queue)
        listing = action('list')
        self.assertEqual(listing['directory'], str(external))
        self.assertEqual(len(listing['scenes']), 1)
        self.assertEqual(listing['scenes'][0]['video']['type'], 'output')
        self.assertEqual(listing['scenes'][0]['video']['project'], str(external))
        self.assertTrue(project.video_file(listing['scenes'][0]['video']).is_relative_to(external))
        self.assertEqual(list((self.output / 'h3_scene_director/_external').rglob('*.mp4')), [])
        loaded = action('load', id=identity)
        asset = director.reference_path(loaded['scene']['assets'][0]['file'])
        source = external / json.loads(manifest)[0]['scene']['assets'][0]['file']
        self.assertEqual(asset.read_bytes(), source.read_bytes())
        self.assertTrue(asset.is_relative_to(self.output))
        Image.new('RGB', (48, 32), 'red').save(source)
        self.assertEqual(director.reference_path(action('load', id=identity)['scene']['assets'][0]['file']).read_bytes(), source.read_bytes())
        shutil.rmtree(external / 'previews')
        self.assertIsNone(action('list')['scenes'][0]['video'])
        self.assertIsNone(action('load', id=identity)['video'])
        action('start', start_index=1, owner='cloud', result_node='1211')
        attempt = action('next', owner='cloud')['batch']['attempt']
        self.assertEqual(attempt['output']['project'], str(external))
        self.assertRegex(attempt['output']['directory'], r'^batches/[^/]+/scene_0001_')
        self.assertTrue((external / 'batch.json').is_file())
        self.assertEqual((external / 'scenes.json').read_bytes(), manifest)
        items = json.loads(manifest)
        items[0]['scene']['assets'][0]['file'] = '../outside.png'
        (external / 'scenes.json').write_text(json.dumps(items), encoding='utf-8')
        with self.assertRaisesRegex(ValueError, '保存先の外'):
            action('load', id=identity)
        with self.assertRaisesRegex(ValueError, '絶対パス'):
            project.project_path(str(self.root / 'missing'))

    def test_external_asset_changes_with_identical_size_and_timestamp(self):
        external = self.root / 'external'
        external.mkdir()
        source = external / 'ref.bmp'
        Image.new('RGB', (32, 32), 'green').save(source)
        cached = project.project_media(external, source.name)
        original = source.read_bytes()
        stat = source.stat()
        Image.new('RGB', (32, 32), 'red').save(source)
        os.utime(source, ns=(stat.st_atime_ns, stat.st_mtime_ns))
        self.assertEqual(source.stat().st_size, cached.stat().st_size)
        self.assertEqual(source.stat().st_mtime_ns, cached.stat().st_mtime_ns)
        self.assertNotEqual(source.read_bytes(), original)
        with patch.object(project.shutil, 'copy2', wraps=shutil.copy2) as copies:
            self.assertEqual(project.project_media(external, source.name), cached)
            self.assertEqual(cached.read_bytes(), source.read_bytes())
            self.assertEqual(copies.call_count, 1)
            project.project_media(external, source.name)
            self.assertEqual(copies.call_count, 1, 'Unchanged contents must not be copied again')

    def test_batch_completion_between_queue_and_history_checks(self):
        identity = self.save('source', 'T2V')
        self.action('start', ids=[identity], owner='one', result_node='1211')
        state = self.action('next', owner='one')['batch']
        state['attempt']['created'] = time.time() - 120
        project.write_json(project.project_path('test') / 'batch.json', state)
        attempt = state['attempt']
        self.queue.running = [(1, attempt['prompt_id'])]
        get_history, get_queue = self.queue.get_history, self.queue.get_current_queue
        reads = []
        def read_then_complete(name, read, *args):
            snapshot = copy.deepcopy(read(*args))
            reads.append(name)
            if len(reads) == 1:
                self.success(attempt['prompt_id'], 'T2V', attempt['run_name'])
                self.queue.running = []
            return snapshot
        with patch.object(self.queue, 'get_history', side_effect=lambda pid: read_then_complete('history', get_history, pid)), \
             patch.object(self.queue, 'get_current_queue', side_effect=lambda: read_then_complete('queue', get_queue)):
            result = self.action('status')['batch']
        self.assertEqual(result['status'], 'complete')
        self.assertEqual([s['id'] for s in result['completed']], [identity])
        self.assertIsNone(result['attempt'])
        self.assertEqual(self.action('status')['batch']['completed'], result['completed'])

    def test_start_at_project_position_and_resume_after_restart(self):
        self.save('first', 'T2V')
        root = project.project_path('test')
        first = project.records(root)[0]
        items = [{**copy.deepcopy(first), 'id': f'scene{i}', 'title': f'Scene {i}'} for i in range(1, 41)]
        project.write_json(root / 'scenes.json', items)
        for start in (0, 41, 1.5, True, '2'):
            with self.assertRaisesRegex(ValueError, '開始番号'):
                self.action('start', start_index=start, owner='one', result_node='1211')
        state = self.action('start', start_index=12, owner='one', result_node='1211')['batch']
        self.assertEqual(state['ids'], [f'scene{i}' for i in range(12, 41)])
        self.assertEqual(state['positions'], list(range(12, 41)))
        self.assertEqual(state['total'], 40)
        batch_directory = state['directory']
        attempt = self.action('next', owner='one')['batch']['attempt']
        self.assertTrue(attempt['output']['directory'].startswith(batch_directory + '/scene_0012_'))
        self.success(attempt['prompt_id'], 'T2V', attempt['run_name'])
        state = self.action('status')['batch']
        self.assertEqual(state['completed'][0]['id'], 'scene12')
        failed = self.action('next', owner='one')['batch']['attempt']
        self.queue.history[failed['prompt_id']] = {'status': {'status_str': 'error'}}
        self.assertEqual(self.action('status')['batch']['status'], 'error')
        self.queue = Queue()
        resumed = self.action('resume', owner='two')['batch']
        self.assertEqual(resumed['positions'][len(resumed['completed'])], 13)
        self.assertEqual(len(resumed['completed']), 1)
        retry = self.action('next', owner='two')['batch']['attempt']
        self.assertNotEqual(retry['run_name'], failed['run_name'])
        self.assertEqual(resumed['directory'], batch_directory)
        self.assertTrue(retry['output']['directory'].startswith(batch_directory + '/scene_0013_'))
        self.assertNotEqual(retry['output']['directory'], failed['output']['directory'])
        self.action('stop')
        selected = self.action('start', ids=['scene40', 'scene3'], owner='two', result_node='1211')['batch']
        self.assertEqual(selected['ids'], ['scene3', 'scene40'])
        self.assertEqual(selected['positions'], [3, 40])
        self.assertNotEqual(selected['directory'], batch_directory)

    def test_video_path_containment_and_relocated_batch_results(self):
        identity = self.save('first', 'T2V')
        root = project.project_path('test')
        video = project.project_preview(root, project.records(root)[0])
        for values in ({'filename': '../../outside.mp4'}, {'subfolder': '../..'}, {'filename': 'scenes.json', 'subfolder': '.'}):
            with self.assertRaises(ValueError): project.video_file({**video, **values})
        project.write_json(root / 'batch.json', {'ids': [identity], 'completed': [{'id': identity, 'video': video}],
                                               'attempt': None, 'status': 'complete'})
        relocated = self.root / 'cloud project'
        shutil.move(str(root), relocated)
        state = project.refresh_batch(relocated, self.queue)
        self.assertEqual(state['completed'][0]['video']['project'], str(relocated))
        self.assertTrue(project.video_file(state['completed'][0]['video']).is_relative_to(relocated))

    @unittest.skipUnless(project.os.name == 'nt', 'Windows Explorer')
    def test_open_project_folder(self):
        root = project.project_path('test')
        with patch.object(project.os, 'startfile') as open_folder:
            with self.assertRaisesRegex(ValueError, '採用保存'):
                self.action('open')
            self.assertFalse(root.exists())
            root.parent.mkdir(parents=True)
            root.write_text('not a directory')
            with self.assertRaisesRegex(ValueError, '保存先フォルダがありません'):
                self.action('open')
            root.unlink()
            for name in ('../escape', 'C:\\Windows', 'bad/name'):
                with self.assertRaises(ValueError):
                    project.project_action({'project': name, 'action': 'open'}, self.queue)
            open_folder.assert_not_called()
            root.mkdir()
            (root / 'scenes.json').write_text('[]')
            self.assertEqual(self.action('open'), {'directory': str(root)})
            open_folder.assert_called_once_with(str(root), 'explore')
            self.assertEqual((root / 'scenes.json').read_text(), '[]')
            self.assertFalse((root / 'batch.json').exists())

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

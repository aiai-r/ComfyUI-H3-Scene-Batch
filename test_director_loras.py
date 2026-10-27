import copy
import json
import unittest
from pathlib import Path
from unittest.mock import patch

from director import H3SceneDirector, H3SceneTurboLora, TURBO_LORAS, resolve_lora
from configure_director_loras import configure


class DirectorLoraTests(unittest.TestCase):
    def setUp(self):
        self.names = ['minimaxh3/' + name for name in TURBO_LORAS.values()] + ['minimaxh3/fl8.safetensors']
        self.enterContext(patch('director.folder_paths.get_filename_list', return_value=self.names))
        self.enterContext(patch('director.folder_paths.get_full_path_or_raise', return_value='test.safetensors'))
        self.prompt = {
            'turbo': {'class_type': 'H3SceneTurboLora', 'inputs': {'model': ['model', 0], 'scene': ['director', 2]}},
            'extra': {'class_type': 'Power Lora Loader (rgthree)', 'inputs': {'model': ['turbo', 0],
                      'lora_1': {'on': True, 'lora': 'character.safetensors', 'strength': 0.7, 'strengthTwo': 0.2},
                      'lora_2': {'on': False, 'lora': 'style.safetensors', 'strength': 0.4}}},
        }
        self.plan = {'shots': [{'id': 'a', 'prompt': 'Walk', 'steps': 4}, {'id': 'b', 'prompt': 'Stop', 'steps': 6}]}

    def build(self, mode, batch=None, steps=4):
        scene = {'mode': mode, 'assets': []}
        if batch is not None:
            scene['batch_lora'] = batch
        return H3SceneDirector().build('trial', json.dumps(self.plan), 736, 416, steps, 42,
                                       json.dumps(scene), batch is not None, self.prompt)['result'][2]

    def test_modes_and_additional_lora_snapshot(self):
        for mode in ('R2V', 'T2V', 'I2V', 'L2V', 'FL2V'):
            scene = self.build(mode)
            execution = scene['execution']
            self.assertEqual(execution['turbo']['lora_name'], self.names[0 if mode == 'R2V' else 1])
            self.assertEqual(execution['turbo']['strength'], 1)
            self.assertEqual(execution['additional_loras'][0]['inputs'], {
                key: value for key, value in self.prompt['extra']['inputs'].items() if key != 'model'})
            execution['additional_loras'][0]['inputs']['lora_1']['strength'] = 2
            self.assertEqual(self.prompt['extra']['inputs']['lora_1']['strength'], 0.7)
            loaded = H3SceneTurboLora().load('model', scene)
            loader, = loaded['expand'].values()
            self.assertEqual(loader['class_type'], 'LoraLoaderModelOnly')
            self.assertEqual(loader['inputs']['lora_name'], execution['turbo']['lora_name'])

    def test_settings_steps_win_and_turbo_strength_is_fixed(self):
        saved = {'lora_name': self.names[1], 'strength': 1, 'default_steps': 4}
        execution = self.build('FL2V', saved, steps=20)['execution']
        self.assertEqual(execution['steps'], 20)
        self.assertEqual([s['steps'] for s in execution['plan']['shots']], [20, 20])
        override = {'lora_name': 'minimaxh3\\fl8.safetensors', 'strength': 0.8, 'steps': 8}
        scene = self.build('FL2V', override, steps=20)
        self.assertNotIn('batch_lora', scene)
        self.assertEqual(scene['execution']['steps'], 20)
        self.assertEqual([s['steps'] for s in scene['execution']['plan']['shots']], [20, 20])
        self.assertEqual(scene['execution']['turbo'], {'lora_name': self.names[2], 'strength': 1})
        changed = self.build('FL2V', {**override, 'strength': 0.9, 'steps': 4}, steps=20)
        self.assertEqual(scene['execution']['generation_fingerprint'], changed['execution']['generation_fingerprint'])
        loader, = H3SceneTurboLora().load('model', scene)['expand'].values()
        self.assertEqual(loader['inputs']['strength_model'], 1)
        model = object()
        self.assertEqual(H3SceneTurboLora().load(model, self.build('FL2V', {**override, 'lora_name': ''})), (model,))

    def test_missing_and_ambiguous_names_fail(self):
        with self.assertRaisesRegex(ValueError, 'LoRA一覧に指定ファイルがありません'):
            resolve_lora('../missing.safetensors')
        self.names.extend(['one/same.safetensors', 'two/same.safetensors'])
        with self.assertRaisesRegex(ValueError, 'one/same.safetensors, two/same.safetensors'):
            resolve_lora('same.safetensors')
        self.assertEqual(resolve_lora('one\\same.safetensors'), 'one/same.safetensors')

    def test_development_migration_preserves_existing_settings_and_connections(self):
        path = Path(__file__).resolve().parents[2] / 'user/default/workflows/video_minimax_h3_scene_director_dev.turbo-backup.json'
        original = json.loads(path.read_bytes())
        original_extra = next(n for n in original['nodes'] if n['type'] == 'Power Lora Loader (rgthree)')
        original_extra['widgets_values'].insert(3, {'on': True, 'lora': 'character.safetensors', 'strength': 0.7})
        before = copy.deepcopy(original)
        updated = configure(original)
        self.assertEqual(original, before)
        self.assertEqual(configure(updated), updated)
        self.assertEqual(updated['definitions'], original['definitions'])
        nodes = {n['id']: n for n in updated['nodes']}
        for n in original['nodes']:
            if n['type'] not in ('H3SceneDirector', 'Power Lora Loader (rgthree)'):
                self.assertEqual(n, nodes[n['id']])
        extra = nodes[original_extra['id']]
        self.assertIn({'on': True, 'lora': 'character.safetensors', 'strength': 0.7}, extra['widgets_values'])
        self.assertFalse(any(isinstance(v, dict) and str(v.get('lora', '')).split('\\')[-1] in TURBO_LORAS.values() for v in extra['widgets_values']))
        for identity, origin, output, target, slot, kind in updated['links']:
            self.assertIn(identity, nodes[origin]['outputs'][output]['links'])
            self.assertEqual(nodes[target]['inputs'][slot]['link'], identity)
        turbo, = [n for n in updated['nodes'] if n['type'] == 'H3SceneTurboLora']
        self.assertNotIn('title', turbo)


if __name__ == '__main__':
    unittest.main()

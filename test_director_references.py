import asyncio
import copy
import json
import unittest
from pathlib import Path
from unittest.mock import patch

import torch

from test_media import package
from execution import get_input_data, _async_map_node_over_list
from h3_scene_test.director_media import H3SceneConditioning
from h3_scene_test.director_references import H3SceneEncodeReferences, H3ScenePrepareReferences, h3
from configure_director_references import configure


class VideoVAE:
    def __init__(self):
        self.calls = []

    def encode(self, pixels):
        self.calls.append(tuple(pixels.shape))
        return pixels.mean(dim=-1).unsqueeze(0).unsqueeze(0).clone()


class AudioVAE:
    audio_sample_rate = 32000

    def __init__(self):
        self.calls = 0

    def encode(self, waveform):
        self.calls += 1
        return waveform.movedim(-1, 1).unsqueeze(2).clone()


class Clip:
    def tokenize(self, prompt, minimax_ref_items):
        self.items = minimax_ref_items
        return prompt

    def encode_from_tokens_scheduled(self, tokens):
        return [[torch.tensor([len(tokens)]), {'prompt': tokens}]]


class DirectorReferencesTests(unittest.TestCase):
    def test_comfy_execution_resolves_autogrow_inputs(self):
        vae = VideoVAE()
        inputs = {'plan': {'compatibility': {'width': 32, 'height': 32}, 'shots': [{'raw_frames': 22}]},
                  'vae': vae, 'ref_image_size': 'match',
                  'ref_images.ref_image_0': torch.ones(1, 32, 32, 3),
                  'ref_images.ref_image_1': torch.zeros(1, 32, 32, 3)}
        data, missing, v3_data = get_input_data(inputs, H3SceneEncodeReferences, 'encode')
        self.assertEqual(missing, {})
        result = asyncio.run(_async_map_node_over_list('test', 'encode', H3SceneEncodeReferences,
            data, H3SceneEncodeReferences.FUNCTION, v3_data=v3_data))
        self.assertEqual(len(vae.calls), 2)
        self.assertEqual(len(result[0][0][(32, 32, 22)][1]), 2)

    def assert_nested_equal(self, first, second):
        if isinstance(first, torch.Tensor):
            torch.testing.assert_close(first, second, rtol=0, atol=0)
        elif isinstance(first, dict):
            self.assertEqual(first.keys(), second.keys())
            for key in first:
                self.assert_nested_equal(first[key], second[key])
        elif isinstance(first, (tuple, list)):
            self.assertEqual(len(first), len(second))
            for a, b in zip(first, second):
                self.assert_nested_equal(a, b)
        else:
            self.assertEqual(first, second)

    def test_reuse_matches_native_for_images_video_audio_and_each_prompt(self):
        pixels = torch.linspace(0, 1, 2 * 48 * 96 * 3).reshape(2, 48, 96, 3)
        refs = dict(ref_images={'ref_image_0': pixels, 'ref_image_1': pixels.flip(2)},
                    ref_videos={'ref_video_0': pixels[:1].repeat(44, 1, 1, 1)},
                    ref_video_audios={'ref_video_audio_0': {'waveform': torch.ones(1, 2, 30), 'sample_rate': 32000}},
                    ref_audios={'ref_audio_0': {'waveform': torch.zeros(1, 2, 40), 'sample_rate': 32000}})
        for size in ('match', 'max'):
            vae, audio_vae = VideoVAE(), AudioVAE()
            plan = {'compatibility': {'width': 32, 'height': 64},
                    'shots': [{'raw_frames': n, 'resolution': None} for n in (22, 39, 39, 73)]}
            encoded = H3SceneEncodeReferences.execute(plan, vae, size, audio_vae, **refs)[0]
            # Two pictures once each, two distinct video slices, two audio streams once each.
            self.assertEqual(len(vae.calls), 4)
            self.assertEqual(audio_vae.calls, 2)
            frozen = copy.deepcopy(encoded)
            for index, shot in enumerate(plan['shots'], 1):
                length, prompt = shot['raw_frames'], 'Prompt ' + str(index)
                native_clip, shared_clip = Clip(), Clip()
                original = h3.MiniMaxH3ReferenceToVideo.execute(native_clip, prompt, 32, 64, length,
                    size, VideoVAE(), AudioVAE(), **refs)
                actual = H3SceneConditioning().build({'mode': 'R2V', 'assets': []}, shared_clip,
                    vae, prompt, 32, 64, length, index, 4, audio_vae, encoded)
                self.assert_nested_equal(actual[0], original[0])
                self.assert_nested_equal(shared_clip.items, native_clip.items)
                for a, b in zip(actual[1]['samples'].unbind(), original[1]['samples'].unbind()):
                    torch.testing.assert_close(a, b, rtol=0, atol=0)
            self.assertEqual(len(vae.calls), 4)
            self.assertEqual(audio_vae.calls, 2)
            self.assert_nested_equal(encoded, frozen)

    def test_scene_changes_prepare_new_values_without_retaining_cache(self):
        vae = VideoVAE()
        plan = {'compatibility': {'width': 64, 'height': 64}, 'shots': [{'raw_frames': 22}, {'raw_frames': 39}]}
        refs = {'ref_image_0': torch.ones(1, 128, 128, 3)}
        first = H3SceneEncodeReferences.execute(plan, vae, ref_images=refs)[0]
        self.assertEqual(len(vae.calls), 1)
        self.assertIs(first[(64, 64, 22)][1][0]['latent'], first[(64, 64, 39)][1][0]['latent'])
        refs['ref_image_0'] = torch.zeros_like(refs['ref_image_0'])
        second = H3SceneEncodeReferences.execute(plan, vae, ref_images=refs)[0]
        self.assertEqual(len(vae.calls), 2)
        self.assertFalse(torch.equal(first[(64, 64, 22)][1][0]['latent'], second[(64, 64, 22)][1][0]['latent']))
        plan['compatibility']['width'] = 128
        H3SceneEncodeReferences.execute(plan, vae, ref_images=refs)
        self.assertNotEqual(vae.calls[-1], vae.calls[-2])
        alternate_vae = VideoVAE()
        H3SceneEncodeReferences.execute(plan, alternate_vae, ref_images=refs)
        self.assertEqual(len(alternate_vae.calls), 1)

    def test_preparer_skips_other_modes_and_preserves_reference_pairing(self):
        for mode in ('T2V', 'I2V', 'L2V', 'FL2V'):
            self.assertEqual(H3ScenePrepareReferences().prepare({'mode': mode, 'assets': []}, {}, None), ({},))
        assets = [{'kind': 'image', 'file': 'a.png'}, {'kind': 'video', 'file': 'b.mp4', 'use_audio': True},
                  {'kind': 'audio', 'file': 'c.wav'}, {'kind': 'image', 'file': 'disabled.png', 'enabled': False}]
        with patch('h3_scene_test.director_references.input_file', side_effect=lambda x: x):
            graph = H3ScenePrepareReferences().prepare({'mode': 'R2V', 'assets': assets}, {}, 'vae', 'audio')['expand']
        encoder = list(graph.values())[-1]
        self.assertEqual(encoder['class_type'], 'H3SceneEncodeReferences')
        inputs = encoder['inputs']
        self.assertEqual(inputs['ref_videos.ref_video_0'][0], inputs['ref_video_audios.ref_video_audio_0'][0])
        self.assertEqual(sum(n['class_type'] == 'LoadImage' for n in graph.values()), 1)
        self.assertIn('ref_audios.ref_audio_0', inputs)

    def test_workflow_migration_preserves_nodes_values_and_reciprocal_links(self):
        path = Path(__file__).resolve().parents[2] / 'user/default/workflows/video_minimax_h3_scene_director_dev.json'
        backup = path.with_suffix('.references-backup.json')
        before = json.loads((backup if backup.exists() else path).read_bytes())
        snapshot = copy.deepcopy(before)
        after = configure(before)
        self.assertEqual(before, snapshot)
        self.assertEqual(configure(after), after)
        self.assertEqual(after['nodes'], before['nodes'])
        self.assertEqual(after['links'], before['links'])
        for a, b in zip(before['definitions']['subgraphs'], after['definitions']['subgraphs']):
            new = {n['id']: n for n in b['nodes']}
            for old in a['nodes']:
                original, changed = copy.deepcopy(old), copy.deepcopy(new[old['id']])
                if old['type'] == 'H3SceneConditioning':
                    changed['inputs'] = [i for i in changed['inputs'] if i['name'] != 'references']
                for n in (original, changed):
                    for out in n.get('outputs', []):
                        out.pop('links', None)
                self.assertEqual(original, changed)
            preparer, = [n for n in b['nodes'] if n['type'] == 'H3ScenePrepareReferences']
            self.assertNotIn('title', preparer)
            for link in b['links']:
                origin, target = link['origin_id'], link['target_id']
                sources = b['inputs'][link['origin_slot']]['linkIds'] if origin == -10 else new[origin]['outputs'][link['origin_slot']]['links']
                self.assertIn(link['id'], sources)
                if target != -20:
                    self.assertEqual(new[target]['inputs'][link['target_slot']]['link'], link['id'])
                if target == preparer['id'] and origin != -10:
                    self.assertEqual(new[origin]['type'], 'VAELoader')


if __name__ == '__main__':
    unittest.main()

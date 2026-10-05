import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from test_media import package
from h3_scene_test import director_media as media
from make_director_workflow import build_workflow
from upgrade_director_workflow import upgrade


class DirectorMediaTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.enterContext(patch.object(media.folder_paths, "get_input_directory", return_value=str(self.root)))
        self.enterContext(patch.object(media.folder_paths, "get_annotated_filepath", side_effect=lambda name: str(self.root / name)))
        for name in ("first.png", "last.png", "ref.png", "voice.wav", "clip.mp4"):
            (self.root / name).write_bytes(b"fixture")
        self.assets = [
            {"kind": "image", "role": "first", "file": "first.png"},
            {"kind": "image", "role": "last", "file": "last.png"},
            {"kind": "image", "role": "reference", "file": "ref.png"},
            {"kind": "audio", "file": "voice.wav"},
            {"kind": "video", "file": "clip.mp4", "use_audio": True},
        ]

    def build(self, mode, index):
        return media.H3SceneConditioning().build({"mode": mode, "assets": self.assets}, "clip", "vae", "prompt", 512, 512, 362, index, 3, "audio_vae")["expand"]

    def test_modes_and_scene_boundary_frames(self):
        for mode, expected in [("T2V", [set(), set(), set()]), ("I2V", [{"first_frame"}, set(), set()]),
                               ("L2V", [set(), set(), {"last_frame"}]), ("FL2V", [{"first_frame"}, set(), {"last_frame"}])]:
            for index, fields in enumerate(expected, 1):
                graph = self.build(mode, index)
                node = list(graph.values())[-1]
                self.assertEqual(node["class_type"], "MiniMaxH3ImageToVideo")
                self.assertEqual(set(node["inputs"]) & {"first_frame", "last_frame"}, fields)
                self.assertEqual(sum(n["class_type"] == "LoadImage" for n in graph.values()), len(fields))

    def test_r2v_reference_order_and_video_audio_pairing(self):
        for index in (1, 2, 3):
            graph = self.build("R2V", index)
            node = list(graph.values())[-1]
            self.assertEqual(node["class_type"], "MiniMaxH3ReferenceToVideo")
            fields = node["inputs"]
            self.assertEqual(graph[fields["ref_images.ref_image_0"][0]]["inputs"]["image"], "ref.png")
            self.assertEqual(fields["ref_videos.ref_video_0"][0], fields["ref_video_audios.ref_video_audio_0"][0])
            self.assertEqual(graph[fields["ref_videos.ref_video_0"][0]]["inputs"]["force_rate"], 24)
            self.assertIn("ref_audios.ref_audio_0", fields)

    def test_file_containment_and_inactive_assets(self):
        with self.assertRaises(ValueError): media.input_file("../outside.png")
        with self.assertRaises(ValueError): media.input_file("missing.png")
        self.assets.append({"kind": "image", "file": "missing.png", "enabled": False})
        self.build("R2V", 1)
        self.assets[0]["file"] = "missing.png"
        self.build("I2V", 2)
        with self.assertRaises(ValueError): self.build("I2V", 1)

    def test_reference_images_keep_individual_sizes_and_content_cache_keys(self):
        scene = json.dumps({"mode": "FL2V", "assets": self.assets})
        with patch.object(media.nodes.LoadImage, "load_image", side_effect=lambda p: (p, None)), patch.object(media.nodes.LoadImage, "IS_CHANGED", side_effect=lambda p: "hash:" + p):
            self.assertEqual(media.H3SceneReferenceImages().load(scene), (["first.png", "last.png"],))
            self.assertEqual(media.H3SceneReferenceImages.IS_CHANGED(scene), ["hash:first.png", "hash:last.png"])

    def test_real_image_loader_preserves_sizes_and_detects_replacement(self):
        Image.new("RGB", (40, 24), "red").save(self.root / "first.png")
        Image.new("RGB", (24, 48), "blue").save(self.root / "last.png")
        scene = json.dumps({"mode": "FL2V", "assets": self.assets})
        images = media.H3SceneReferenceImages().load(scene)[0]
        self.assertEqual([tuple(image.shape) for image in images], [(1, 24, 40, 3), (1, 48, 24, 3)])
        before = media.H3SceneReferenceImages.IS_CHANGED(scene)
        Image.new("RGB", (40, 24), "green").save(self.root / "first.png")
        after = media.H3SceneReferenceImages.IS_CHANGED(scene)
        self.assertNotEqual(before[0], after[0])
        self.assertEqual(before[1], after[1])

    def test_upgrade_preserves_authored_data_and_reciprocal_links(self):
        root = Path(__file__).resolve().parents[2]
        source = json.loads((root / "user/default/workflows/video_minimax_h3_multimode_scene_cuts.json").read_bytes())
        before = build_workflow(source, "test")
        snapshot = copy.deepcopy(before)
        after = upgrade(before)
        self.assertEqual(before, snapshot)
        old = {n["id"]: n for n in before["nodes"]}; new = {n["id"]: n for n in after["nodes"]}
        self.assertEqual(new[1200]["widgets_values"][:2], old[1200]["widgets_values"][:2])
        self.assertEqual(new[1200]["properties"]["h3_llm"]["prompt"]["inputs"]["seed"], old[841]["widgets_values"][0])
        for node_id, original in old.items():
            a, b = copy.deepcopy(original), copy.deepcopy(new[node_id])
            for n in (a, b):
                for item in n.get("inputs", []): item.pop("link", None)
                for item in n.get("outputs", []): item.pop("links", None)
            if node_id == 1200: continue
            if node_id == 136: a["mode"] = 2
            self.assertEqual(a, b, node_id)
        for link_id, origin, slot, target, target_slot, kind in after["links"]:
            self.assertIn(link_id, new[origin]["outputs"][slot]["links"])
            self.assertEqual(new[target]["inputs"][target_slot]["link"], link_id)
            self.assertIn(new[target]["inputs"][target_slot]["type"], (kind, "*"))
        with self.assertRaises(ValueError): upgrade(after)


if __name__ == "__main__":
    unittest.main()

import asyncio
import copy
import importlib.util
import json
import shutil
import sys
import tempfile
import types
import unittest
import wave
from pathlib import Path
from unittest.mock import AsyncMock, patch

import av
import numpy as np
import torch
from aiohttp import web

import comfy.cli_args
import folder_paths

comfy.cli_args.args.cpu = True

PACKAGE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("h3_scene_test", PACKAGE / "__init__.py", submodule_search_locations=[str(PACKAGE)])
package = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = package
server = types.ModuleType("server")
server.PromptServer = types.SimpleNamespace(instance=types.SimpleNamespace(routes=web.RouteTableDef()))
original_server = sys.modules.get("server")
sys.modules["server"] = server
try:
    spec.loader.exec_module(package)
finally:
    if original_server is None:
        del sys.modules["server"]
    else:
        sys.modules["server"] = original_server
nodes = sys.modules["h3_scene_test.nodes"]
media = sys.modules["h3_scene_test.media"]

from comfy_extras.nodes_video import GetVideoComponents
from comfy_extras.nodes_audio import TrimAudioDuration


class SceneMediaTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        original_input = folder_paths.get_input_directory()
        folder_paths.set_input_directory(str(self.root))
        self.addCleanup(folder_paths.set_input_directory, original_input)
        self.audio = self.root / "voice.wav"
        with wave.open(str(self.audio), "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(24000)
            output.writeframes(np.arange(2400, dtype=np.int16).tobytes())
        self.video = self.root / "clip.mp4"
        with av.open(str(self.video), "w") as output:
            stream = output.add_stream("mpeg4", rate=24)
            stream.width = stream.height = 32
            stream.pix_fmt = "yuv420p"
            for index in range(6):
                frame = av.VideoFrame.from_ndarray(np.full((32, 32, 3), index * 30, dtype=np.uint8), format="rgb24")
                for packet in stream.encode(frame):
                    output.mux(packet)
            for packet in stream.encode():
                output.mux(packet)

    def graph(self):
        return {
            "a": {"class_type": "LoadAudio", "inputs": {"audio": self.audio.name}},
            "v": {"class_type": "LoadVideo", "inputs": {"file": self.video.name}},
            "c": {"class_type": "GetVideoComponents", "inputs": {"video": ["v", 0]}},
            "t": {"class_type": "TrimAudioDuration", "inputs": {"audio": ["a", 0], "start_index": 0.01, "duration": 0.04}},
        }

    def evaluate(self, expanded, link, cache):
        if link is None:
            return None
        node_id, slot = link
        if node_id not in cache:
            node = expanded[node_id]
            inputs = {key: self.evaluate(expanded, value, cache) if media.is_link(value) else value for key, value in node["inputs"].items()}
            kind = node["class_type"]
            if kind == "H3SceneAudioPath":
                result = nodes.H3SceneAudioPath().load(**inputs)
            elif kind == "H3SceneVideoPath":
                result = nodes.H3SceneVideoPath().load(**inputs)
            elif kind == "GetVideoComponents":
                result = GetVideoComponents.execute(**inputs).result
            else:
                result = TrimAudioDuration.execute(**inputs).result
            cache[node_id] = result
        return cache[node_id][slot]

    def test_round_trip_after_moving_project_and_removing_originals(self):
        refs = {"ref_audios.ref_audio_2": ["t", 0], "ref_videos.ref_video_1": ["c", 0], "ref_video_audios.ref_video_audio_1": ["a", 0]}
        snapshot = media.capture_media(self.graph(), refs)
        expected_audio = nodes.H3SceneAudioPath().load(str(self.audio))[0]
        expected_frames = GetVideoComponents.execute(nodes.H3SceneVideoPath().load(str(self.video))[0]).result[0]
        project = self.root / "project"
        nodes.save_scene(str(project), "scene01", "A quiet landscape.", "", 42, 2, snapshot)
        nodes.save_scene(str(project), "scene02", "A second landscape.", "", 43, 3, {"nodes": {}, "outputs": {}})
        saved = json.loads((project / "scenes.json").read_text())[0]
        for node in saved["media"]["nodes"].values():
            key = media.FILE_INPUTS.get(node["class_type"])
            if key:
                self.assertFalse(Path(node["inputs"][key]).is_absolute())
        moved = self.root / "moved"
        shutil.move(str(project), moved)
        self.audio.unlink()
        self.video.unlink()
        result = nodes.H3SceneBatchLoad().load(str(moved / "scenes.json"), str(moved / "images"), 0, False)
        values = result["result"][13:]
        cache = {}
        audio = self.evaluate(result["expand"], values[7], cache)
        frames = self.evaluate(result["expand"], values[4], cache)
        trimmed = self.evaluate(result["expand"], values[2], cache)
        self.assertTrue(torch.equal(audio["waveform"], expected_audio["waveform"]))
        self.assertTrue(torch.equal(frames, expected_frames))
        self.assertEqual(trimmed["waveform"].shape[-1], 960)
        self.assertIsNone(values[0])
        result2 = nodes.H3SceneBatchLoad().load(str(moved / "scenes.json"), str(moved / "images"), 1, False)
        self.assertEqual(result2["result"][13:], (None,) * 9)
        self.assertEqual(result2["expand"], {})

    def test_old_manifest_has_no_media(self):
        nodes.save_scene(str(self.root / "old"), "scene01", "Landscape", "", 1, 2)
        result = nodes.H3SceneBatchLoad().load(str(self.root / "old/scenes.json"), str(self.root / "old/images"), 0, False)
        self.assertEqual(result["result"][13:], (None,) * 9)

    def test_batch_count_and_sixth_scene_resume(self):
        project = self.root / "batch"
        for index in range(8):
            source = self.root / f"reference{index + 1}.png"
            source.write_bytes(f"image-{index + 1}".encode())
            nodes.save_scene(str(project), f"scene{index + 1:02d}", f"Prompt {index + 1}", str(source), index + 10, index + 1)
        manifest = str(project / "scenes.json")
        request = types.SimpleNamespace(json=AsyncMock(return_value={"manifest_path": manifest}))
        response = asyncio.run(nodes.manifest_info(request))
        self.assertEqual(response.status, 200)
        self.assertEqual(json.loads(response.text), {"scene_count": 8})
        result = nodes.H3SceneBatchLoad().load(manifest, str(project / "images"), 5, True)
        self.assertEqual(result["result"][:3], ("Prompt 6", 15, 6))
        self.assertEqual(Path(result["result"][3]).read_bytes(), b"image-6")
        self.assertEqual(result["ui"]["start_at"], [5])
        self.assertEqual(result["ui"]["scene_count"], [8])
        self.assertEqual(result["ui"]["scene_id"], ["scene06"])
        self.assertEqual(result["ui"]["manifest_path"], [manifest])
        self.assertEqual(result["ui"]["image_root"], [str(project / "images")])

    def test_batch_count_empty_invalid_and_missing(self):
        manifest = self.root / "scenes.json"
        request = types.SimpleNamespace(json=AsyncMock(return_value={"manifest_path": str(manifest)}))
        self.assertEqual(asyncio.run(nodes.manifest_info(request)).status, 400)
        for content, status in (("[]", 200), ("{}", 400), ("invalid", 400)):
            with self.subTest(content=content):
                manifest.write_text(content, encoding="utf-8")
                response = asyncio.run(nodes.manifest_info(request))
                self.assertEqual(response.status, status)
                if status == 200:
                    self.assertEqual(json.loads(response.text), {"scene_count": 0})

    def test_duplicate_confirmation_before_writing(self):
        project = self.root / "duplicates"
        scene = {"prompt_id": "run1", "prompt": "Landscape", "seed": 7, "duration": 2,
                 "image_paths": [str(self.audio)], "media": {"nodes": {}, "outputs": {}}}
        instance = nodes.PromptServer.instance
        with patch.object(instance, "prompt_queue", create=True), patch.object(nodes, "latest_scene", return_value=scene):
            def save(**fields):
                request = types.SimpleNamespace(json=AsyncMock(return_value={"project_dir": str(project), **fields}))
                return asyncio.run(nodes.save_latest(request))

            self.assertEqual(save().status, 200)
            before = (project / "scenes.json").read_bytes()
            files = sorted(project.rglob("*"))
            duplicate = json.loads(save().text)
            self.assertEqual(duplicate["duplicates"], ["scene01"])
            self.assertEqual((project / "scenes.json").read_bytes(), before)
            self.assertEqual(sorted(project.rglob("*")), files)
            scene["seed"] = 8
            self.assertEqual(save(confirm_fingerprint=duplicate["fingerprint"]).status, 400)
            self.assertEqual((project / "scenes.json").read_bytes(), before)
            scene["seed"] = 7
            self.assertEqual(json.loads(save(confirm_fingerprint=duplicate["fingerprint"]).text)["scene_id"], "scene02")
            self.assertEqual(json.loads(save().text)["duplicates"], ["scene01", "scene02"])

    def test_duplicate_content_order_and_media_settings(self):
        project = self.root / "compare"
        snapshot = media.capture_media(self.graph(), {"ref_audios.ref_audio_0": ["t", 0]})
        scene = {"prompt": "Landscape", "seed": 7, "duration": 2,
                 "image_paths": [str(self.audio), str(self.video)], "media": snapshot}
        nodes.save_scene(str(project), "scene01", scene["prompt"], "\n".join(scene["image_paths"]), 7, 2, snapshot)
        renamed = self.root / "renamed.wav"
        shutil.copy2(self.audio, renamed)
        scene["image_paths"][0] = str(renamed)
        self.assertEqual(nodes.duplicate_scenes(str(project), scene)[1], ["scene01"])
        for key, value in (("prompt", "Landscape "), ("seed", 8), ("duration", 3),
                           ("image_paths", list(reversed(scene["image_paths"])))):
            with self.subTest(key=key):
                changed = {**scene, key: value}
                self.assertEqual(nodes.duplicate_scenes(str(project), changed)[1], [])
        changed = copy.deepcopy(scene)
        changed["media"]["nodes"]["t"]["inputs"]["duration"] = 0.03
        self.assertEqual(nodes.duplicate_scenes(str(project), changed)[1], [])
        renamed.write_bytes(b"changed file content")
        self.assertEqual(nodes.duplicate_scenes(str(project), scene)[1], [])

    def test_capture_uses_completed_history_connections(self):
        graph = self.graph()
        graph.update({
            "817:136": {"inputs": {"prompt": ["prompt", 0], "ref_audios.ref_audio_0": ["t", 0]}},
            "224": {"inputs": {"source": ["prompt", 0]}},
            "817:129": {"inputs": {"noise_seed": 17}},
            "817:819": {"inputs": {"value": 4}},
        })
        entry = {"prompt": [0, "run1", graph], "status": {"status_str": "success"}, "outputs": {"224": {"text": ["Landscape"]}}}
        scene = nodes.latest_scene({"run1": entry})
        self.assertEqual(scene["seed"], 17)
        self.assertEqual(scene["media"]["outputs"], {"ref_audios.ref_audio_0": ["t", 0]})
        self.assertEqual(set(scene["media"]["nodes"]), {"t", "a"})
        self.assertEqual(scene["image_paths"], [])

    def test_vhs_settings_and_shared_source(self):
        graph = {"v": {"class_type": "VHS_LoadVideo", "inputs": {"video": self.video.name, "force_rate": 24, "skip_first_frames": 2, "frame_load_cap": 5, "select_every_nth": 1}}}
        refs = {"ref_videos.ref_video_0": ["v", 0], "ref_video_audios.ref_video_audio_0": ["v", 2]}
        saved = media.copy_media(media.capture_media(graph, refs), self.root / "assets", "scene01")
        expanded, values = media.expand_media(saved, self.root / "assets")
        self.assertEqual(len(expanded), 1)
        node = next(iter(expanded.values()))
        self.assertEqual(node["class_type"], "VHS_LoadVideoPath")
        self.assertEqual(node["inputs"]["skip_first_frames"], 2)
        self.assertEqual(node["inputs"]["frame_load_cap"], 5)
        self.assertEqual(values[3][0], values[6][0])
        self.assertEqual(values[6][1], 2)

    def test_unsupported_missing_and_escaping_media_fail(self):
        with self.assertRaisesRegex(ValueError, "Cannot save"):
            media.capture_media({"x": {"class_type": "UnknownAudio", "inputs": {}}}, {"ref_audios.ref_audio_0": ["x", 0]})
        saved = media.copy_media(media.capture_media(self.graph(), {"ref_audios.ref_audio_0": ["a", 0]}), self.root / "assets", "scene01")
        saved["nodes"]["a"]["inputs"]["audio"] = "../voice.wav"
        with self.assertRaisesRegex(ValueError, "invalid saved media"):
            media.expand_media(saved, self.root / "assets")
        self.audio.unlink()
        with self.assertRaises(FileNotFoundError):
            media.capture_media(self.graph(), {"ref_audios.ref_audio_0": ["a", 0]})


if __name__ == "__main__":
    unittest.main()

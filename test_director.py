import copy
import importlib
import importlib.util
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

import comfy.cli_args

from director import DEFAULT_PLAN, H3SceneDirector, prepare_plan
from make_director_workflow import MUTED, REMOVED, build_workflow


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "user/default/workflows/video_minimax_h3_multimode_scene_cuts.json"


class DirectorTests(unittest.TestCase):
    def test_plan_preserves_authored_fields_and_seeds(self):
        source = {"prompt_prefix": "Shared", "defaults": {"duration_seconds": 12}, "shots": [
            {"id": "one", "prompt": "Authored\n", "seed": "18446744073709551615", "length": 362},
            {"id": "two", "prompt": "Continuation", "seed": 0, "duration_seconds": 8},
            {"id": "three", "prompt": "Next", "duration_seconds": 9},
        ]}
        actual = json.loads(prepare_plan(json.dumps(source), 42))
        expected = copy.deepcopy(source)
        expected["shots"][2]["seed"] = 42
        self.assertEqual(actual, expected)
        self.assertNotIn("seed", source["shots"][2])

    def test_expands_only_public_plan_and_profile(self):
        result = H3SceneDirector().build("trial", DEFAULT_PLAN, 736, 416, 4, 7)
        nodes = list(result["expand"].values())
        self.assertEqual([node["class_type"] for node in nodes], ["MiniMaxH3GenerationProfile", "MiniMaxH3ChainPlanModern"])
        self.assertEqual(nodes[0]["inputs"]["scene_continuity"], "Hard picture + smooth audio")
        plan = nodes[1]["inputs"]
        self.assertEqual((plan["width"], plan["height"], plan["default_steps"]), (736, 416, 4))
        self.assertEqual([shot["seed"] for shot in json.loads(plan["plan_json"])["shots"]], [7, 7])
        self.assertEqual(plan["video_blend_frames"], 0)

    def test_workflow_connections_and_preservation(self):
        source = json.loads(SOURCE.read_bytes())
        before = copy.deepcopy(source)
        workflow = build_workflow(source, "development-id")
        self.assertEqual(source, before)
        nodes = {node["id"]: node for node in workflow["nodes"]}
        self.assertEqual(len(nodes), len(workflow["nodes"]))
        links = {link[0]: link for link in workflow["links"]}
        self.assertEqual(len(links), len(workflow["links"]))
        for link_id, origin, output, target, slot, datatype in links.values():
            self.assertIn(link_id, nodes[origin]["outputs"][output]["links"])
            self.assertEqual(nodes[target]["inputs"][slot]["link"], link_id)
            self.assertIn(nodes[target]["inputs"][slot]["type"], (datatype, "*"))
        for node in workflow["nodes"]:
            for slot, item in enumerate(node.get("inputs", [])):
                if item.get("link") is not None:
                    self.assertEqual(links[item["link"]][3:5], [node["id"], slot])
            for slot, item in enumerate(node.get("outputs", [])):
                for link in item.get("links") or []:
                    self.assertEqual(links[link][1:3], [node["id"], slot])
        for original in source["nodes"]:
            if original["id"] in REMOVED:
                continue
            actual, expected = copy.deepcopy(nodes[original["id"]]), copy.deepcopy(original)
            for value in (actual, expected):
                for item in value.get("inputs", []):
                    item.pop("link", None)
                for item in value.get("outputs", []):
                    item.pop("links", None)
            if original["id"] in MUTED:
                expected["mode"] = 2
            self.assertEqual(actual, expected, f"Unrelated node changed: {original['id']}")
        self.assertEqual(workflow["groups"], source["groups"])
        old_generator = next(node for node in source["nodes"] if node["id"] == 817)
        self.assertEqual(nodes[807]["widgets_values"][0], old_generator["widgets_values"][1])
        self.assertEqual(nodes[824]["widgets_values"][:2], old_generator["widgets_values"][4:6])
        self.assertEqual(nodes[812]["widgets_values"][0], old_generator["widgets_values"][9])
        self.assertEqual(nodes[820]["widgets_values"][:3], old_generator["widgets_values"][14:17])
        self.assertEqual(sum(n["type"] == "SamplerCustomAdvanced" for n in nodes.values()), 1)
        self.assertFalse(any(n["type"] in ("H3SceneCapture", "MiniMaxH3ChainReview") for n in nodes.values()))
        for node_id in range(1200, 1210):
            self.assertNotIn("title", nodes[node_id])
        for target, name, expected in [
            (1206, "flow", [1201, 0]), (1206, "segment", [1205, 0]),
            (1204, "trim_frames", [1203, 1]), (1205, "audio", [1204, 1]),
            (1205, "images", [1204, 0]), (1207, "manifest", [1206, 0]),
        ]:
            item = next(item for item in nodes[target]["inputs"] if item["name"] == name)
            self.assertEqual(links[item["link"]][1:3], expected)
        self.assertEqual(nodes[1201]["widgets_values"][0], 1)

    def test_installed_context_loop_compiles_timing_and_independent_start(self):
        # Import the installed public nodes on CPU, without starting a server or loading weights.
        schema_path = ROOT / "custom_nodes/ComfyUI-MiniMaxH3-Context-Loop/tools/workflow_schema.py"
        spec = importlib.util.spec_from_file_location("director_loop_schema", schema_path)
        schema_tool = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(schema_tool)
        server = types.ModuleType("server")
        server.PromptServer = None
        package = types.ModuleType("director_context_loop_test")
        package.__path__ = [str(schema_path.parents[1])]
        comfy.cli_args.args.cpu = True
        self.enterContext(patch.dict(sys.modules, {"server": server, package.__name__: package}))
        chain = importlib.import_module(package.__name__ + ".chain_nodes")
        context_nodes = importlib.import_module(package.__name__ + ".nodes")
        classes = {**chain.CHAIN_NODE_CLASS_MAPPINGS, **context_nodes.NODE_CLASS_MAPPINGS}
        from test_media import package as director_package
        classes.update(director_package.NODE_CLASS_MAPPINGS)
        schemas = {name: {"input": cls.INPUT_TYPES(), "output": list(cls.RETURN_TYPES)} for name, cls in classes.items()}
        result = H3SceneDirector().build("trial", DEFAULT_PLAN, 736, 416, 4, 7)
        profile_node, plan_node = result["expand"].values()
        policy = chain.MiniMaxH3GenerationProfile().build(**profile_node["inputs"])[0]
        inputs = {**plan_node["inputs"], "chain_policy": policy}
        with tempfile.TemporaryDirectory() as directory, patch.object(chain.folder_paths, "get_output_directory", return_value=directory):
            plan = chain.MiniMaxH3ChainPlanModern().build(**inputs)[0]
            self.assertEqual(plan["compatibility"]["context_length"], 39)
            self.assertEqual(plan["compatibility"]["continuation_mode"], "audio_feathered_av")
            self.assertEqual([shot["raw_frames"] for shot in plan["shots"]], [362, 362])
            self.assertEqual([shot["delivered_frames"] for shot in plan["shots"]], [362, 323])
            self.assertEqual([shot["seed"] for shot in plan["shots"]], [7, 7])
            first = chain.MiniMaxH3ChainLoopStart().start(plan, 1)[1]
            self.assertIsNone(first["previous_latent"])
            self.assertIsNone(first["previous_frames"])
            self.assertEqual(first["segments"], [])
            first["previous_latent"] = {"old_scene": True}
            second = chain.MiniMaxH3ChainLoopStart().start(plan, 1)[1]
            self.assertIsNone(second["previous_latent"])

        workflow = build_workflow(json.loads(SOURCE.read_bytes()), "development-id")
        for node in workflow["nodes"]:
            if not 1201 <= node["id"] <= 1207:
                continue
            schema = schemas[node["type"]]
            fields = schema_tool.fields(schema)
            controls = list(schema_tool.widget_fields(schema, {}))
            self.assertEqual(len(node["widgets_values"]), len(controls), node["type"])
            for (name, field), value in zip(controls, node["widgets_values"]):
                schema_tool.validate_value(value, field, f"{node['type']}.{name}")
            for item in node["inputs"]:
                self.assertIn(item["name"], fields)
                self.assertEqual(item["type"], fields[item["name"]][0])
            self.assertEqual([item["type"] for item in node["outputs"]], schema["output"])


if __name__ == "__main__":
    unittest.main()

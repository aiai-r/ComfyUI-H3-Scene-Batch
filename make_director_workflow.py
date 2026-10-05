import argparse
import copy
import json
from pathlib import Path
from uuid import uuid4

from director import DEFAULT_PLAN


REMOVED = {817, 846, 92}
MUTED = {822, 952, 953, 954, 224, 805, 962, 963, 964}
GENERATION_NODES = {136, 126, 125, 122, 121, 807, 809, 810, 811, 812, 129, 123, 124, 820, 824, 808}


def build_workflow(source, workflow_id):
    workflow = copy.deepcopy(source)
    old = {node["id"]: node for node in source["nodes"]}
    generator = old[817]
    subgraph = next(graph for graph in source["definitions"]["subgraphs"] if graph["id"] == generator["type"])
    workflow["id"] = workflow_id
    workflow["nodes"] = [node for node in workflow["nodes"] if node["id"] not in REMOVED]
    workflow["links"] = [link for link in workflow["links"] if link[1] not in REMOVED and link[3] not in REMOVED]
    workflow["definitions"]["subgraphs"] = [graph for graph in workflow["definitions"]["subgraphs"] if graph["id"] != generator["type"]]
    for node in workflow["nodes"]:
        if node["id"] in MUTED:
            node["mode"] = 2
    nodes = {node["id"]: node for node in workflow["nodes"]}
    next_link = max(link[0] for link in source["links"]) + 1
    offset = max(node["pos"][0] + node["size"][0] for node in workflow["nodes"]) + 300 - 900

    def connect(origin, output, target, name):
        nonlocal next_link
        origin_node, target_node = nodes[origin], nodes[target]
        slot = next(i for i, item in enumerate(target_node["inputs"]) if item["name"] == name)
        workflow["links"] = [link for link in workflow["links"] if (link[3], link[4]) != (target, slot)]
        workflow["links"].append([next_link, origin, output, target, slot, origin_node["outputs"][output]["type"]])
        next_link += 1

    def add(node):
        if node["id"] in nodes:
            raise ValueError(f"Node id {node['id']} already exists.")
        node["pos"][0] += offset
        nodes[node["id"]] = node
        workflow["nodes"].append(node)

    def create(node_id, kind, inputs, outputs, widgets, pos, size=(350, 220)):
        node = {"id": node_id, "type": kind, "pos": list(pos), "size": list(size), "flags": {},
                "order": len(workflow["nodes"]), "mode": 0,
                "inputs": [{"name": name, "type": datatype, "link": None} for name, datatype in inputs],
                "outputs": [{"name": name, "type": datatype, "links": []} for name, datatype in outputs],
                "properties": {"Node name for S&R": kind}, "widgets_values": widgets}
        add(node)
        return node

    positions = {
        807: (900, -500), 808: (900, -340), 824: (900, -180),
        809: (1600, -500), 810: (1600, -280), 811: (1600, -100),
        812: (900, 50), 820: (1250, 50), 123: (3100, 650), 124: (3100, 850),
        136: (2550, 150), 126: (3550, 400), 129: (3550, 600),
        125: (4000, 150), 122: (4400, 150), 121: (4400, 350),
    }
    for original in subgraph["nodes"]:
        if original["id"] not in GENERATION_NODES:
            continue
        node = copy.deepcopy(original)
        node["pos"] = list(positions[node["id"]])
        for item in node.get("inputs", []):
            item["link"] = None
        for item in node.get("outputs", []):
            item["links"] = []
        add(node)

    # Promoted values on the outer subgraph are the effective user settings.
    settings = {
        807: [(0, 1)], 808: [(0, 2), (1, 3)], 824: [(0, 4), (1, 5)],
        809: [(0, 6)], 810: [(0, 7)], 811: [(0, 8)], 812: [(0, 9)],
        123: [(0, 11)], 124: [(0, 12)], 820: [(0, 14), (1, 15), (2, 16)],
    }
    for node_id, pairs in settings.items():
        node = nodes[node_id]
        widget_names = [item["widget"]["name"] for item in node["inputs"] if "widget" in item]
        for widget_index, outer_index in pairs:
            value = copy.deepcopy(generator["widgets_values"][outer_index])
            node["widgets_values"][widget_index] = value
            if "widgets_values_named" in node:
                node["widgets_values_named"][widget_names[widget_index]] = value

    # Keep only connections between the reused native generation nodes.
    for link in subgraph["links"]:
        if link["origin_id"] in GENERATION_NODES and link["target_id"] in GENERATION_NODES:
            target = nodes[link["target_id"]]
            connect(link["origin_id"], link["origin_slot"], link["target_id"], target["inputs"][link["target_slot"]]["name"])
    old_links = {link[0]: link for link in source["links"]}
    for item in generator["inputs"]:
        if item["name"].startswith("ref_") and item["link"] is not None:
            link = old_links[item["link"]]
            connect(link[1], link[2], 136, item["name"])
    connect(824, 0, 159, "model")
    connect(801, 0, 126, "model")

    create(1200, "H3SceneDirector", [("width", "INT"), ("height", "INT"), ("steps", "INT"), ("base_seed", "INT")],
           [("plan", "H3_CHAIN_PLAN"), ("summary", "STRING")], ["h3_scene_director_trial", DEFAULT_PLAN], (900, 400), (650, 530))
    create(1201, "MiniMaxH3ChainLoopStart", [("plan", "H3_CHAIN_PLAN")],
           [("flow", "H3_CHAIN_FLOW"), ("state", "H3_CHAIN_STATE"), ("status", "STRING")], [1, "", True], (1650, 500))
    current_outputs = list(zip(
        ["state", "clip_index", "clip_count", "shot_id", "prompt", "noise_seed", "length", "steps", "width", "height", "audio_start", "audio_duration", "source_audio_slice", "status", "video_blend_frames"],
        ["H3_CHAIN_STATE", "INT", "INT", "STRING", "STRING", "INT", "INT", "INT", "INT", "INT", "FLOAT", "FLOAT", "AUDIO", "STRING", "INT"]))
    create(1202, "MiniMaxH3ChainCurrent", [("state", "H3_CHAIN_STATE")], current_outputs, [False], (2050, 150), (360, 410))
    create(1203, "MiniMaxH3ChainContext", [("state", "H3_CHAIN_STATE"), ("conditioning", "CONDITIONING"), ("vae", "VAE"), ("latent", "LATENT"), ("audio_vae", "VAE")],
           [("conditioning", "CONDITIONING"), ("trim_frames", "INT"), ("is_continuation", "BOOLEAN"), ("latent", "LATENT"), ("model", "MODEL")], [], (3100, 150))
    trim = create(1204, "MiniMaxH3LoopTrim", [("images", "IMAGE"), ("trim_frames", "INT"), ("audio", "AUDIO"), ("state", "H3_CHAIN_STATE")],
                  [("images", "IMAGE"), ("audio", "AUDIO"), ("images_with_overlap", "IMAGE"), ("overlap_frames", "INT")], [0, 24, True, 0], (4850, 150))
    trim["inputs"][1]["widget"] = {"name": "trim_frames"}
    create(1205, "MiniMaxH3ChainSegmentSave", [("state", "H3_CHAIN_STATE"), ("images", "IMAGE"), ("sampled_latent", "LATENT"), ("audio", "AUDIO"), ("images_with_overlap", "IMAGE"), ("denoised_latent", "LATENT")],
           [("segment", "H3_CHAIN_SEGMENT"), ("status", "STRING")], [], (4850, 500))
    create(1206, "MiniMaxH3ChainLoopEnd", [("flow", "H3_CHAIN_FLOW"), ("state", "H3_CHAIN_STATE"), ("images", "IMAGE"), ("sampled_latent", "LATENT"), ("segment", "H3_CHAIN_SEGMENT")],
           [("manifest", "H3_CHAIN_MANIFEST"), ("manifest_json", "STRING"), ("last_context_frames", "IMAGE"), ("last_context_latent", "LATENT")], ["off", "recursive_legacy"], (5300, 150))
    create(1207, "MiniMaxH3ChainAssemble", [("manifest", "H3_CHAIN_MANIFEST")], [("video_path", "STRING")],
           ["plan", "scene", 256, False, "", "plan", "off", "off"], (5750, 150), (430, 340))
    create(1208, "PreviewAny", [("source", "*")], [], [], (900, 1050), (650, 280))
    create(1209, "PreviewAny", [("source", "*")], [], [], (5750, 600), (430, 180))

    for source_id, slot, target_id, name in [
        (820, 0, 1200, "width"), (820, 1, 1200, "height"), (812, 0, 1200, "steps"), (841, 0, 1200, "base_seed"),
        (1200, 0, 1201, "plan"), (1200, 1, 1208, "source"), (1201, 1, 1202, "state"),
        (1202, 4, 136, "prompt"), (1202, 8, 136, "width"), (1202, 9, 136, "height"), (1202, 6, 136, "length"),
        (1202, 5, 129, "noise_seed"), (1202, 7, 124, "steps"),
        (1202, 0, 1203, "state"), (136, 0, 1203, "conditioning"), (136, 1, 1203, "latent"),
        (810, 0, 1203, "vae"), (811, 0, 1203, "audio_vae"),
        (1203, 0, 126, "conditioning"), (1203, 3, 125, "latent_image"),
        (122, 0, 1204, "images"), (121, 0, 1204, "audio"), (1203, 1, 1204, "trim_frames"), (1202, 0, 1204, "state"),
        (1202, 0, 1205, "state"), (1204, 0, 1205, "images"), (125, 0, 1205, "sampled_latent"),
        (1204, 1, 1205, "audio"), (1204, 2, 1205, "images_with_overlap"),
        (1201, 0, 1206, "flow"), (1202, 0, 1206, "state"), (1204, 0, 1206, "images"),
        (125, 0, 1206, "sampled_latent"), (1205, 0, 1206, "segment"),
        (1206, 0, 1207, "manifest"), (1207, 0, 1209, "source"),
    ]:
        connect(source_id, slot, target_id, name)

    # Rebuild socket references after removing the original generation branch.
    for node in workflow["nodes"]:
        for item in node.get("inputs", []):
            item["link"] = None
        for item in node.get("outputs", []):
            item["links"] = []
    for link_id, origin, output, target, slot, _ in workflow["links"]:
        nodes[origin]["outputs"][output]["links"].append(link_id)
        nodes[target]["inputs"][slot]["link"] = link_id
    workflow["last_node_id"] = max(nodes)
    workflow["last_link_id"] = next_link - 1
    workflow.setdefault("extra", {})["ds"] = {"scale": 0.65, "offset": [-800 - offset, -300]}
    return workflow


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    if args.source.resolve() == args.output.resolve():
        raise ValueError("Choose a development copy, not the source workflow.")
    source = json.loads(args.source.read_text(encoding="utf-8"))
    previous = json.loads(args.output.read_text(encoding="utf-8")) if args.output.exists() else None
    workflow_id = previous["id"] if previous else str(uuid4())
    result = build_workflow(source, workflow_id)
    if previous:
        original_copy = {**source, "id": workflow_id}
        if previous != original_copy and previous != result:
            raise ValueError("Development workflow has edits; refusing to overwrite it.")
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(args.output)


if __name__ == "__main__":
    main()

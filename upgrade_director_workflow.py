import argparse
import copy
import json
from pathlib import Path


def upgrade(workflow):
    result = copy.deepcopy(workflow)
    nodes = {node["id"]: node for node in result["nodes"]}
    director = nodes[1200]
    if director["type"] != "H3SceneDirector" or nodes[136]["type"] != "MiniMaxH3ReferenceToVideo":
        raise ValueError("Expected the stage 1 Director development workflow.")
    if "h3_llm" in director.get("properties", {}) or 1210 in nodes:
        raise ValueError("Workflow is already upgraded or node 1210 is occupied.")
    links = {link[0]: link for link in result["links"]}
    assets = []
    for item in nodes[136]["inputs"]:
        if not item["name"].startswith("ref_") or item.get("link") is None:
            continue
        link = links[item["link"]]
        loader = nodes[link[1]]
        kind = {"LoadImage": "image", "LoadAudio": "audio"}.get(loader["type"])
        if kind is None or link[2] != 0:
            raise ValueError(f"Reference {item['name']} uses {loader['type']}; migrate its processing explicitly.")
        assets.append({"kind": kind, "role": "reference", "file": loader["widgets_values"][0], "enabled": True, "note": ""})
    scene = {"mode": "R2V", "assets": assets, "ref_image_size": nodes[136]["widgets_values"][-1]}
    outer = nodes[822]
    subgraph = next(g for g in result["definitions"]["subgraphs"] if g["id"] == outer["type"])
    llm_nodes = {n["id"]: n for n in subgraph["nodes"]}

    def values(node_id):
        node = llm_nodes[node_id]
        if "widgets_values_named" in node:
            return copy.deepcopy(node["widgets_values_named"])
        names = [i["widget"]["name"] for i in node["inputs"] if "widget" in i]
        if len(names) != len(node["widgets_values"]):
            raise ValueError(f"Cannot safely map widgets for {node['type']}.")
        return dict(zip(names, node["widgets_values"]))

    config = {"loader": values(496)}
    config["loader"].update(model=outer["widgets_values"][3], mmproj=outer["widgets_values"][4])
    for key, node_id, parameters, seed_index in [("story", 803, 804, 0), ("prompt", 210, 497, 1)]:
        inputs = values(node_id)
        for name in ("custom_prompt", "system_prompt", "control_after_generate"):
            inputs.pop(name, None)
        seed_input = next(i for i in outer["inputs"] if i["name"] == ("seed" if seed_index == 0 else "seed_1"))
        if seed_input.get("link") is not None:
            seed_link = links[seed_input["link"]]
            seed_node = nodes[seed_link[1]]
            if seed_node["type"] not in ("ttN seed", "PrimitiveInt") or seed_link[2] != 0:
                raise ValueError("Resolve the connected LLM seed before migrating.")
            inputs["seed"] = seed_node["widgets_values"][0]
        else:
            inputs["seed"] = outer["widgets_values"][seed_index]
        config[key] = {"inputs": inputs, "parameters": values(parameters)}
    director.setdefault("properties", {})["h3_llm"] = config
    director["widgets_values"].append(json.dumps(scene, ensure_ascii=False))
    if "widgets_values_named" in director:
        director["widgets_values_named"]["scene_json"] = director["widgets_values"][-1]
    director["outputs"].append({"name": "scene", "type": "H3_SCENE", "links": []})
    nodes[136]["mode"] = 2
    input_types = [("scene", "H3_SCENE"), ("clip", "CLIP"), ("vae", "VAE"), ("prompt", "STRING"),
                   ("width", "INT"), ("height", "INT"), ("length", "INT"), ("clip_index", "INT"),
                   ("clip_count", "INT"), ("audio_vae", "VAE")]
    node = {"id": 1210, "type": "H3SceneConditioning", "pos": [nodes[136]["pos"][0], nodes[136]["pos"][1] + 800],
            "size": [360, 270], "flags": {}, "order": len(nodes), "mode": 0,
            "inputs": [{"name": name, "type": kind, "link": None} for name, kind in input_types],
            "outputs": [{"name": "positive", "type": "CONDITIONING", "links": []}, {"name": "latent", "type": "LATENT", "links": []}],
            "properties": {"Node name for S&R": "H3SceneConditioning"}, "widgets_values": []}
    result["nodes"].append(node); nodes[1210] = node
    for link in result["links"]:
        if link[1] == 136:
            link[1] = 1210
    next_link = max(links) + 1
    for origin, output, name in [(1200, 2, "scene"), (809, 0, "clip"), (810, 0, "vae"), (811, 0, "audio_vae"),
                                 (1202, 4, "prompt"), (1202, 8, "width"), (1202, 9, "height"), (1202, 6, "length"),
                                 (1202, 1, "clip_index"), (1202, 2, "clip_count")]:
        slot = next(i for i, item in enumerate(node["inputs"]) if item["name"] == name)
        result["links"].append([next_link, origin, output, 1210, slot, node["inputs"][slot]["type"]]); next_link += 1
    for n in result["nodes"]:
        for item in n.get("inputs", []): item["link"] = None
        for item in n.get("outputs", []): item["links"] = []
    for link_id, origin, output, target, slot, _ in result["links"]:
        nodes[origin]["outputs"][output]["links"].append(link_id)
        nodes[target]["inputs"][slot]["link"] = link_id
    result["last_node_id"] = max(nodes)
    result["last_link_id"] = next_link - 1
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("workflow", type=Path)
    args = parser.parse_args()
    if args.workflow.name != "video_minimax_h3_scene_director_dev.json":
        raise ValueError("Upgrade only the named development workflow.")
    original = args.workflow.read_bytes()
    updated = upgrade(json.loads(original))
    backup = args.workflow.with_suffix(".stage1-backup.json")
    if backup.exists():
        raise ValueError("Stage 1 backup already exists; inspect it before upgrading again.")
    backup.write_bytes(original)
    args.workflow.write_text(json.dumps(updated, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(args.workflow)

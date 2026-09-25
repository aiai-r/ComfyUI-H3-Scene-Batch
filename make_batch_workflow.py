import copy
import json
from pathlib import Path


def make_batch_workflow(source):
    workflow = copy.deepcopy(source)
    nodes = {node["id"]: node for node in workflow["nodes"]}
    generator = nodes[817]
    save_video = nodes[92]
    old_links = {link[0]: link for link in workflow["links"]}
    next_link = workflow["last_link_id"] + 1

    def disconnect(target, name):
        slot = next(index for index, item in enumerate(target["inputs"]) if item["name"] == name)
        old_id = target["inputs"][slot]["link"]
        if old_id is not None:
            old = old_links.pop(old_id)
            origin = nodes[old[1]]["outputs"][old[2]]
            origin["links"] = [link for link in origin["links"] if link != old_id]
            workflow["links"] = [link for link in workflow["links"] if link[0] != old_id]
        target["inputs"][slot]["link"] = None
        return slot

    def connect(origin, output_slot, target, input_name, link_type):
        nonlocal next_link
        target_slot = disconnect(target, input_name)
        link = [next_link, origin["id"], output_slot, target["id"], target_slot, link_type]
        workflow["links"].append(link)
        origin["outputs"][output_slot]["links"].append(next_link)
        target["inputs"][target_slot]["link"] = next_link
        next_link += 1

    batch = {
        "id": 831, "type": "H3SceneBatchLoad", "pos": [-2050, 1700], "size": [530, 120],
        "flags": {}, "order": 34, "mode": 0,
        "inputs": [
            {"name": "manifest_path", "type": "STRING", "widget": {"name": "manifest_path"}, "link": None},
            {"name": "image_root", "type": "STRING", "widget": {"name": "image_root"}, "link": None},
            {"name": "start_at", "type": "INT", "widget": {"name": "start_at"}, "link": None},
            {"name": "auto_queue", "type": "BOOLEAN", "widget": {"name": "auto_queue"}, "link": None},
        ],
        "outputs": [{"name": name, "type": kind, "links": []} for name, kind in (
            [("prompt", "STRING"), ("seed", "INT"), ("duration", "FLOAT")]
            + [(f"image_path_{index}", "STRING") for index in range(1, 10)]
            + [("filename_prefix", "STRING")]
        )],
        "properties": {"Node name for S&R": "H3SceneBatchLoad"},
        "widgets_values": ["/notebooks/h3_scene_trial/scenes.json", "/notebooks/h3_scene_trial/images", 0, True],
    }
    workflow["nodes"].append(batch)
    nodes[831] = batch
    connect(batch, 0, generator, "prompt", "STRING")
    connect(batch, 1, generator, "noise_seed", "INT")
    connect(batch, 2, generator, "value_1", "FLOAT")
    connect(batch, 12, save_video, "filename_prefix", "STRING")

    for index in range(9):
        loader = {
            "id": 832 + index, "type": "H3SceneImagePath",
            "pos": [-1300 + (index % 3) * 430, 1700 + (index // 3) * 240],
            "size": [380, 90], "flags": {}, "order": 35 + index, "mode": 0,
            "inputs": [{"name": "path", "type": "STRING", "widget": {"name": "path"}, "link": None}],
            "outputs": [{"name": "IMAGE", "type": "IMAGE", "links": []}],
            "properties": {"Node name for S&R": "H3SceneImagePath"},
            "widgets_values": [""],
        }
        workflow["nodes"].append(loader)
        nodes[loader["id"]] = loader
        connect(batch, 3 + index, loader, "path", "STRING")
        connect(loader, 0, generator, f"ref_images.ref_image_{index}", "IMAGE")

    for node_id in (822, 224, 805):
        nodes[node_id]["mode"] = 4
    workflow["last_node_id"] = 840
    workflow["last_link_id"] = next_link - 1
    return workflow


if __name__ == "__main__":
    root = Path(__file__).resolve().parents[2]
    workflows = root / "user" / "default" / "workflows"
    source = workflows / "video_minimax_h3_r2v_llm_story.json"
    target = workflows / "video_minimax_h3_r2v_scene_batch.json"
    target.write_text(json.dumps(make_batch_workflow(json.loads(source.read_text(encoding="utf-8"))), ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(target)

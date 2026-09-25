import argparse
import copy
import json
import time
import urllib.request
from pathlib import Path


def build_prompt(template, scene, project, steps, megapixels, generator_id="817:136", save_id="92"):
    prompt = copy.deepcopy(template.get("prompt", template))
    prefix = generator_id.split(":")[0]
    required = (generator_id, f"{prefix}:812", f"{prefix}:129", f"{prefix}:819", f"{prefix}:820", save_id)
    if any(node_id not in prompt for node_id in required):
        raise ValueError("API workflow does not match the current H3 subgraph and SaveVideo nodes.")
    generator = prompt[generator_id]["inputs"]
    generator["prompt"] = scene["prompt"]
    prompt[f"{prefix}:812"]["inputs"]["value"] = steps
    prompt[f"{prefix}:129"]["inputs"]["noise_seed"] = scene["seed"]
    prompt[f"{prefix}:819"]["inputs"]["value"] = scene["duration"]
    prompt[f"{prefix}:820"]["inputs"]["megapixels"] = megapixels
    for name in list(generator):
        if name.startswith("ref_images.ref_image_"):
            del generator[name]

    for index, relative in enumerate(scene["images"]):
        image = (project / relative).resolve()
        if not image.is_relative_to(project.resolve()) or not image.is_file():
            raise ValueError(f"Missing or invalid image: {relative}")
        node_id = f"scene_image_{index}"
        prompt[node_id] = {"class_type": "H3SceneImagePath", "inputs": {"path": str(image)}}
        generator[f"ref_images.ref_image_{index}"] = [node_id, 0]

    prompt[save_id]["inputs"]["filename_prefix"] = f"h3_scenes/{scene['id']}"
    return prompt


def request_json(url, payload=None):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"} if data else {})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def run(project, api_workflow, steps, megapixels, url, generator_id, save_id):
    scenes = json.loads((project / "scenes.json").read_text(encoding="utf-8"))
    template = json.loads(api_workflow.read_text(encoding="utf-8"))
    for scene in scenes:
        prompt = build_prompt(template, scene, project, steps, megapixels, generator_id, save_id)
        result = request_json(f"{url}/prompt", {"prompt": prompt})
        if "error" in result or "prompt_id" not in result:
            raise RuntimeError(f"{scene['id']}: {result}")
        prompt_id = result["prompt_id"]
        print(f"Queued {scene['id']}: {prompt_id}", flush=True)
        while True:
            history = request_json(f"{url}/history/{prompt_id}").get(prompt_id)
            if history:
                status = history.get("status", {})
                if status.get("status_str") != "success":
                    raise RuntimeError(f"{scene['id']}: {status}")
                print(f"Finished {scene['id']}", flush=True)
                break
            time.sleep(2)


def main():
    parser = argparse.ArgumentParser(description="Queue saved H3 scenes one at a time.")
    parser.add_argument("project", type=Path)
    parser.add_argument("api_workflow", type=Path, help="Current workflow exported with Save (API Format)")
    parser.add_argument("--steps", type=int, default=12)
    parser.add_argument("--megapixels", type=float, default=0.98)
    parser.add_argument("--url", default="http://127.0.0.1:8188")
    parser.add_argument("--generator-id", default="817:136")
    parser.add_argument("--save-id", default="92")
    args = parser.parse_args()
    run(args.project.resolve(), args.api_workflow, args.steps, args.megapixels, args.url.rstrip("/"), args.generator_id, args.save_id)


if __name__ == "__main__":
    main()

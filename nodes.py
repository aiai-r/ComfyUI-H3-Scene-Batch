import json
import os
import re
import shutil
from pathlib import Path

import numpy as np
import torch
from aiohttp import web
from PIL import Image, ImageOps

import folder_paths
from server import PromptServer


def save_scene(project_dir, scene_id, prompt, image_paths, seed, duration):
    if not project_dir.strip():
        raise ValueError("Set a project directory.")
    if not prompt.strip():
        raise ValueError("Enter the finalized H3 prompt.")
    if not re.fullmatch(r"[A-Za-z0-9_-]+", scene_id):
        raise ValueError("Scene ID must contain only letters, numbers, _ or -.")
    sources = []
    for line in image_paths.splitlines():
        if not line.strip():
            continue
        source = Path(line.strip().strip('"')).expanduser()
        if not source.is_absolute():
            source = Path(folder_paths.get_input_directory()) / source
        sources.append(source.resolve())
    if not 1 <= len(sources) <= 9:
        raise ValueError("Enter 1 to 9 image paths, one per line.")
    for source in sources:
        if not source.is_file():
            raise FileNotFoundError(source)

    project = Path(project_dir).expanduser().resolve()
    manifest = project / "scenes.json"
    scenes = json.loads(manifest.read_text(encoding="utf-8")) if manifest.exists() else []
    if not isinstance(scenes, list):
        raise ValueError("scenes.json must contain a list.")
    if any(scene.get("id") == scene_id for scene in scenes):
        raise ValueError(f"Scene {scene_id} is already saved.")

    target_dir = project / "images" / scene_id
    target_dir.mkdir(parents=True, exist_ok=True)
    images = []
    for index, source in enumerate(sources, 1):
        target = target_dir / f"{index:02d}{source.suffix.lower()}"
        shutil.copy2(source, target)
        images.append(target.relative_to(project).as_posix())

    scenes.append({"id": scene_id, "prompt": prompt, "images": images, "seed": seed, "duration": duration})
    temporary = manifest.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(scenes, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, manifest)
    return str(manifest)


def latest_scene(history):
    for prompt_id, entry in reversed(list(history.items())):
        graph = entry["prompt"][2]
        output = entry.get("outputs", {}).get("224", {}).get("text", [])
        if entry.get("status", {}).get("status_str") != "success" or "817:136" not in graph or not output:
            continue
        references = graph["817:136"]["inputs"]
        if graph["224"]["inputs"]["source"] != references["prompt"]:
            raise ValueError("The preview prompt does not match the generated video prompt.")
        image_paths = []
        for index in range(9):
            link = references.get(f"ref_images.ref_image_{index}")
            if link is None:
                break
            source = graph[str(link[0])]
            if source["class_type"] == "LoadImage":
                image_paths.append(folder_paths.get_annotated_filepath(source["inputs"]["image"]))
            elif source["class_type"] == "H3SceneImagePath":
                image_paths.append(source["inputs"]["path"])
            else:
                raise ValueError(f"Unsupported reference image source: {source['class_type']}")
        if not image_paths:
            raise ValueError("The latest H3 run has no reference images.")
        return {
            "prompt_id": prompt_id,
            "prompt": output[0],
            "image_paths": image_paths,
            "seed": graph["817:129"]["inputs"]["noise_seed"],
            "duration": graph["817:819"]["inputs"]["value"],
        }
    raise ValueError("No completed run of this H3 workflow was found in recent history.")


@PromptServer.instance.routes.post("/h3_scene_batch/save_latest")
async def save_latest(request):
    data = await request.json()
    try:
        history = PromptServer.instance.prompt_queue.get_history(max_items=20)
        scene = latest_scene(history)
        path = save_scene(
            data["project_dir"], data["scene_id"], scene["prompt"],
            "\n".join(scene["image_paths"]), scene["seed"], scene["duration"],
        )
    except (KeyError, TypeError, ValueError, FileNotFoundError, OSError) as error:
        return web.json_response({"error": str(error)}, status=400)
    return web.json_response({"path": path, "prompt_id": scene["prompt_id"], "images": len(scene["image_paths"])})


class H3SceneCapture:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "project_dir": ("STRING", {"default": ""}),
            "scene_id": ("STRING", {"default": "scene01"}),
        }}

    RETURN_TYPES = ()
    FUNCTION = "noop"
    CATEGORY = "MiniMax H3/Scene Batch"

    def noop(self, project_dir, scene_id):
        return ()


class H3SceneImagePath:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"path": ("STRING", {"default": ""})}}

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "load"
    CATEGORY = "MiniMax H3/Scene Batch"

    def load(self, path):
        with Image.open(Path(path).expanduser()) as source:
            image = ImageOps.exif_transpose(source).convert("RGB")
            pixels = np.asarray(image, dtype=np.float32) / 255.0
        return (torch.from_numpy(pixels).unsqueeze(0),)


NODE_CLASS_MAPPINGS = {"H3SceneCapture": H3SceneCapture, "H3SceneImagePath": H3SceneImagePath}
NODE_DISPLAY_NAME_MAPPINGS = {"H3SceneCapture": "H3 Scene Capture", "H3SceneImagePath": "H3 Scene Image Path"}

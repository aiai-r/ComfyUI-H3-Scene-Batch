import json
import os
import re
import shutil
from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageOps

import folder_paths


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


class H3SceneSave:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "project_dir": ("STRING", {"default": ""}),
            "scene_id": ("STRING", {"default": "scene01"}),
            "prompt": ("STRING", {"multiline": True, "default": ""}),
            "image_paths": ("STRING", {"multiline": True, "default": ""}),
            "seed": ("INT", {"default": 42, "min": 0, "max": 0xffffffffffffffff}),
            "duration": ("FLOAT", {"default": 15.0, "min": 0.1}),
        }}

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("manifest_path",)
    FUNCTION = "save"
    CATEGORY = "MiniMax H3/Scene Batch"
    OUTPUT_NODE = True

    def save(self, project_dir, scene_id, prompt, image_paths, seed, duration):
        return (save_scene(project_dir, scene_id, prompt, image_paths, seed, duration),)


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


NODE_CLASS_MAPPINGS = {"H3SceneSave": H3SceneSave, "H3SceneImagePath": H3SceneImagePath}
NODE_DISPLAY_NAME_MAPPINGS = {"H3SceneSave": "H3 Scene Save", "H3SceneImagePath": "H3 Scene Image Path"}

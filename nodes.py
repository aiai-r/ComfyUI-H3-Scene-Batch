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
from comfy_api.latest import InputImpl
from comfy_extras.nodes_audio import load as load_audio
from server import PromptServer
from .media import MEDIA_INPUTS, capture_media, copy_media, expand_media, is_link
from .duplicates import duplicate_scenes


def validate_scene_numbers(seed, duration):
    if type(seed) is not int:
        raise ValueError("Saved seed must be an integer, not a node link. Restore the actual seed in scenes.json.")
    if type(duration) not in (int, float):
        raise ValueError("Saved duration must be a number, not a node link. Restore the actual duration in scenes.json.")


def resolve_number(graph, value):
    visited = set()
    while is_link(value):
        node_id, slot = value
        if node_id in visited:
            raise ValueError(f"Cyclic numeric input at node {node_id}.")
        visited.add(node_id)
        node = graph[node_id]
        field = {"ttN seed": "seed", "PrimitiveInt": "value", "PrimitiveFloat": "value"}.get(node["class_type"])
        if field is None or slot != 0:
            raise ValueError(f"Cannot capture numeric output from {node['class_type']} ({node_id}); use a literal value or a supported numeric node.")
        value = node["inputs"][field]
    return value


def save_scene(project_dir, scene_id, prompt, image_paths, seed, duration, media=None):
    validate_scene_numbers(seed, duration)
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
    if len(sources) > 9:
        raise ValueError("Enter up to 9 image paths, one per line.")
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
        target = target_dir / f"{index:02d}" / source.name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        images.append(target.relative_to(project / "images").as_posix())

    scene = {"id": scene_id, "prompt": prompt, "images": images, "seed": seed, "duration": duration}
    if media is not None:
        scene["media"] = copy_media(media, project / "images", scene_id)
    scenes.append(scene)
    temporary = manifest.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(scenes, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, manifest)
    return str(manifest)


def next_scene_id(project_dir):
    if not project_dir.strip():
        raise ValueError("Set a project directory.")
    manifest = Path(project_dir).expanduser().resolve() / "scenes.json"
    scenes = json.loads(manifest.read_text(encoding="utf-8")) if manifest.exists() else []
    numbers = [int(match.group(1)) for scene in scenes if (match := re.fullmatch(r"scene(\d+)", scene["id"]))]
    return f"scene{max(numbers, default=0) + 1:02d}"


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
        missing_image = False
        for index in range(9):
            link = references.get(f"ref_images.ref_image_{index}")
            if link is None:
                missing_image = True
                continue
            if missing_image:
                raise ValueError("Connect reference images without empty slots before saving.")
            source = graph[str(link[0])]
            if source["class_type"] == "LoadImage":
                image_paths.append(folder_paths.get_annotated_filepath(source["inputs"]["image"]))
            elif source["class_type"] == "H3SceneImagePath":
                image_paths.append(source["inputs"]["path"])
            else:
                raise ValueError(f"Unsupported reference image source: {source['class_type']}")
        seed = resolve_number(graph, graph["817:129"]["inputs"]["noise_seed"])
        duration = resolve_number(graph, graph["817:819"]["inputs"]["value"])
        validate_scene_numbers(seed, duration)
        return {
            "prompt_id": prompt_id,
            "prompt": output[0],
            "image_paths": image_paths,
            "seed": seed,
            "duration": duration,
            "media": capture_media(graph, references),
        }
    raise ValueError("No completed run of this H3 workflow was found in recent history.")


@PromptServer.instance.routes.post("/h3_scene_batch/save_latest")
async def save_latest(request):
    data = await request.json()
    try:
        history = PromptServer.instance.prompt_queue.get_history(max_items=20)
        scene = latest_scene(history)
        scene_id = next_scene_id(data["project_dir"])
        fingerprint, duplicates = duplicate_scenes(data["project_dir"], scene)
        confirmation = data.get("confirm_fingerprint")
        if confirmation is not None and confirmation != fingerprint:
            raise ValueError("確認中にシーンの内容が変わりました。もう一度保存してください。")
        if duplicates and confirmation != fingerprint:
            return web.json_response({"duplicates": duplicates, "fingerprint": fingerprint})
        path = save_scene(
            data["project_dir"], scene_id, scene["prompt"],
            "\n".join(scene["image_paths"]), scene["seed"], scene["duration"],
            scene["media"],
        )
    except (KeyError, TypeError, ValueError, FileNotFoundError, OSError) as error:
        return web.json_response({"error": str(error)}, status=400)
    return web.json_response({"path": path, "scene_id": scene_id, "prompt_id": scene["prompt_id"], "images": len(scene["image_paths"]), "media": len(scene["media"]["outputs"])})


@PromptServer.instance.routes.post("/h3_scene_batch/open_folder")
async def open_folder(request):
    data = await request.json()
    try:
        project_dir = data["project_dir"]
        if not isinstance(project_dir, str) or not project_dir.strip():
            raise ValueError("保存先フォルダを指定してください。")
        if os.name != "nt":
            raise ValueError("フォルダを開く機能はWindows上のComfyUIで利用できます。")
        project = Path(project_dir).expanduser().resolve()
        if not project.is_dir():
            raise ValueError("保存先フォルダがありません。先にシーンを保存してください。")
        os.startfile(str(project))
    except (KeyError, TypeError, ValueError, OSError) as error:
        return web.json_response({"error": str(error)}, status=400)
    return web.json_response({"path": str(project)})


@PromptServer.instance.routes.post("/h3_scene_batch/manifest_info")
async def manifest_info(request):
    data = await request.json()
    try:
        scenes = json.loads(Path(data["manifest_path"]).expanduser().read_text(encoding="utf-8"))
        if not isinstance(scenes, list):
            raise ValueError("scenes.json must contain a list.")
    except (KeyError, TypeError, ValueError, OSError) as error:
        return web.json_response({"error": str(error)}, status=400)
    return web.json_response({"scene_count": len(scenes)})


class H3SceneCapture:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "project_dir": ("STRING", {"default": ""}),
        }}

    RETURN_TYPES = ()
    FUNCTION = "noop"
    CATEGORY = "MiniMax H3/Scene Batch"

    def noop(self, project_dir):
        return ()


class H3SceneImagePath:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"path": ("STRING", {"default": ""})}}

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "load"
    CATEGORY = "MiniMax H3/Scene Batch"

    def load(self, path):
        if not path:
            return (None,)
        with Image.open(Path(path).expanduser()) as source:
            image = ImageOps.exif_transpose(source).convert("RGB")
            pixels = np.asarray(image, dtype=np.float32) / 255.0
        return (torch.from_numpy(pixels).unsqueeze(0),)


class H3SceneAudioPath:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"path": ("STRING", {"default": ""})}}

    RETURN_TYPES = ("AUDIO",)
    FUNCTION = "load"
    CATEGORY = "MiniMax H3/Scene Batch"

    def load(self, path):
        waveform, sample_rate = load_audio(path)
        return ({"waveform": waveform.unsqueeze(0), "sample_rate": sample_rate},)


class H3SceneVideoPath:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"path": ("STRING", {"default": ""})}}

    RETURN_TYPES = ("VIDEO",)
    FUNCTION = "load"
    CATEGORY = "MiniMax H3/Scene Batch"

    def load(self, path):
        return (InputImpl.VideoFromFile(path),)


class H3SceneBatchLoad:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "manifest_path": ("STRING", {"default": ""}),
            "image_root": ("STRING", {"default": ""}),
            "start_at": ("INT", {"default": 0, "min": 0}),
            "auto_queue": ("BOOLEAN", {"default": True}),
        }}

    RETURN_TYPES = ("STRING", "INT", "FLOAT") + ("STRING",) * 10 + tuple(kind for _, kind in MEDIA_INPUTS)
    RETURN_NAMES = ("prompt", "seed", "duration") + tuple(f"image_path_{i}" for i in range(1, 10)) + ("filename_prefix",) + tuple(name.split(".")[1] for name, _ in MEDIA_INPUTS)
    FUNCTION = "load"
    CATEGORY = "MiniMax H3/Scene Batch"

    @classmethod
    def IS_CHANGED(cls, manifest_path, **kwargs):
        return os.path.getmtime(manifest_path)

    def load(self, manifest_path, image_root, start_at, auto_queue):
        scenes = json.loads(Path(manifest_path).expanduser().read_text(encoding="utf-8"))
        if not scenes:
            raise ValueError("No saved scenes found.")
        if start_at >= len(scenes):
            raise ValueError(f"Scene index {start_at} is beyond the {len(scenes)} saved scenes.")
        root = Path(image_root).expanduser().resolve()
        scene = scenes[start_at]
        try:
            validate_scene_numbers(scene["seed"], scene["duration"])
        except ValueError as error:
            raise ValueError(f"{scene['id']}: {error}") from error
        images = scene["images"]
        if len(images) > 9:
            raise ValueError(f"{scene['id']}: expected up to 9 images.")
        paths = []
        for index in range(9):
            if index < len(images):
                path = (root / images[index]).resolve()
                if not path.is_relative_to(root) or not path.is_file():
                    raise ValueError(f"{scene['id']}: missing image {images[index]}")
                paths.append(str(path))
            else:
                paths.append("")
        expanded, media = expand_media(scene.get("media", {}), root)
        return {
            "result": (scene["prompt"], scene["seed"], scene["duration"], *paths, f"h3_scenes/{scene['id']}", *media),
            "expand": expanded,
            "ui": {"start_at": [start_at], "scene_count": [len(scenes)], "scene_id": [scene["id"]],
                   "manifest_path": [manifest_path], "image_root": [image_root]},
        }


NODE_CLASS_MAPPINGS = {
    "H3SceneCapture": H3SceneCapture,
    "H3SceneImagePath": H3SceneImagePath,
    "H3SceneBatchLoad": H3SceneBatchLoad,
    "H3SceneAudioPath": H3SceneAudioPath,
    "H3SceneVideoPath": H3SceneVideoPath,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "H3SceneCapture": "H3 Scene Capture",
    "H3SceneImagePath": "H3 Scene Image Path",
    "H3SceneBatchLoad": "H3 Scene Batch Load",
    "H3SceneAudioPath": "H3 Scene Audio Path",
    "H3SceneVideoPath": "H3 Scene Video Path",
}

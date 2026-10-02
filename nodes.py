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
from .modes import MODES, capture_settings, scene_mode
from .cuts import H3SceneCutContextLoad, H3SceneCutContextSave, H3SceneJoinCuts, adopt_cut, discard_draft, draft_dir, read_draft


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


def validate_cut(prompt, image_paths, seed, duration, generation_mode):
    validate_scene_numbers(seed, duration)
    if generation_mode not in MODES:
        raise ValueError(f"Unsupported H3 mode: {generation_mode}")
    if not prompt.strip():
        raise ValueError("Enter the finalized H3 prompt.")
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
    return sources


def store_cut(project, folder, sources, prompt, seed, duration, media, generation_mode, generation_settings):
    target_dir = project / "images" / folder
    target_dir.mkdir(parents=True, exist_ok=True)
    images = []
    for index, source in enumerate(sources, 1):
        target = target_dir / f"{index:02d}" / source.name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        images.append(target.relative_to(project / "images").as_posix())

    scene = {"prompt": prompt, "images": images, "seed": seed, "duration": duration}
    scene["generation_mode"] = generation_mode
    if generation_settings is not None:
        scene["generation_settings"] = generation_settings
    if media is not None:
        scene["media"] = copy_media(media, project / "images", folder)
    return scene


def open_manifest(project_dir, scene_id):
    if not project_dir.strip():
        raise ValueError("Set a project directory.")
    if not re.fullmatch(r"[A-Za-z0-9_-]+", scene_id):
        raise ValueError("Scene ID must contain only letters, numbers, _ or -.")
    project = Path(project_dir).expanduser().resolve()
    manifest = project / "scenes.json"
    scenes = json.loads(manifest.read_text(encoding="utf-8")) if manifest.exists() else []
    if not isinstance(scenes, list):
        raise ValueError("scenes.json must contain a list.")
    if any(scene.get("id") == scene_id for scene in scenes):
        raise ValueError(f"Scene {scene_id} is already saved.")
    return project, manifest, scenes


def write_manifest(manifest, scenes):
    temporary = manifest.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(scenes, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, manifest)
    return str(manifest)


def save_scene(project_dir, scene_id, prompt, image_paths, seed, duration, media=None, generation_mode="R2V", generation_settings=None):
    sources = validate_cut(prompt, image_paths, seed, duration, generation_mode)
    project, manifest, scenes = open_manifest(project_dir, scene_id)
    scene = store_cut(project, scene_id, sources, prompt, seed, duration, media, generation_mode, generation_settings)
    scenes.append({"id": scene_id, **scene})
    return write_manifest(manifest, scenes)


def save_cut_scene(project_dir, scene_id, cuts):
    checked = [validate_cut(cut["prompt"], "\n".join(cut["image_paths"]), cut["seed"], cut["duration"], cut["generation_mode"]) for cut in cuts]
    project, manifest, scenes = open_manifest(project_dir, scene_id)
    saved = [
        store_cut(project, f"{scene_id}/cut{index:02d}", sources, cut["prompt"], cut["seed"], cut["duration"],
                  cut["media"], cut["generation_mode"], cut.get("generation_settings"))
        for index, (cut, sources) in enumerate(zip(cuts, checked), 1)
    ]
    scenes.append({"id": scene_id, "cuts": saved})
    return write_manifest(manifest, scenes)


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
        mode = scene_mode(graph["817:136"])
        names = [f"ref_images.ref_image_{i}" for i in range(9)] if mode == "R2V" else {
            "I2V": ["first_frame"], "L2V": ["last_frame"], "FL2V": ["first_frame", "last_frame"],
        }[mode]
        image_paths = []
        missing_image = False
        for name in names:
            link = references.get(name)
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
            "generation_mode": mode,
            "generation_settings": capture_settings(graph) if graph["817:136"].get("_meta", {}).get("h3_multimode") else None,
            "prompt_id": prompt_id,
            "prompt": output[0],
            "image_paths": image_paths,
            "seed": seed,
            "duration": duration,
            "media": capture_media(graph, references),
            "context_save": entry.get("outputs", {}).get("817:853", {}).get("context_dir", [None])[0],
            "context_load": graph.get("817:852", {}).get("inputs", {}).get("context_dir"),
        }
    raise ValueError("No completed run of this H3 workflow was found in recent history.")


@PromptServer.instance.routes.post("/h3_scene_batch/save_latest")
async def save_latest(request):
    data = await request.json()
    try:
        draft = read_draft(data["project_dir"])["cuts"]
        if len(draft) > 1:
            scene_id = next_scene_id(data["project_dir"])
            path = save_cut_scene(data["project_dir"], scene_id, draft)
            discard_draft(data["project_dir"])
            return web.json_response({"path": path, "scene_id": scene_id, "prompt_id": draft[-1]["prompt_id"], "cuts": len(draft),
                                      "images": sum(len(cut["image_paths"]) for cut in draft),
                                      "media": sum(len(cut["media"]["outputs"]) for cut in draft)})
        if draft:
            scene = draft[0]
        else:
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
            scene["media"], scene.get("generation_mode", "R2V"), scene.get("generation_settings"),
        )
        if draft:
            discard_draft(data["project_dir"])
    except (KeyError, TypeError, ValueError, FileNotFoundError, OSError) as error:
        return web.json_response({"error": str(error)}, status=400)
    return web.json_response({"path": path, "scene_id": scene_id, "prompt_id": scene["prompt_id"], "cuts": 1, "images": len(scene["image_paths"]), "media": len(scene["media"]["outputs"])})


@PromptServer.instance.routes.post("/h3_scene_batch/adopt_latest")
async def adopt_latest(request):
    data = await request.json()
    try:
        history = PromptServer.instance.prompt_queue.get_history(max_items=20)
        count = adopt_cut(data["project_dir"], latest_scene(history))
    except (KeyError, TypeError, ValueError, FileNotFoundError, OSError) as error:
        return web.json_response({"error": str(error)}, status=400)
    return web.json_response({"cut_count": count})


@PromptServer.instance.routes.post("/h3_scene_batch/draft_info")
async def draft_info(request):
    data = await request.json()
    try:
        cuts = read_draft(data["project_dir"])["cuts"]
        info = {"cut_count": len(cuts), "context_dir": "", "previous_prompt": ""}
        if cuts:
            info["context_dir"] = str(draft_dir(data["project_dir"]) / cuts[-1]["context"])
            info["previous_prompt"] = cuts[-1]["prompt"]
    except (KeyError, TypeError, ValueError, OSError) as error:
        return web.json_response({"error": str(error)}, status=400)
    return web.json_response(info)


@PromptServer.instance.routes.post("/h3_scene_batch/discard_draft")
async def discard(request):
    data = await request.json()
    try:
        discard_draft(data["project_dir"])
    except (KeyError, TypeError, ValueError, OSError) as error:
        return web.json_response({"error": str(error)}, status=400)
    return web.json_response({})


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


@PromptServer.instance.routes.post("/h3_scene_batch/scene_config")
async def scene_config(request):
    data = await request.json()
    try:
        scenes = json.loads(Path(data["manifest_path"]).expanduser().read_text(encoding="utf-8"))
        index = data["start_at"]
        if type(index) is not int or index < 0 or index >= len(scenes):
            raise ValueError("Saved scene index is out of range.")
        cuts = scenes[index].get("cuts") or [scenes[index]]
        cut_index = data.get("cut_index", 0)
        if type(cut_index) is not int or cut_index < 0 or cut_index >= len(cuts):
            raise ValueError("Saved cut index is out of range.")
        cut = cuts[cut_index]
        mode = cut.get("generation_mode", "R2V")
        if mode not in MODES:
            raise ValueError(f"Unsupported H3 mode: {mode}")
        return web.json_response({"generation_mode": mode, "generation_settings": cut.get("generation_settings", {}),
                                  "scene_id": scenes[index]["id"], "cut_index": cut_index, "cut_count": len(cuts)})
    except (KeyError, TypeError, ValueError, OSError) as error:
        return web.json_response({"error": str(error)}, status=400)


class H3SceneCapture:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "project_dir": ("STRING", {"default": ""}),
        }, "optional": {
            "execution_mode": (["シーン作成", "バッチ生成"], {"default": "シーン作成"}),
            "start_at": ("INT", {"default": 0, "min": 0}),
            "auto_queue": ("BOOLEAN", {"default": True}),
        }}

    RETURN_TYPES = ()
    FUNCTION = "noop"
    CATEGORY = "MiniMax H3/Scene Batch"

    def noop(self, project_dir, execution_mode="シーン作成", start_at=0, auto_queue=True):
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
        }, "optional": {"generation_mode": (list(MODES), {"default": "R2V", "forceInput": True}),
                        "cut_index": ("INT", {"default": 0, "min": 0, "forceInput": True})}}

    RETURN_TYPES = ("STRING", "INT", "FLOAT") + ("STRING",) * 10 + tuple(kind for _, kind in MEDIA_INPUTS)
    RETURN_NAMES = ("prompt", "seed", "duration") + tuple(f"image_path_{i}" for i in range(1, 10)) + ("filename_prefix",) + tuple(name.split(".")[1] for name, _ in MEDIA_INPUTS)
    FUNCTION = "load"
    CATEGORY = "MiniMax H3/Scene Batch"

    @classmethod
    def IS_CHANGED(cls, manifest_path, **kwargs):
        return os.path.getmtime(manifest_path)

    def load(self, manifest_path, image_root, start_at, auto_queue, generation_mode="R2V", cut_index=0):
        scenes = json.loads(Path(manifest_path).expanduser().read_text(encoding="utf-8"))
        if not scenes:
            raise ValueError("No saved scenes found.")
        if start_at >= len(scenes):
            raise ValueError(f"Scene index {start_at} is beyond the {len(scenes)} saved scenes.")
        root = Path(image_root).expanduser().resolve()
        cuts = scenes[start_at].get("cuts") or [scenes[start_at]]
        if cut_index >= len(cuts):
            raise ValueError(f"Cut index {cut_index} is beyond the {len(cuts)} saved cuts.")
        scene = {**cuts[cut_index], "id": scenes[start_at]["id"]}
        prefix = f"h3_scenes/{scene['id']}" if len(cuts) == 1 else f"h3_scenes/{scene['id']}/cut{cut_index + 1:02d}"
        if scene.get("generation_mode", "R2V") != generation_mode:
            raise ValueError("Scene mode does not match the queued graph. Use the multimode workflow and queue again.")
        seed = 4 if is_link(scene["seed"]) else scene["seed"]
        try:
            validate_scene_numbers(seed, scene["duration"])
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
            "result": (scene["prompt"], seed, scene["duration"], *paths, prefix, *media),
            "expand": expanded,
            "ui": {"start_at": [start_at], "scene_count": [len(scenes)], "scene_id": [scene["id"]],
                   "cut_index": [cut_index], "cut_count": [len(cuts)],
                   "manifest_path": [manifest_path], "image_root": [image_root]},
        }


NODE_CLASS_MAPPINGS = {
    "H3SceneCapture": H3SceneCapture,
    "H3SceneImagePath": H3SceneImagePath,
    "H3SceneBatchLoad": H3SceneBatchLoad,
    "H3SceneAudioPath": H3SceneAudioPath,
    "H3SceneVideoPath": H3SceneVideoPath,
    "H3SceneCutContextSave": H3SceneCutContextSave,
    "H3SceneCutContextLoad": H3SceneCutContextLoad,
    "H3SceneJoinCuts": H3SceneJoinCuts,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "H3SceneCapture": "H3 Scene Capture",
    "H3SceneImagePath": "H3 Scene Image Path",
    "H3SceneBatchLoad": "H3 Scene Batch Load",
    "H3SceneAudioPath": "H3 Scene Audio Path",
    "H3SceneVideoPath": "H3 Scene Video Path",
    "H3SceneCutContextSave": "H3 Scene Cut Context Save",
    "H3SceneCutContextLoad": "H3 Scene Cut Context Load",
    "H3SceneJoinCuts": "H3 Scene Join Cuts",
}

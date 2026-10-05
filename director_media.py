import json
from pathlib import Path

import folder_paths
import nodes
from comfy_execution.graph_utils import GraphBuilder


MODES = ("R2V", "T2V", "I2V", "L2V", "FL2V")
DEFAULT_SCENE = '{"mode":"R2V","assets":[],"ref_image_size":"match"}'


def read_scene(text):
    scene = json.loads(text)
    if not isinstance(scene, dict) or scene.get("mode") not in MODES or not isinstance(scene.get("assets"), list):
        raise ValueError("Scene must contain a supported mode and an assets list.")
    if scene.get("ref_image_size", "match") not in ("match", "max"):
        raise ValueError("Invalid reference image size.")
    for asset in scene["assets"]:
        if not isinstance(asset, dict) or asset.get("kind") not in ("image", "audio", "video"):
            raise ValueError("Invalid scene asset kind.")
        if asset.get("role", "reference") not in ("reference", "first", "last"):
            raise ValueError("Invalid scene asset role.")
        if asset.get("role", "reference") != "reference" and asset["kind"] != "image":
            raise ValueError("First and last frames must be images.")
    return scene


def active_assets(scene):
    roles = {"R2V": {"reference"}, "T2V": set(), "I2V": {"first"}, "L2V": {"last"}, "FL2V": {"first", "last"}}
    return [a for a in scene["assets"] if a.get("enabled", True) and a.get("role", "reference") in roles[scene["mode"]]]


def input_file(filename):
    if not isinstance(filename, str) or not filename.strip():
        raise ValueError("Choose a scene reference file.")
    root = Path(folder_paths.get_input_directory()).resolve()
    path = Path(folder_paths.get_annotated_filepath(filename)).resolve()
    if not path.is_relative_to(root) or not path.is_file():
        raise ValueError(f"Missing reference or file outside ComfyUI input: {filename}")
    return path.relative_to(root).as_posix()


class H3SceneConditioning:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "scene": ("H3_SCENE",), "clip": ("CLIP",), "vae": ("VAE",),
            "prompt": ("STRING", {"forceInput": True}),
            "width": ("INT", {"forceInput": True}), "height": ("INT", {"forceInput": True}),
            "length": ("INT", {"forceInput": True}),
            "clip_index": ("INT", {"forceInput": True}), "clip_count": ("INT", {"forceInput": True}),
        }, "optional": {"audio_vae": ("VAE",)}}

    RETURN_TYPES = ("CONDITIONING", "LATENT")
    RETURN_NAMES = ("positive", "latent")
    FUNCTION = "build"
    CATEGORY = "H3 Scene Batch"

    def build(self, scene, clip, vae, prompt, width, height, length, clip_index, clip_count, audio_vae=None):
        scene = read_scene(json.dumps(scene))
        graph = GraphBuilder()
        inputs = dict(clip=clip, vae=vae, prompt=prompt, width=width, height=height, length=length)
        counts = {"image": 0, "audio": 0, "video": 0}
        frames = set()
        for asset in active_assets(scene):
            role = asset.get("role", "reference")
            if role == "first" and clip_index != 1 or role == "last" and clip_index != clip_count:
                continue
            filename = input_file(asset.get("file"))
            kind = asset["kind"]
            if kind == "image":
                loaded = graph.node("LoadImage", image=filename)
                if role != "reference":
                    if role in frames:
                        raise ValueError(f"Choose only one {role} frame.")
                    frames.add(role)
                    inputs[f"{role}_frame"] = loaded.out(0)
                else:
                    inputs[f"ref_images.ref_image_{counts[kind]}"] = loaded.out(0)
            elif kind == "audio":
                loaded = graph.node("LoadAudio", audio=filename)
                inputs[f"ref_audios.ref_audio_{counts[kind]}"] = loaded.out(0)
            else:
                loaded = graph.node("VHS_LoadVideo", video=filename, force_rate=24,
                                    custom_width=0, custom_height=0, frame_load_cap=0,
                                    skip_first_frames=0, select_every_nth=1)
                inputs[f"ref_videos.ref_video_{counts[kind]}"] = loaded.out(0)
                if asset.get("use_audio", False):
                    inputs[f"ref_video_audios.ref_video_audio_{counts[kind]}"] = loaded.out(2)
            counts[kind] += 1
        if scene["mode"] == "R2V":
            inputs.update(audio_vae=audio_vae, ref_image_size=scene.get("ref_image_size", "match"))
            conditioning = graph.node("MiniMaxH3ReferenceToVideo", **inputs)
        else:
            conditioning = graph.node("MiniMaxH3ImageToVideo", **inputs)
        return {"result": (conditioning.out(0), conditioning.out(1)), "expand": graph.finalize()}


class H3SceneReferenceImages:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"scene_json": ("STRING", {"default": DEFAULT_SCENE})}}

    RETURN_TYPES = ("IMAGE",)
    OUTPUT_IS_LIST = (True,)
    FUNCTION = "load"
    CATEGORY = "H3 Scene Batch"

    @classmethod
    def IS_CHANGED(cls, scene_json):
        return [nodes.LoadImage.IS_CHANGED(input_file(a.get("file")))
                for a in active_assets(read_scene(scene_json)) if a["kind"] == "image"]

    def load(self, scene_json):
        images = [nodes.LoadImage().load_image(input_file(a.get("file")))[0]
                  for a in active_assets(read_scene(scene_json)) if a["kind"] == "image"]
        return (images,)

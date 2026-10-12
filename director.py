import json
import copy
import hashlib
from pathlib import Path
from uuid import uuid4

import folder_paths

from comfy_execution.graph_utils import GraphBuilder


DEFAULT_PLAN = json.dumps({
    "prompt_prefix": "A continuous camera move through a quiet garden. Natural ambient sound, no music.",
    "shots": [
        {"id": "cut01", "prompt": "The camera moves slowly along a stone path toward an open wooden gate.", "duration_seconds": 15},
        {"id": "cut02", "prompt": "Continue from the gate reached at the end of the previous cut. The camera passes through it and reveals a pond beyond.", "duration_seconds": 15},
    ],
}, ensure_ascii=False, indent=2)


def prepare_plan(plan_json, base_seed):
    plan = json.loads(plan_json)
    if not isinstance(plan, dict) or not isinstance(plan.get("shots"), list) or not plan["shots"]:
        raise ValueError("Use a Context-Loop Plan object with a non-empty shots array.")
    for index, shot in enumerate(plan["shots"], 1):
        if not isinstance(shot, dict):
            raise ValueError(f"Cut {index} must be an object.")
        # Existing Scene Batch uses the same base seed for every cut.
        if shot.get("seed") is None:
            shot["seed"] = base_seed
    return json.dumps(plan, ensure_ascii=False)


def reference_path(filename):
    path = Path(folder_paths.get_annotated_filepath(filename)).resolve()
    roots = [Path(folder_paths.get_input_directory()).resolve(), Path(folder_paths.get_output_directory()).resolve()]
    if not path.is_file() or not any(path.is_relative_to(root) for root in roots):
        raise ValueError(f"Missing reference or file outside ComfyUI input/output: {filename}")
    return path


def file_digest(path):
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def active_assets(scene):
    roles = {"R2V": {"reference"}, "T2V": set(), "I2V": {"first"}, "L2V": {"last"}, "FL2V": {"first", "last"}}
    return [a for a in scene["assets"] if a.get("enabled", True) and a.get("role", "reference") in roles[scene["mode"]]]


def generation_settings(prompt):
    return {key: {"class_type": node["class_type"], "inputs": {k: v for k, v in node["inputs"].items() if not isinstance(v, (list, dict))}}
            for key, node in (prompt or {}).items()
            if node["class_type"] not in ("H3SceneDirector", "H3SceneResult", "PreviewAny")}


TURBO_LORAS = {
    "R2V": "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",
    "FL2V": "minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors",
}
LORA_LOADERS = {"Power Lora Loader (rgthree)", "LoraLoader", "LoraLoaderModelOnly"}


def resolve_lora(name):
    normalized = str(name).replace("\\", "/")
    available = folder_paths.get_filename_list("loras")
    exact = [item for item in available if item.replace("\\", "/") == normalized]
    matches = exact or [item for item in available if item.replace("\\", "/").split("/")[-1] == normalized.split("/")[-1]]
    if len(matches) != 1:
        raise ValueError(f"LoRAが見つからないか、同名ファイルが複数あります: {name}")
    folder_paths.get_full_path_or_raise("loras", matches[0])
    return matches[0]


def additional_loras(prompt):
    return [{"id": key, "class_type": node["class_type"],
             "inputs": copy.deepcopy({k: v for k, v in node["inputs"].items() if k not in ("model", "clip")})}
            for key, node in (prompt or {}).items() if node["class_type"] in LORA_LOADERS]


class H3SceneTurboLora:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"model": ("MODEL",), "scene": ("H3_SCENE",)}}

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "load"
    CATEGORY = "H3 Scene Batch"

    DESCRIPTION = "Selects the scene's turbo LoRA: REF2V 4-step for R2V, FL2V 4-step for other modes, or the batch override."

    def load(self, model, scene):
        turbo = scene["execution"]["turbo"]
        if not turbo["lora_name"] or turbo["strength"] == 0:
            return (model,)
        graph = GraphBuilder()
        loader = graph.node("LoraLoaderModelOnly", model=model,
                            lora_name=resolve_lora(turbo["lora_name"]), strength_model=turbo["strength"])
        return {"result": (loader.out(0),), "expand": graph.finalize()}


def generation_signature(prompt, scene, prepared):
    graph = {key: {"class_type": value["class_type"], "inputs": value["inputs"]}
             for key, value in (prompt or {}).items() if value["class_type"] not in ("H3SceneDirector", "H3SceneResult", "PreviewAny")}
    files = []
    for node in graph.values():
        for field, category in (("unet_name", "diffusion_models"), ("lora_name", "loras"), ("clip_name", "text_encoders"), ("vae_name", "vae")):
            name = node["inputs"].get(field)
            if isinstance(name, str):
                path = folder_paths.get_full_path(category, name)
                if path and Path(path).is_file():
                    stat = Path(path).stat()
                    files.append((category, name, stat.st_size, stat.st_mtime_ns))
    payload = {"graph": graph, "files": files, "scene": scene, "plan": prepared}
    return hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


class H3SceneDirector:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "run_name": ("STRING", {"default": "auto", "tooltip": "auto creates a separate output folder for each scene generation."}),
            "plan_json": ("STRING", {"default": DEFAULT_PLAN, "multiline": True, "dynamicPrompts": False}),
            "width": ("INT", {"forceInput": True}),
            "height": ("INT", {"forceInput": True}),
            "steps": ("INT", {"forceInput": True}),
            "base_seed": ("INT", {"forceInput": True}),
        }, "optional": {
            "scene_json": ("STRING", {"default": '{"mode":"R2V","assets":[],"ref_image_size":"match"}', "multiline": True, "dynamicPrompts": False}),
            "use_current_settings": ("BOOLEAN", {"default": False}),
        }, "hidden": {"prompt": "PROMPT"}}

    RETURN_TYPES = ("H3_CHAIN_PLAN", "STRING", "H3_SCENE")
    RETURN_NAMES = ("plan", "summary", "scene")
    FUNCTION = "build"
    CATEGORY = "H3 Scene Batch"
    DESCRIPTION = "Edit references and cuts for one independent scene. Generate prompts directly into each cut, then render the scene."

    @classmethod
    def IS_CHANGED(cls, scene_json='{"mode":"R2V","assets":[]}', run_name="auto", **kwargs):
        if run_name == "auto":
            return float("nan")
        return [file_digest(reference_path(a["file"])) for a in active_assets(json.loads(scene_json)) if a.get("file")]

    def build(self, run_name, plan_json, width, height, steps, base_seed, scene_json='{"mode":"R2V","assets":[],"ref_image_size":"match"}', use_current_settings=False, prompt=None):
        run_name = "director_" + uuid4().hex[:16] if run_name == "auto" else run_name
        prepared = json.loads(prepare_plan(plan_json, base_seed))
        scene = json.loads(scene_json)
        batch_lora = scene.pop("batch_lora", None)
        turbo = None
        if any(n["class_type"] == "H3SceneTurboLora" for n in (prompt or {}).values()):
            turbo = copy.deepcopy(batch_lora) if batch_lora is not None else {
                "lora_name": TURBO_LORAS["R2V" if scene["mode"] == "R2V" else "FL2V"], "strength": 1.0}
            if turbo["lora_name"]:
                turbo["lora_name"] = resolve_lora(turbo["lora_name"])
            steps = int(turbo.pop("default_steps", steps))
            if "steps" in turbo:
                steps = int(turbo.pop("steps"))
                for shot in prepared["shots"]:
                    shot["steps"] = steps
        if use_current_settings:
            for shot in prepared["shots"]:
                if batch_lora is None or "steps" in batch_lora:
                    shot['steps'] = steps
                shot.pop('resolution', None)
        scene['assets'] = active_assets(scene)
        hashes = {str(i): file_digest(reference_path(a["file"])) for i, a in enumerate(scene.get("assets", [])) if a.get("file")}
        fingerprint = generation_signature(prompt, {**scene, "asset_hashes": hashes, "turbo": turbo}, prepared)
        snapshot = {**prepared, "shots": [{**shot, "seed": str(shot["seed"])} for shot in prepared["shots"]]}
        scene["execution"] = {"run_name": run_name, "plan": snapshot, "asset_hashes": hashes,
                              "generation_fingerprint": fingerprint, "settings": generation_settings(prompt),
                              "width": width, "height": height, "steps": steps}
        if turbo is not None:
            scene["execution"].update(turbo=turbo, additional_loras=additional_loras(prompt))
        graph = GraphBuilder()
        profile = graph.node("MiniMaxH3GenerationProfile",
                             scene_continuity="Hard picture + smooth audio", audio_profile="Generate audio")
        plan = graph.node("MiniMaxH3ChainPlanModern",
                          plan_json=json.dumps(prepared, ensure_ascii=False), chain_policy=profile.out(0),
                          run_name=run_name, generation_fingerprint=fingerprint, width=width, height=height,
                          encode_mode="video", crop="disabled", default_duration_seconds=15.0,
                          default_steps=steps, base_seed=base_seed, segment_crf=18, video_blend_frames=0)
        return {"result": (plan.out(0), plan.out(1), scene), "expand": graph.finalize()}

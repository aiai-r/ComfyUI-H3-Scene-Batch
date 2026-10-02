import json
import os
import shutil
from pathlib import Path

import torch
from safetensors.torch import load_file, save_file

import folder_paths
from comfy_api.latest import InputImpl

RUNS_DIR = "h3_scene_context/runs"
KEEP_RUNS = 3


def output_path(path):
    path = Path(path).expanduser()
    if not path.is_absolute():
        path = Path(folder_paths.get_output_directory()) / path
    return path.resolve()


def latent_streams(latent):
    samples = latent["samples"]
    parts = list(samples.unbind()) if hasattr(samples, "unbind") else list(samples)
    if len(parts) < 2:
        raise ValueError("Connect the H3 sampler output (video and audio latent).")
    return parts[0], parts[1]


def draft_dir(project_dir):
    if not project_dir.strip():
        raise ValueError("Set a project directory.")
    return Path(project_dir).expanduser().resolve() / "_draft"


def read_draft(project_dir):
    manifest = draft_dir(project_dir) / "draft.json"
    return json.loads(manifest.read_text(encoding="utf-8")) if manifest.exists() else {"cuts": []}


def write_draft(project_dir, draft):
    folder = draft_dir(project_dir)
    folder.mkdir(parents=True, exist_ok=True)
    temporary = folder / "draft.json.tmp"
    temporary.write_text(json.dumps(draft, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, folder / "draft.json")


def discard_draft(project_dir):
    shutil.rmtree(draft_dir(project_dir), ignore_errors=True)


def same_path(first, second):
    if not first or not second:
        return not first and not second
    return output_path(first) == output_path(second)


def adopt_cut(project_dir, run):
    draft = read_draft(project_dir)
    cuts = draft["cuts"]
    if any(cut["prompt_id"] == run["prompt_id"] for cut in cuts):
        raise ValueError("直前の結果は採用済みです。次のカットを生成してください。")
    if not run.get("context_save"):
        raise ValueError("直前の結果はカット対応のワークフローで生成されていません。")
    expected = str(draft_dir(project_dir) / cuts[-1]["context"]) if cuts else None
    if not same_path(run.get("context_load"), expected):
        raise ValueError(f"直前の結果はカット {len(cuts) + 1} として生成されていません。採用状況を確認してから生成し直してください。")
    name = f"cut{len(cuts) + 1:02d}"
    target = draft_dir(project_dir) / name
    shutil.rmtree(target, ignore_errors=True)
    shutil.copytree(output_path(run["context_save"]), target)
    cuts.append({
        "prompt_id": run["prompt_id"], "prompt": run["prompt"], "image_paths": run["image_paths"],
        "seed": run["seed"], "duration": run["duration"], "media": run["media"],
        "generation_mode": run.get("generation_mode", "R2V"),
        "generation_settings": run.get("generation_settings"), "context": name,
    })
    write_draft(project_dir, draft)
    return len(cuts)


class H3SceneCutContextSave:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "latent": ("LATENT",),
            "images": ("IMAGE",),
            "frames": ("INT", {"default": 39, "min": 1, "max": 9999}),
            "context_dir": ("STRING", {"default": ""}),
        }}

    RETURN_TYPES = ()
    FUNCTION = "save"
    OUTPUT_NODE = True
    CATEGORY = "MiniMax H3/Scene Batch"

    def save(self, latent, images, frames, context_dir):
        if not context_dir.strip():
            raise ValueError("context_dir is set when the H3 Scene Capture queues a cut.")
        folder = output_path(context_dir)
        folder.mkdir(parents=True, exist_ok=True)
        video, audio = latent_streams(latent)
        save_file({"video": video.cpu().contiguous(), "audio": audio.cpu().contiguous()}, str(folder / "latent.safetensors"))
        tail = (images[-frames:] * 255).round().clamp(0, 255).to(torch.uint8).cpu().contiguous()
        save_file({"frames": tail}, str(folder / "frames.safetensors"))
        runs = output_path(RUNS_DIR)
        if folder.parent == runs:
            for old in sorted(runs.iterdir(), key=lambda item: item.stat().st_mtime, reverse=True)[KEEP_RUNS:]:
                shutil.rmtree(old, ignore_errors=True)
        return {"ui": {"context_dir": [str(folder)]}, "result": ()}


class H3SceneCutContextLoad:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"context_dir": ("STRING", {"default": ""})}}

    RETURN_TYPES = ("IMAGE", "LATENT")
    RETURN_NAMES = ("context_frames", "context_latent")
    FUNCTION = "load"
    CATEGORY = "MiniMax H3/Scene Batch"

    @classmethod
    def IS_CHANGED(cls, context_dir):
        try:
            folder = output_path(context_dir)
            return [os.stat(folder / name).st_mtime_ns for name in ("latent.safetensors", "frames.safetensors")]
        except (OSError, ValueError):
            return float("nan")

    def load(self, context_dir):
        folder = output_path(context_dir)
        if not (folder / "latent.safetensors").is_file() or not (folder / "frames.safetensors").is_file():
            raise FileNotFoundError(f"Previous cut context is missing: {folder}")
        latent = load_file(str(folder / "latent.safetensors"))
        frames = load_file(str(folder / "frames.safetensors"))["frames"].float() / 255.0
        return (frames, {"samples": [latent["video"], latent["audio"]]})


class H3SceneJoinCuts:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "video": ("VIDEO",),
            "cut_prefix": ("STRING", {"default": ""}),
            "cut_count": ("INT", {"default": 2, "min": 2, "max": 999}),
            "cleanup_dir": ("STRING", {"default": ""}),
        }}

    RETURN_TYPES = ("VIDEO",)
    FUNCTION = "join"
    CATEGORY = "MiniMax H3/Scene Batch"

    def join(self, video, cut_prefix, cut_count, cleanup_dir):
        prefix = output_path(cut_prefix)
        parts = []
        for index in range(1, cut_count):
            files = sorted(prefix.parent.glob(f"{prefix.name}{index:02d}_?????_.*"), key=lambda item: item.stat().st_mtime)
            if not files:
                raise FileNotFoundError(f"Saved video of cut {index} is missing: {prefix}{index:02d}")
            parts.append(InputImpl.VideoFromFile(str(files[-1])))
        joined = InputImpl.VideoFromList(parts + [video])
        if cleanup_dir.strip():
            shutil.rmtree(output_path(cleanup_dir), ignore_errors=True)
        return (joined,)

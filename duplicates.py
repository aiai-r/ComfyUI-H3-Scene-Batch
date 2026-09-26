import hashlib
import json
from pathlib import Path

from .media import FILE_INPUTS, is_link


def scene_fingerprint(scene, root=None):
    def file_hash(filename):
        path = Path(filename)
        if root is not None:
            path = (root / path).resolve()
            if not path.is_relative_to(root):
                raise ValueError(f"Invalid saved reference: {filename}")
        with path.open("rb") as source:
            return hashlib.file_digest(source, "sha256").hexdigest()

    media = scene.get("media") or {}

    def reference(link):
        node = media["nodes"][link[0]]
        file_input = FILE_INPUTS.get(node["class_type"])
        inputs = {}
        for name, value in node["inputs"].items():
            if name == file_input:
                inputs[name] = file_hash(value)
            else:
                inputs[name] = reference(value) if is_link(value) else value
        return [node["class_type"], inputs, link[1]]

    content = {
        "prompt": scene["prompt"],
        "seed": scene["seed"],
        "duration": float(scene["duration"]),
        "images": [file_hash(path) for path in scene["images"]],
        "media": {name: reference(link) for name, link in media.get("outputs", {}).items()},
    }
    return hashlib.sha256(json.dumps(content, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()


def duplicate_scenes(project_dir, scene):
    fingerprint = scene_fingerprint({**scene, "images": scene["image_paths"]})
    project = Path(project_dir).expanduser().resolve()
    manifest = project / "scenes.json"
    scenes = json.loads(manifest.read_text(encoding="utf-8")) if manifest.exists() else []
    matches = []
    for saved in scenes:
        if any(saved[key] != scene[key] for key in ("prompt", "seed", "duration")):
            continue
        try:
            saved_fingerprint = scene_fingerprint(saved, project / "images")
        except FileNotFoundError:
            continue
        if saved_fingerprint == fingerprint:
            matches.append(saved["id"])
    return fingerprint, matches

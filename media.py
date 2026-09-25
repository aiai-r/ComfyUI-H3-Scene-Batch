import copy
import shutil
from pathlib import Path

import folder_paths
from comfy_execution.graph_utils import GraphBuilder, is_link


MEDIA_INPUTS = tuple(
    (f"{group}.{name}_{index}", kind)
    for group, name, kind in (
        ("ref_audios", "ref_audio", "AUDIO"),
        ("ref_videos", "ref_video", "IMAGE"),
        ("ref_video_audios", "ref_video_audio", "AUDIO"),
    )
    for index in range(3)
)
FILE_INPUTS = {
    "LoadAudio": "audio",
    "RecordAudio": "audio",
    "LoadVideo": "file",
    "VHS_LoadVideo": "video",
    "VHS_LoadVideoPath": "video",
    "VHS_LoadVideoFFmpeg": "video",
    "VHS_LoadVideoFFmpegPath": "video",
}
PROCESSORS = {"GetVideoComponents", "TrimAudioDuration"}


def capture_media(graph, references):
    outputs = {name: references[name] for name, _ in MEDIA_INPUTS if references.get(name) is not None}
    nodes = {}

    def visit(link):
        if not is_link(link):
            raise ValueError("Reference media must come from a connected loader.")
        node_id = link[0]
        if node_id in nodes:
            return
        node = copy.deepcopy(graph[node_id])
        kind = node["class_type"]
        if kind not in FILE_INPUTS and kind not in PROCESSORS:
            raise ValueError(f"Cannot save reference media through {kind}; use LoadAudio, LoadVideo/GetVideoComponents or VHS Load Video.")
        nodes[node_id] = {"class_type": kind, "inputs": node["inputs"]}
        file_input = FILE_INPUTS.get(kind)
        if file_input:
            filename = node["inputs"][file_input]
            if not isinstance(filename, str):
                raise ValueError(f"{kind}: use a literal file path when saving reference media.")
            path = Path(filename) if kind.endswith("Path") else Path(folder_paths.get_annotated_filepath(filename))
            if not path.is_file():
                raise FileNotFoundError(path)
            nodes[node_id]["inputs"][file_input] = str(path.resolve())
        for value in node["inputs"].values():
            if is_link(value):
                visit(value)

    for link in outputs.values():
        visit(link)
    return {"nodes": nodes, "outputs": outputs}


def copy_media(media, root, scene_id):
    saved = copy.deepcopy(media)
    for index, node in enumerate(saved["nodes"].values()):
        key = FILE_INPUTS.get(node["class_type"])
        if key is None:
            continue
        source = Path(node["inputs"][key])
        target = root / scene_id / "media" / str(index) / source.name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        node["inputs"][key] = target.relative_to(root).as_posix()
    return saved


def expand_media(media, root):
    builder = GraphBuilder()
    for node_id, node in media.get("nodes", {}).items():
        kind = node["class_type"]
        if kind not in FILE_INPUTS and kind not in PROCESSORS:
            raise ValueError(f"Unsupported saved media node: {kind}")
        inputs = copy.deepcopy(node["inputs"])
        key = FILE_INPUTS.get(kind)
        if key:
            path = (root / inputs[key]).resolve()
            if not path.is_relative_to(root) or not path.is_file():
                raise ValueError(f"Missing or invalid saved media: {inputs[key]}")
            if kind in ("LoadAudio", "RecordAudio"):
                kind, inputs = "H3SceneAudioPath", {"path": str(path)}
            elif kind == "LoadVideo":
                kind, inputs = "H3SceneVideoPath", {"path": str(path)}
            else:
                kind = kind if kind.endswith("Path") else kind + "Path"
                inputs[key] = str(path)
        for name, value in inputs.items():
            if is_link(value):
                inputs[name] = [builder.prefix + value[0], value[1]]
        builder.node(kind, id=node_id, **inputs)
    outputs = []
    for name, _ in MEDIA_INPUTS:
        link = media.get("outputs", {}).get(name)
        outputs.append([builder.prefix + link[0], link[1]] if link is not None else None)
    return builder.finalize(), outputs

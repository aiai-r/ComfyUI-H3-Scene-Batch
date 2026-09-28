MODES = ("R2V", "I2V", "L2V", "FL2V")

# Settings owned by the fixed workflow's generation branch.
SETTING_NODES = {
    "817:807": "UNETLoader", "817:808": "LoraLoaderModelOnly",
    "817:824": "LoraLoaderModelOnly", "817:812": "PrimitiveInt",
    "817:123": "KSamplerSelect", "817:124": "BasicScheduler",
    "817:809": "CLIPLoader", "817:810": "VAELoader", "817:811": "VAELoader",
    "817:820": "ResolutionSelector",
}


def capture_settings(graph):
    settings = {}
    for node_id, kind in SETTING_NODES.items():
        node = graph.get(node_id)
        if node is None or node["class_type"] != kind:
            continue
        settings[node_id] = {
            key: value for key, value in node["inputs"].items()
            if isinstance(value, (str, int, float, bool))
        }
    return settings


def scene_mode(node):
    if node["class_type"] != "MiniMaxH3ImageToVideo":
        return "R2V"
    inputs = node["inputs"]
    if inputs.get("first_frame") is not None:
        return "FL2V" if inputs.get("last_frame") is not None else "I2V"
    if inputs.get("last_frame") is not None:
        return "L2V"
    raise ValueError("I2V/L2V/FL2V requires a connected image.")

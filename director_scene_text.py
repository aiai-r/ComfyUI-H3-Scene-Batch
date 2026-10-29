import json
import re

# Same parsing as Scene Director's readScene (web/director_llm.js), usable as a workflow node.
CUT_MIN, CUT_MAX = 4, 15
SECTIONS = ["subject_definitions", "summary", "retention_analysis", "detailed_description",
            "overall_soundscape", "non_diegetic_music"]
HEADER = re.compile(
    r"(?:===|###|####|##|\*\*|\[)\s*(?:SCENE|シーン|Scene)\s*(\d+)([^=\n*\]]*)(?:===|\]|\*\*)?\s*"
    r"(?:```(?:text|markdown)?\s*\n([\s\S]*?)\n```"
    r"|(?=\n(?:===|###|####|##|\*\*|\[)\s*(?:SCENE|シーン|Scene)\s*\d+|\Z))", re.I)
BLOCK = re.compile(r"```(?:text|markdown)?\s*\n([\s\S]*?)\n```")
DECLARED = re.compile(r"duration\s*[:=]?\s*([0-9]+(?:\.[0-9]+)?)\s*(?:seconds|secs|sec|s|秒)", re.I)


def read_scene(text):
    content = text.strip()
    raw = []
    for m in HEADER.finditer(content):
        body = (m.group(3) or "").strip()
        if not body:
            block = BLOCK.search(m.group(0))
            body = (block.group(1) if block else "").strip()
        if body:
            declared = DECLARED.search(m.group(2) or "")
            raw.append((body, declared.group(1) if declared else None))
    if not raw:
        raw = [(b.strip(), None) for b in BLOCK.findall(content)
               if re.search(r"integrated_multimodal_description|\[Shot|overall_soundscape|subject_definitions", b)]
    if not raw:
        raise ValueError("LLMの返答からカットを読み取れませんでした。再作成してください。")
    problems, shots = [], []
    for index, (body, declared) in enumerate(raw, 1):
        seconds = CUT_MAX if declared is None else float(declared)
        if declared is None:
            problems.append(f"カット {index} の秒数が書かれていません（{CUT_MAX}秒として入れました）。")
        elif seconds < CUT_MIN or seconds > CUT_MAX:
            problems.append(f"カット {index} が{seconds:g}秒です（1カットは{CUT_MIN}〜{CUT_MAX}秒）。")
        prompt = re.sub(r"^(\s*)non-diegetic_music\s*:", r"\1non_diegetic_music:", body, count=1, flags=re.I | re.M)
        found = [name.lower() for name in re.findall(r"^\s*([a-z_]+)\s*:", prompt, flags=re.I | re.M)
                 if name.lower() in SECTIONS]
        if found != SECTIONS:
            problems.append(f"カット {index} のPromptに公式の6項目が順番どおり揃っていません。")
        shots.append({"id": f"cut{index}", "prompt": prompt, "duration_seconds": seconds})
    return shots, problems


class H3ScenePlanFromText:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"text": ("STRING", {"forceInput": True})}}

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("plan_json", "status")
    FUNCTION = "read"
    CATEGORY = "H3 Scene Batch"

    def read(self, text):
        shots, problems = read_scene(text)
        total = sum(s["duration_seconds"] for s in shots)
        status = "\n".join([f"{len(shots)}カット・合計{total:g}秒", *problems])
        print("[H3 Scene Plan From Text] " + status.replace("\n", " / "))
        return (json.dumps({"shots": shots}, ensure_ascii=False), status)

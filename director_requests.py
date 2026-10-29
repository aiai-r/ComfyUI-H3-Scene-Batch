import json
import os
import re
from pathlib import Path

# Same LLM requests as Scene Director's "ストーリー→Prompt→生成" (web/director_llm.js), for workflows
# without the Director dialog: the image analysis request and the whole-scene "all" request.
WEB = Path(__file__).parent / "web"
CUT_MIN, CUT_MAX = 4, 15
MEDIA_LIMITS = {"Picture": 9, "Audio": 3, "Video": 3}
MEDIA_ALIASES = {"a": "Audio", "audio": "Audio", "音声": "Audio", "v": "Video", "video": "Video", "動画": "Video",
                 "i": "Picture", "image": "Picture", "picture": "Picture", "画像": "Picture"}
FULL_WIDTH = str.maketrans("ＡａＩｉＶｖ０１２３４５６７８９", "AaIiVv0123456789")
REFERENCE_HANDLING_RULE = "The original images are not attached to this generation step. Use their saved visual analyses only. Audio and video contents are not analyzed; use those assets only as explicitly directed by the user."


def js_string(file, name):
    # Read `export const NAME = "...";` from the Director's web files.
    text = (WEB / file).read_text(encoding="utf-8")
    start = text.index(f"const {name} = ") + len(f"const {name} = ")
    return json.JSONDecoder().raw_decode(text, start)[0]


def js_lines(file, name):
    # Read `const NAME = ["...", "...", ].join("\n");` from the Director's web files.
    text = (WEB / file).read_text(encoding="utf-8")
    index = text.index("[", text.index(f"const {name} = ")) + 1
    end = text.index('].join("\\n")', index)
    decoder, lines = json.JSONDecoder(), []
    while True:
        while text[index] in " \r\n\t,":
            index += 1
        if index >= end:
            return "\n".join(lines)
        line, index = decoder.raw_decode(text, index)
        lines.append(line)


def js_json(value):
    # JSON.stringify: no spaces, non-ASCII kept.
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def seconds2(value):
    return f"{float(value):.2f}"


def media_tag(kind, number):
    if number < 1 or number > MEDIA_LIMITS[kind]:
        raise ValueError(f"{kind}参照は1～{MEDIA_LIMITS[kind]}で指定してください: {kind} {number}")
    return f"<{kind} {number}>"


def normalize_media_references(text):
    translated = text.translate(FULL_WIDTH)
    normalized = re.sub(r"(?<![<A-Za-z0-9_])(audio|音声|a|video|動画|v|image|picture|画像|i)\s*([0-9]+)(?![>A-Za-z0-9_])",
                        lambda m: media_tag(MEDIA_ALIASES[m.group(1).lower()], int(m.group(2))), translated, flags=re.I)
    normalized = re.sub(r"<(Picture|Audio|Video)\s+([0-9]+)>",
                        lambda m: media_tag(m.group(1)[0].upper() + m.group(1)[1:].lower(), int(m.group(2))),
                        normalized, flags=re.I)
    return normalized, {m.group(0) for m in re.finditer(r"<(Picture|Audio|Video) ([0-9]+)>", normalized)}


def media_manifest(found, images):
    pictures = [i["number"] for i in images]
    allowed = set(found) | {media_tag("Picture", n) for n in pictures}
    if not allowed:
        return "VALIDATED MEDIA REFERENCE INVENTORY: none. Do not introduce <Picture N>, <Audio N>, or <Video N> references."
    lines = ["VALIDATED MEDIA REFERENCE INVENTORY:",
             "Use these exact native MiniMax H3 labels. Preserve the user's stated purpose for each asset. Do not invent another media reference."]
    for kind in ("Picture", "Audio", "Video"):
        for number in range(1, MEDIA_LIMITS[kind] + 1):
            tag = f"<{kind} {number}>"
            if tag not in allowed:
                continue
            image = next((i for i in images if i["number"] == number), None) if kind == "Picture" else None
            labels = ", ".join(f"<Subject {n}>" for n in (image["subjects"] if image else []))
            if labels:
                text = f"attached as a reference asset; label it {labels} in the generated prompt. Its saved visual analysis is provided separately"
            elif kind == "Picture" and number in pictures:
                text = "its saved visual analysis is provided separately"
            else:
                text = "declared by the user; its contents were not inspected"
            lines.append(f"- {tag}: {text}")
    return "\n".join(lines)


def reference_definition(text, label):
    # referenceDefinitions() for one image.
    subjects = {}
    definition = re.sub(r"^subject_definitions\s*:\s*", "", text.strip(), flags=re.I)
    has_labels = re.search(r"<Subject\s+\d+>|<Picture(?:\s+\d+)?>", definition) is not None

    def subject(m):
        subjects.setdefault(m.group(1), len(subjects) + 1)
        return f"<Subject {subjects[m.group(1)]}>"
    definition = re.sub(r"<Subject\s+(\d+)>", subject, definition)
    definition = re.sub(r"<Picture(?:\s+\d+)?>", lambda m: label, definition)
    if has_labels:
        return definition
    return f"<Subject {len(subjects) + 1}> is the visible content referenced from {label}.\n{definition}"


SECTIONS = "subject_definitions:\n<Subject N> is ...\n<Audio N> is the voice-timbre reference for <Subject N> (Sx).\n\nsummary:\n...\n\nretention_analysis:\n<Subject N> (appears in [Shot 1]): fully_preserved - ...\n<Audio N>: reference - its voice timbre guides <Subject N> (Sx) without copying the original signal.\n\ndetailed_description:\n[Shot 1] ... <Subject N> (Sx) says, <d>[Language] ...</d>\n\noverall_soundscape:\n...\n\nnon_diegetic_music:\n..."


def image_line(i):
    role = ", ".join(f"<Subject {n}>" for n in i["subjects"]) + " Reference" if i["subjects"] else f"<Picture {i['number']}> Reference"
    return (f"- <Picture {i['number']}> ({i['filename']}): Assigned Role = {role}; User Note = {i['note'] or 'none'}; "
            f"Saved Visual Analysis = {js_json({'description': i['analysis']})}")


def scene_prompt(total_seconds, instruction, images):
    # scenePrompt(totalSeconds, instruction, "", images, "all", [])
    min_str, max_str, total_str = seconds2(CUT_MIN), seconds2(CUT_MAX), seconds2(total_seconds)
    min_clips = max(1, min(math_ceil(total_seconds / CUT_MAX), int(total_seconds // CUT_MIN)))
    text, found = normalize_media_references(instruction)
    user_instruction = f"{media_manifest(found, images)}\n\nUSER DIRECTION:\n{text.strip()}"
    images_context = "\n".join(image_line(i) for i in images) if images else "No reference images supplied."
    context = f'''You are a master film director and MiniMax-H3 prompt engineer creating a multi-clip sequence for **ComfyUI MiniMax-H3 Contex-Loop**.
Read the entire scene request below. Use the supplied story's clip allocation when present; otherwise decide how many clips the story needs and how long each clip must be.

=======================================================
PROJECT SPECIFICATIONS:
- Base Mode: R2V (Base Mode: R2V (Reference-to-Video). Maintain character/subject identities (<Subject 1>, etc.) consistently across all scenes.)
- Total Runtime: EXACTLY {total_str} seconds.
- Number of Clips: YOU decide it from the story, but use AT LEAST {min_clips} clips. Do not pad the story to reach a number, and do not cut the story short.
- Length of Each Clip: YOU decide it individually, between {min_str} and {max_str} seconds.
- Visual Style / Art Direction: Use the saved visual analyses when present, otherwise infer the most fitting cinematic style from the user story
- Pre-analyzed Reference Images:
{images_context}
{REFERENCE_HANDLING_RULE}

USER STORY CONCEPT / INSTRUCTION:
"""{user_instruction}"""'''
    allocation = f'''### Part 1: 全体ストーリー＆クリップ配分 (Japanese Breakdown)
- **ストーリー概要**: Overall narrative arc.
- **クリップ配分表** (one row per clip; the seconds column is the raw H3 generation length of that clip):
| クリップ | 秒数 | 累計 | クリップ内容・Shot構成 | 前クリップからの引き継ぎ・終了時の状況 | 音響・BGM |
|---|---|---|---|---|---|
| Clip 1 | 9秒 | 9秒 | ... | (末尾: 終了時の状況) | ... |
| Clip 2 | 13秒 | 22秒 | ... | (冒頭: 〜〜を継続 / 末尾: 〜〜で終了) | ... |
- **合計**: クリップ数と生の生成秒数合計。最後の累計が {total_str}秒 と一致し、どのクリップも {max_str}秒 以下であることを確認する。'''
    continued = SECTIONS.replace("[Shot 1] ...", "Describe the previous clip's ending situation, then advance the next action...\n[Shot 1] ...", 1)
    guide = js_string("h3_ref_guide.js", "H3_REF_GUIDE")
    return f'''{context}

USER-PROVIDED MINIMAX H3 GUIDE:
{guide}

=======================================================
CLIP PLANNING RULES (MANDATORY):
1. **Per-clip length**: every clip is a separate MiniMax-H3 generation, so each clip's length MUST be between {min_str} and {max_str} seconds.
2. **Exact total**: the sum of every declared clip length MUST equal exactly {total_str} seconds.
3. **Minimum clip count**: use AT LEAST {min_clips} clips. Fewer clips cannot reach {total_str} seconds while every clip stays at or under {max_str} seconds.
4. **No remainder dumping**: decide every clip length before writing any prompt, keeping a running total. If the seconds left for the last clip would exceed {max_str}, add one more clip instead of lengthening the last clip. Never make any clip longer than {max_str} seconds to reach the total.
5. **Group short events**: a short beat that does not deserve its own generation MUST become an extra [Shot] inside a neighbouring clip instead of a clip of its own.
6. **Each clip owns its own timeline**: every timestamp inside a clip's prompt MUST be within 0.000s and that clip's OWN length. Clip 2 and later restart at 0.000s. NEVER write cumulative timestamps that continue counting from a previous clip.
7. **Continuity**: begin every clip after the first with a brief concrete description of the previous clip's ending situation, then advance the next action from that state. Do not repeat completed actions or dialogue.
8. **Dialogue**: use distinct speaker IDs such as `(S1)` and `(S2)` for different vocal sources, and keep each source's ID stable across clips. Do not assign speaker IDs to characters who never vocalize. Preserve the supplied dialogue and requested language. Use `[Japanese]` only when Japanese is explicitly requested; do not default to Japanese or translate dialogue when no language is specified.
9. **Complete prompt in every clip**: each clip is generated alone, so EVERY clip prompt MUST contain all six full-reference sections in order (subject_definitions, summary, retention_analysis, detailed_description, overall_soundscape, non_diegetic_music). Define only the subjects and audio/video references actually used in that clip, preserving their declared roles. For voice references used in the clip, preserve the user's subject-to-audio mapping and keep each speaker's (Sx) stable across clips. Never shorten later clips to only detailed_description.

=======================================================
OUTPUT FORMAT:

{allocation}

### Part 2: 各クリップ個別プロンプト (ComfyUI Contex-Loop Prompts)

Output one block per clip under `### Part 2`, in order. The header of each block MUST carry that clip's own length exactly in this form:

=== SCENE 1 (duration: 9s) ===
```text
{SECTIONS}
```

=== SCENE 2 (duration: 13s) ===
```text
{continued}
```

Continue with `=== SCENE 3 (duration: Xs) ===` and so on until the story is finished.
'''


def math_ceil(value):
    import math
    return math.ceil(value)


class H3SceneAnalysisRequest:
    # Director's image analysis request for one R2V reference image.
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"instruction": ("STRING", {"forceInput": True})}}

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("system_prompt", "custom_prompt")
    FUNCTION = "build"
    CATEGORY = "H3 Scene Batch"

    def build(self, instruction):
        request = {"task": "Define the attached image for its intended reference use.", "instruction": instruction, "mode": "R2V",
                   "target_image": {"image_number": 1, "label": "<Picture 1>", "role": "reference", "note": ""}}
        return (js_lines("director_llm.js", "ANALYSIS_SYSTEM_PROMPT"), js_json(request))


class H3SceneWholeRequest:
    # Director's whole-scene request: story allocation and every cut prompt in one LLM answer.
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"total_seconds": ("FLOAT", {"forceInput": True}),
                             "instruction": ("STRING", {"forceInput": True}),
                             "image_path": ("STRING", {"forceInput": True}),
                             "analysis": ("STRING", {"forceInput": True})}}

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("custom_prompt",)
    FUNCTION = "build"
    CATEGORY = "H3 Scene Batch"

    def build(self, total_seconds, instruction, image_path, analysis):
        if not total_seconds > 0:
            raise ValueError("合計生成秒数は正の数を指定してください。")
        if not analysis.strip():
            raise ValueError("画像の参照定義が空です。再解析してください。")
        definition = reference_definition(analysis, "<Picture 1>").strip()
        subjects = list(dict.fromkeys(int(n) for n in re.findall(r"<Subject (\d+)>", definition)))
        images = [{"number": 1, "filename": os.path.basename(image_path.replace("\\", "/")), "note": "",
                   "analysis": definition, "subjects": subjects}]
        return (scene_prompt(total_seconds, instruction, images),)

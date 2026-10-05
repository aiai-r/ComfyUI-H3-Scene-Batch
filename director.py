import json

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
        shot.setdefault("seed", base_seed)
    return json.dumps(plan, ensure_ascii=False)


class H3SceneDirector:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "run_name": ("STRING", {"default": "h3_scene_director_trial", "tooltip": "Context-Loop output folder name. Use a different name for each independent scene."}),
            "plan_json": ("STRING", {"default": DEFAULT_PLAN, "multiline": True, "dynamicPrompts": False}),
            "width": ("INT", {"forceInput": True}),
            "height": ("INT", {"forceInput": True}),
            "steps": ("INT", {"forceInput": True}),
            "base_seed": ("INT", {"forceInput": True}),
        }, "optional": {
            "scene_json": ("STRING", {"default": '{"mode":"R2V","assets":[],"ref_image_size":"match"}', "multiline": True, "dynamicPrompts": False}),
        }}

    RETURN_TYPES = ("H3_CHAIN_PLAN", "STRING", "H3_SCENE")
    RETURN_NAMES = ("plan", "summary", "scene")
    FUNCTION = "build"
    CATEGORY = "H3 Scene Batch"
    DESCRIPTION = "Edit references and cuts for one independent scene. Draft prompts in the LLM dialog, then render from finalized prompts."

    def build(self, run_name, plan_json, width, height, steps, base_seed, scene_json='{"mode":"R2V","assets":[],"ref_image_size":"match"}'):
        graph = GraphBuilder()
        profile = graph.node("MiniMaxH3GenerationProfile",
                             scene_continuity="Hard picture + smooth audio", audio_profile="Generate audio")
        plan = graph.node("MiniMaxH3ChainPlanModern",
                          plan_json=prepare_plan(plan_json, base_seed), chain_policy=profile.out(0),
                          run_name=run_name, generation_fingerprint="", width=width, height=height,
                          encode_mode="video", crop="disabled", default_duration_seconds=15.0,
                          default_steps=steps, base_seed=base_seed, segment_crf=18, video_blend_frames=0)
        return {"result": (plan.out(0), plan.out(1), json.loads(scene_json)), "expand": graph.finalize()}

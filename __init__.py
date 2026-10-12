from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
from .director import H3SceneDirector, H3SceneTurboLora
from .director_media import H3SceneConditioning, H3SceneReferenceImages
from .director_project import H3SceneResult
from .director_output import H3SceneSegmentSave, H3SceneAssemble, H3SceneLoopEnd

NODE_CLASS_MAPPINGS["H3SceneDirector"] = H3SceneDirector
NODE_DISPLAY_NAME_MAPPINGS["H3SceneDirector"] = "H3 Scene Director"
NODE_CLASS_MAPPINGS["H3SceneTurboLora"] = H3SceneTurboLora
NODE_DISPLAY_NAME_MAPPINGS["H3SceneTurboLora"] = "H3 Scene Turbo LoRA"
NODE_CLASS_MAPPINGS.update(H3SceneConditioning=H3SceneConditioning, H3SceneReferenceImages=H3SceneReferenceImages)
NODE_DISPLAY_NAME_MAPPINGS.update(H3SceneConditioning="H3 Scene Conditioning", H3SceneReferenceImages="H3 Scene Reference Images")
NODE_CLASS_MAPPINGS["H3SceneResult"] = H3SceneResult
NODE_DISPLAY_NAME_MAPPINGS["H3SceneResult"] = "H3 Scene Result"
NODE_CLASS_MAPPINGS.update(H3SceneSegmentSave=H3SceneSegmentSave, H3SceneAssemble=H3SceneAssemble)
NODE_DISPLAY_NAME_MAPPINGS.update(H3SceneSegmentSave="H3 Scene Segment Save", H3SceneAssemble="H3 Scene Assemble")
NODE_CLASS_MAPPINGS['H3SceneLoopEnd'] = H3SceneLoopEnd
NODE_DISPLAY_NAME_MAPPINGS['H3SceneLoopEnd'] = 'H3 Scene Loop End'

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

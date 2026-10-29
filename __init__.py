from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
from .director import H3SceneDirector, H3SceneTurboLora
from .director_media import H3SceneConditioning, H3SceneReferenceImages
from .director_references import H3ScenePrepareReferences, H3SceneEncodeReferences
from .director_project import H3SceneResult
from .director_output import H3SceneSegmentSave, H3SceneAssemble, H3SceneLoopEnd, H3SceneVideoOnlySave

NODE_CLASS_MAPPINGS["H3SceneDirector"] = H3SceneDirector
NODE_DISPLAY_NAME_MAPPINGS["H3SceneDirector"] = "H3 Scene Director"
NODE_CLASS_MAPPINGS["H3SceneTurboLora"] = H3SceneTurboLora
NODE_DISPLAY_NAME_MAPPINGS["H3SceneTurboLora"] = "H3 Scene Turbo LoRA"
NODE_CLASS_MAPPINGS.update(H3SceneConditioning=H3SceneConditioning, H3SceneReferenceImages=H3SceneReferenceImages)
NODE_DISPLAY_NAME_MAPPINGS.update(H3SceneConditioning="H3 Scene Conditioning", H3SceneReferenceImages="H3 Scene Reference Images")
NODE_CLASS_MAPPINGS.update(H3ScenePrepareReferences=H3ScenePrepareReferences, H3SceneEncodeReferences=H3SceneEncodeReferences)
NODE_DISPLAY_NAME_MAPPINGS.update(H3ScenePrepareReferences="H3 Scene Prepare References", H3SceneEncodeReferences="H3 Scene Encode References")
NODE_CLASS_MAPPINGS["H3SceneResult"] = H3SceneResult
NODE_DISPLAY_NAME_MAPPINGS["H3SceneResult"] = "H3 Scene Result"
NODE_CLASS_MAPPINGS.update(H3SceneSegmentSave=H3SceneSegmentSave, H3SceneAssemble=H3SceneAssemble)
NODE_DISPLAY_NAME_MAPPINGS.update(H3SceneSegmentSave="H3 Scene Segment Save", H3SceneAssemble="H3 Scene Assemble")
NODE_CLASS_MAPPINGS['H3SceneLoopEnd'] = H3SceneLoopEnd
NODE_DISPLAY_NAME_MAPPINGS['H3SceneLoopEnd'] = 'H3 Scene Loop End'
NODE_CLASS_MAPPINGS['H3SceneVideoOnlySave'] = H3SceneVideoOnlySave
NODE_DISPLAY_NAME_MAPPINGS['H3SceneVideoOnlySave'] = 'H3 Scene Video Only Save'
from .i2v_scene import H3I2VScene, H3VideoPreview
NODE_CLASS_MAPPINGS['H3I2VScene'] = H3I2VScene
NODE_DISPLAY_NAME_MAPPINGS['H3I2VScene'] = 'H3 I2V Scene (LLM)'
NODE_CLASS_MAPPINGS['H3VideoPreview'] = H3VideoPreview
NODE_DISPLAY_NAME_MAPPINGS['H3VideoPreview'] = 'H3 Video Preview'

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

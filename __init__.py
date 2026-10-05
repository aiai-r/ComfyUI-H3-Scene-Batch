from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
from .director import H3SceneDirector
from .director_media import H3SceneConditioning, H3SceneReferenceImages

NODE_CLASS_MAPPINGS["H3SceneDirector"] = H3SceneDirector
NODE_DISPLAY_NAME_MAPPINGS["H3SceneDirector"] = "H3 Scene Director"
NODE_CLASS_MAPPINGS.update(H3SceneConditioning=H3SceneConditioning, H3SceneReferenceImages=H3SceneReferenceImages)
NODE_DISPLAY_NAME_MAPPINGS.update(H3SceneConditioning="H3 Scene Conditioning", H3SceneReferenceImages="H3 Scene Reference Images")

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

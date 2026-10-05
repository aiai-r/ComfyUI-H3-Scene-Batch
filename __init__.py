from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
from .director import H3SceneDirector

NODE_CLASS_MAPPINGS["H3SceneDirector"] = H3SceneDirector
NODE_DISPLAY_NAME_MAPPINGS["H3SceneDirector"] = "H3 Scene Director"

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

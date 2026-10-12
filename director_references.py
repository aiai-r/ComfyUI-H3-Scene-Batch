import math

from comfy_api.latest import io
from comfy_execution.graph_utils import GraphBuilder
from comfy_extras import nodes_minimax_h3 as h3

from .director import active_assets
from .director_media import input_file


class H3ScenePrepareReferences:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"scene": ("H3_SCENE",), "plan": ("H3_CHAIN_PLAN",), "vae": ("VAE",)},
                "optional": {"audio_vae": ("VAE",)}}

    RETURN_TYPES = ("H3_SCENE_REFERENCES",)
    FUNCTION = "prepare"
    CATEGORY = "H3 Scene Batch"

    def prepare(self, scene, plan, vae, audio_vae=None):
        if scene["mode"] != "R2V":
            return ({},)
        graph = GraphBuilder()
        inputs = dict(plan=plan, vae=vae, audio_vae=audio_vae,
                      ref_image_size=scene.get("ref_image_size", "match"))
        counts = {"image": 0, "audio": 0, "video": 0}
        for asset in active_assets(scene):
            kind = asset["kind"]
            filename = input_file(asset.get("file"))
            if kind == "image":
                loaded = graph.node("LoadImage", image=filename)
            elif kind == "audio":
                loaded = graph.node("LoadAudio", audio=filename)
            else:
                loaded = graph.node("VHS_LoadVideo", video=filename, force_rate=24,
                                    custom_width=0, custom_height=0, frame_load_cap=0,
                                    skip_first_frames=0, select_every_nth=1)
                if asset.get("use_audio", False):
                    inputs[f"ref_video_audios.ref_video_audio_{counts[kind]}"] = loaded.out(2)
            inputs[f"ref_{kind}s.ref_{kind}_{counts[kind]}"] = loaded.out(0)
            counts[kind] += 1
        encoded = graph.node("H3SceneEncodeReferences", **inputs)
        return {"result": (encoded.out(0),), "expand": graph.finalize()}


class H3SceneEncodeReferences(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="H3SceneEncodeReferences", display_name="H3 Scene Encode References",
            category="H3 Scene Batch",
            inputs=[io.Custom("H3_CHAIN_PLAN").Input("plan"), io.Vae.Input("vae"),
                    io.Vae.Input("audio_vae", optional=True),
                    io.Combo.Input("ref_image_size", options=["match", "max"], default="match"),
                    *[io.Autogrow.Input(name, optional=True, template=io.Autogrow.TemplatePrefix(
                        input=kind.Input(prefix), prefix=prefix + "_", min=0, max=100))
                      for name, prefix, kind in (("ref_images", "ref_image", io.Image),
                                                ("ref_videos", "ref_video", io.Image),
                                                ("ref_video_audios", "ref_video_audio", io.Audio),
                                                ("ref_audios", "ref_audio", io.Audio))]],
            outputs=[io.Custom("H3_SCENE_REFERENCES").Output()])

    @classmethod
    def execute(cls, plan, vae, ref_image_size="match", audio_vae=None,
                ref_images=None, ref_videos=None, ref_video_audios=None, ref_audios=None):
        # Only this preparation call owns the caches. Graph outputs share the finished references.
        pictures, videos, audio_blocks = {}, {}, []
        for audio in (ref_audios or {}).values():
            if audio is None:
                continue
            block = None
            if audio_vae is not None:
                z, ticks = h3._encode_ref_audio(audio_vae, audio)
                block = {"kind": "audio", "ref_audio_t": ticks, "audio_latent": z}
            audio_blocks.append(block)
        soundtracks = {}
        for name, audio in (ref_video_audios or {}).items():
            if audio is not None and audio_vae is not None:
                soundtracks[name] = h3._encode_ref_audio(audio_vae, audio)
        result = {}
        for shot in plan["shots"]:
            resolution = shot.get("resolution") or plan["compatibility"]
            width, height = resolution["width"], resolution["height"]
            frame_count = h3.temporal_shape(shot["raw_frames"])[0]
            key = (width, height, frame_count)
            if key in result:
                continue
            items, blocks = [], []
            for name, img in (ref_images or {}).items():
                if img is None:
                    continue
                h, w = img.shape[1:3]
                scale = min(1.0, math.sqrt(width * height / (w * h))) if ref_image_size == "match" else min(1.0, h3.REF_IMAGE_SHORT_EDGE / min(w, h))
                tw = max(32, round(w * scale / 32) * 32)
                th = max(32, round(h * scale / 32) * 32)
                picture_key = (name, tw, th)
                if picture_key not in pictures:
                    resized = h3._resize(img[:1], tw, th, "disabled")
                    pictures[picture_key] = ({"type": "image", "data": resized},
                        {"kind": "image", "latent_h": th // 16, "latent_w": tw // 16, "latent": vae.encode(resized)})
                item, block = pictures[picture_key]
                items.append(item)
                blocks.append(block)
            for name, video in (ref_videos or {}).items():
                if video is None:
                    continue
                n = min(video.shape[0], frame_count)
                if n < 5:
                    raise ValueError("MiniMax H3 reference videos need at least 5 frames (~0.2s at 24 fps)")
                n -= (n - 5) % 17
                video_key = (name, n)
                soundtrack_name = "ref_video_audio_" + name.rsplit("_", 1)[-1]
                if video_key not in videos:
                    vh, vw = video.shape[1:3]
                    cw, ch = h3.adapt_canvas(vw, vh)
                    if vw * vh < cw * ch:
                        cw, ch = max(32, round(vw / 32) * 32), max(32, round(vh / 32) * 32)
                    frames = h3._resize(video[:n], cw, ch, "disabled")
                    z = vae.encode(frames)
                    audio_latent, ticks = soundtracks.get(soundtrack_name, (None, 0))
                    indices = list(range(0, n, h3.FPS // 2))
                    videos[video_key] = ({"type": "video", "data": frames[indices],
                                          "timestamps": [i / 2.0 for i in range(len(indices))]},
                        {"kind": "video_audio" if ticks else "video", "latent_t": z.shape[2],
                         "latent_h": ch // 16, "latent_w": cw // 16, "ref_audio_t": ticks,
                         "latent": z, "audio_latent": audio_latent})
                if (ref_video_audios or {}).get(soundtrack_name) is not None:
                    items.append({"type": "audio"})
                item, block = videos[video_key]
                items.append(item)
                blocks.append(block)
            for block in audio_blocks:
                items.append({"type": "audio"})
                if block is not None:
                    blocks.append(block)
            result[key] = (items, blocks)
        return io.NodeOutput(result)

import hashlib
import json
import re
import shutil
import threading
from pathlib import Path

import folder_paths
from aiohttp import web
from server import PromptServer

# One folder per record name: records.json, previews/ (a copy of each generated
# video) and batches/ (exported batch folders: batch.json plus the media it needs).
_LOCK = threading.Lock()


def _record_dir(name):
    name = str(name or "").strip()
    if not name:
        raise ValueError("記録名を入力してください。")
    if len(name) > 100 or re.search(r'[<>:"/\\|?*\x00-\x1f]', name) or name.endswith(".") or name in (".", ".."):
        raise ValueError("記録名に使えない文字があります。")
    return Path(folder_paths.get_output_directory()) / "h3_dasiwa_records" / name


def _path(name):
    return _record_dir(name) / "records.json"


def _copy_preview(name, number, video):
    root = Path(folder_paths.get_directory_by_type(video.get("type") or "output")).resolve()
    source = (root / (video.get("subfolder") or "") / video["filename"]).resolve()
    if not source.is_relative_to(root) or not source.is_file():
        raise ValueError(f"生成した動画が見つかりません：{video['filename']}")
    # Same number as the list (#n), so the files sort in the order they were made.
    relative = f"previews/{name}_{number:04d}{source.suffix.lower()}"
    destination = _record_dir(name) / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)
    return relative


def _read(path):
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else []


def _write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=1), encoding="utf-8")
    temp.replace(path)


def _batch_folder(value, name):
    value = str(value or "").strip()
    if not value:
        raise ValueError("バッチ用フォルダの名前か絶対パスを入力してください。")
    if Path(value).is_absolute():
        return Path(value)
    if re.search(r'[<>:"/\\|?*\x00-\x1f]', value) or value in (".", ".."):
        raise ValueError("フォルダ名に使えない文字があります。")
    if not str(name or "").strip():
        raise ValueError("フォルダ名だけで指定するときは記録名を入力してください。絶対パスなら記録名は不要です。")
    return _record_dir(name) / "batches" / value


def _digest(path):
    hasher = hashlib.sha256()
    with open(path, "rb") as file:
        for chunk in iter(lambda: file.read(1 << 20), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def _input_file(name):
    root = Path(folder_paths.get_input_directory()).resolve()
    path = (root / name).resolve()
    if not path.is_relative_to(root) or not path.is_file():
        raise ValueError(f"素材が見つかりません：{name}")
    return path


def _copy_asset(name, folder):
    source = _input_file(name)
    relative = f"assets/{_digest(source)}{source.suffix.lower()}"
    destination = folder / relative
    if not destination.exists():
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
    return relative


def export_batch(records, ids, folder):
    if (folder / "batch.json").exists():
        raise ValueError(f"このフォルダには書き出し済みのバッチがあります。別の名前にしてください：{folder}")
    chosen = [r for r in records if r.get("id") in ids]
    if not chosen:
        raise ValueError("書き出す記録をチェックしてください。")
    number = {r["id"]: index + 1 for index, r in enumerate(records)}
    result = []
    for position, record in enumerate(chosen):
        record = json.loads(json.dumps(record))
        source = record["source"]
        if source["kind"] == "clip":
            origin = next((k for k, r in enumerate(chosen[:position]) if r.get("clip_id") == source["clip_id"]), None)
            if origin is None:
                previous = next((r for r in records if r.get("clip_id") == source["clip_id"]), None)
                raise ValueError(f"#{number[record['id']]} の続きの元が記録にありません。" if previous is None
                                 else f"#{number[record['id']]} の続きの元 #{number[previous['id']]} も書き出し対象に含めてください。")
            record["source"] = {"kind": "clip", "from": origin}
        timeline = json.loads(record["director"].get("timeline_data") or "{}")
        for item in timeline.get("items", []):
            if isinstance(item.get("value"), str) and item["value"]:
                item["value"] = _copy_asset(item["value"], folder)
        continuity = timeline.get("continuity") or {}
        if source["kind"] == "video":
            filename = (continuity.get("source_video") or {}).get("filename")
            if not filename:
                raise ValueError(f"#{number[record['id']]} の開始動画のファイル名が記録にありません。")
            continuity["source_video"] = {"filename": _copy_asset(filename, folder)}
            continuity["source_video_id"] = ""
        record["director"]["timeline_data"] = json.dumps(timeline, ensure_ascii=False)
        for key in ("clip_id", "video", "preview", "excluded"):
            record.pop(key, None)
        record["number"] = number[record["id"]]
        result.append(record)
    _write(folder / "batch.json", {"version": 1, "records": result})
    return {"folder": str(folder.resolve()), "count": len(result)}


def load_batch(folder):
    path = folder / "batch.json"
    if not path.is_file():
        raise ValueError(f"batch.jsonがありません：{folder}")
    data = json.loads(path.read_text(encoding="utf-8"))
    target = Path(folder_paths.get_input_directory()) / "h3_dasiwa_batch"
    missing = []

    def place(relative):
        if not isinstance(relative, str) or not re.fullmatch(r"assets/[0-9a-f]{64}\.[A-Za-z0-9]+", relative):
            raise ValueError(f"batch.jsonの素材パスが不正です：{relative}")
        source = folder / relative
        if not source.is_file():
            missing.append(relative)
            return relative
        destination = target / source.name
        if not destination.exists() or destination.stat().st_size != source.stat().st_size:
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
        return f"h3_dasiwa_batch/{source.name}"

    for record in data["records"]:
        timeline = json.loads(record["director"].get("timeline_data") or "{}")
        for item in timeline.get("items", []):
            if isinstance(item.get("value"), str) and item["value"]:
                item["value"] = place(item["value"])
        continuity = timeline.get("continuity") or {}
        if record["source"]["kind"] == "video":
            continuity["source_video"] = {"filename": place(continuity["source_video"]["filename"])}
        record["director"]["timeline_data"] = json.dumps(timeline, ensure_ascii=False)
    if missing:
        raise ValueError("素材がバッチ用フォルダにありません：" + "、".join(sorted(set(missing))))
    return data["records"]


def _session_dir(session):
    if not isinstance(session, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", session):
        raise ValueError("保存データのセッションIDが不正です。")
    return Path(folder_paths.get_output_directory()) / "df_h3_continuity" / session


def _clip_ready(session, clip):
    if not isinstance(clip, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", clip):
        return False
    path = _session_dir(session) / clip / "clip.json"
    try:
        return path.is_file() and json.loads(path.read_text(encoding="utf-8")).get("status") == "ready"
    except (OSError, ValueError):
        return False


def latest_clip(session):
    """The clip DaSiWa last finished in this session, read from disk (no websocket needed)."""
    path = _session_dir(session) / "latest.json"
    try:
        clip = json.loads(path.read_text(encoding="utf-8")).get("clip_id") if path.is_file() else None
    except (OSError, ValueError):
        return None
    return clip if _clip_ready(session, clip) else None


def records_action(data):
    action = data.get("action")
    if action == "load_batch":
        return load_batch(_batch_folder(data.get("folder"), data.get("list")))
    # Progress of a batch run, kept next to batch.json so a stopped run can resume.
    if action == "progress":
        path = _batch_folder(data.get("folder"), data.get("list")) / "progress.json"
        return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else None
    if action == "latest_clip":
        return latest_clip(data.get("session"))
    if action == "missing_clips":
        return [clip for clip in data.get("clips") or [] if not _clip_ready(data.get("session"), clip)]
    if action == "save_progress":
        folder = _batch_folder(data.get("folder"), data.get("list"))
        if not (folder / "batch.json").is_file():
            raise ValueError(f"batch.jsonがありません：{folder}")
        progress = data["progress"]
        _write(folder / "progress.json", {"session": str(progress["session"]), "made": [str(c) for c in progress["made"]]})
        return True
    path = _path(data.get("list"))
    with _LOCK:
        records = _read(path)
        if action == "list":
            return records
        if action == "export":
            return export_batch(records, set(data.get("ids") or []), _batch_folder(data.get("folder"), data.get("list")))
        if action == "add":
            records.append(data["record"])
        elif action == "update":
            record = next((r for r in records if r.get("id") == data.get("id")), None)
            if record is None:
                raise ValueError("記録が見つかりません。")
            patch = dict(data["patch"])
            if "video" in patch:
                patch["preview"] = _copy_preview(data["list"], records.index(record) + 1, patch.pop("video"))
            record.update(patch)
        else:
            raise ValueError("不明な操作です。")
        _write(path, records)
        return records


@PromptServer.instance.routes.post("/h3_dasiwa/records")
async def records_route(request):
    try:
        return web.json_response(records_action(await request.json()))
    except (ValueError, KeyError, TypeError, OSError) as error:
        return web.json_response({"error": str(error)}, status=400)


@PromptServer.instance.routes.get("/h3_dasiwa/preview")
async def preview_route(request):
    try:
        root = _record_dir(request.query.get("list")).resolve()
        path = (root / request.query.get("file", "")).resolve()
        if not path.is_relative_to(root / "previews") or not path.is_file():
            raise ValueError("プレビュー動画が見つかりません。")
        return web.FileResponse(path)
    except (ValueError, OSError) as error:
        return web.json_response({"error": str(error)}, status=404)

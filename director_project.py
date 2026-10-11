import asyncio
import copy
import hashlib
import json
import os
import re
import shutil
import threading
import time
from pathlib import Path
from uuid import uuid4

import av
import folder_paths
from aiohttp import web
from server import PromptServer

from .director import file_digest, reference_path


PROJECT_LOCK = threading.Lock()


def project_path(name):
    if isinstance(name, str) and Path(name).is_absolute():
        path = Path(name).resolve()
        if not path.is_dir() or not contained(path, 'scenes.json').is_file():
            raise ValueError("scenes.jsonがあるプロジェクトフォルダの絶対パスを指定してください。")
        records(path)
        return path
    if not isinstance(name, str) or not name.strip() or name != name.strip() or re.search(r'[<>:"/\\|?*\x00-\x1f]', name) or name.endswith('.') or name in ('.', '..'):
        raise ValueError("プロジェクト名、またはscenes.jsonがあるフォルダの絶対パスを指定してください。")
    output = Path(folder_paths.get_output_directory()).resolve()
    root = (output / "h3_scene_director").resolve()
    path = (root / name).resolve()
    if path.parent != root or not root.is_relative_to(output):
        raise ValueError("プロジェクトが保存先の外にあります。")
    return path


def contained(root, relative):
    path = (root / relative).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError("保存先の外のファイルは使用できません。")
    return path


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    if temporary.is_symlink():
        raise ValueError("保存用の一時ファイルがシンボリックリンクです。")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    temporary.replace(path)


def records(root):
    path = contained(root, 'scenes.json')
    result = json.loads(path.read_text(encoding='utf-8')) if path.exists() else []
    if not isinstance(result, list) or any(not isinstance(item, dict) or item.get('director_version') != 1 for item in result):
        raise ValueError("Director用ではないscenes.jsonです。別のプロジェクト名を指定してください。")
    return result


def project_media(root, relative):
    source = contained(root, relative)
    if not source.is_file():
        raise ValueError(f"プロジェクトの素材が見つかりません：{relative}")
    output = Path(folder_paths.get_output_directory()).resolve()
    if source.is_relative_to(output):
        return source
    identity = hashlib.sha256(str(root).encode()).hexdigest()[:20]
    cache = contained(output, f'h3_scene_director/_external/{identity}')
    destination = contained(cache, source.relative_to(root))
    stat = source.stat()
    if not destination.is_file() or (destination.stat().st_size, destination.stat().st_mtime_ns) != (stat.st_size, stat.st_mtime_ns):
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
    return destination


def project_preview(root, item):
    relative = item.get('preview')
    if not relative or not contained(root, relative).is_file():
        return None
    return video_view(contained(root, relative), str(root))


def video_view(path, project=None):
    root = project_path(project) if project is not None else Path(folder_paths.get_output_directory()).resolve()
    path = contained(root, path)
    if not path.is_file():
        raise ValueError("完成動画が見つかりません。")
    relative = path.relative_to(root)
    return {'filename': relative.name, 'subfolder': relative.parent.as_posix(), 'type': 'output',
            **({'project': project} if project is not None else {})}


def video_file(view):
    root = project_path(view['project']) if 'project' in view else Path(folder_paths.get_output_directory()).resolve()
    path = contained(root, view['subfolder'] + '/' + view['filename'])
    if path.suffix.lower() != '.mp4' or not path.is_file():
        raise ValueError('完成動画が見つかりません。')
    return path


class H3SceneResult:
    @classmethod
    def INPUT_TYPES(cls):
        return {'required': {'video_path': ('STRING', {'forceInput': True}), 'scene': ('H3_SCENE',),
                             'manifest_json': ('STRING', {'forceInput': True})}}

    RETURN_TYPES = ()
    OUTPUT_NODE = True
    FUNCTION = 'record'
    CATEGORY = 'H3 Scene Batch'

    def record(self, video_path, scene, manifest_json):
        scene = copy.deepcopy(scene)
        manifest = json.loads(manifest_json)
        execution = scene['execution']
        if manifest['run_name'] != execution['run_name'] or len(manifest['segments']) != len(execution['plan']['shots']):
            raise ValueError('生成結果のカットとDirectorの実行が一致しません。')
        fields = ('id', 'index', 'seed', 'steps', 'scene_prompt', 'prompt', 'raw_frames', 'delivered_frames',
                  'continuation_mode', 'context_length', 'audio_context_length', 'resolution')
        execution['cuts'] = [{key: str(segment[key]) if key == 'seed' else segment[key] for key in fields if key in segment}
                             for segment in manifest['segments']]
        execution['plan']['prompt_prefix'] = manifest['prompt_prefix']
        for shot, segment in zip(execution['plan']['shots'], manifest['segments']):
            shot.update(prompt=segment['scene_prompt'], seed=str(segment['seed']), length=segment['raw_frames'], steps=segment['steps'])
            for key in ('frames', 'prompt_seed_mode', 'prompt_seed'):
                shot.pop(key, None)
        view = video_view(video_path, scene.get('output', {}).get('project'))
        with av.open(video_path) as container:
            stream = container.streams.video[0]
            seconds = float(stream.duration * stream.time_base) if stream.duration is not None else None
            frame_count = stream.frames
        result = {'scene': scene, 'video': view, 'duration_seconds': seconds, 'frame_count': frame_count}
        return {'ui': {'h3_scene_result': [result]}, 'result': ()}


def successful_result(queue, prompt_id, node_id):
    entry = queue.get_history(prompt_id).get(prompt_id)
    if not entry or entry.get('status', {}).get('status_str') != 'success':
        raise ValueError("指定した実行は成功していません。成功結果を表示してから保存してください。")
    output = entry.get('outputs', {}).get(str(node_id), {}).get('h3_scene_result', [])
    if len(output) != 1 or 'execution' not in output[0].get('scene', {}):
        raise ValueError("この実行にDirectorの完成結果がありません。")
    return copy.deepcopy(output[0])


def adopt(root, queue, prompt_id, node_id, title):
    result = successful_result(queue, prompt_id, node_id)
    items = records(root)
    identity = hashlib.sha256(f'{prompt_id}:{node_id}'.encode()).hexdigest()[:20]
    if any(item['id'] == identity for item in items):
        return identity
    scene = result['scene']
    scene.pop('output', None)
    execution = scene.pop('execution')
    assets = []
    for index, asset in enumerate(scene['assets']):
        if not asset.get('file'):
            continue
        source = reference_path(asset['file'])
        if file_digest(source) != execution['asset_hashes'].get(str(index)):
            raise ValueError("生成後に参照素材が変更されています。生成時の素材へ戻してから保存してください。")
        relative = f'assets/{identity}/{index:03d}{source.suffix}'
        assets.append((source, contained(root, relative), asset, relative, execution['asset_hashes'][str(index)]))
    video = result['video']
    source_video = video_file(video)
    for source, destination, asset, relative, digest in assets:
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        if file_digest(destination) != digest:
            raise ValueError("コピー中に参照素材が変更されました。再生成してから保存してください。")
        asset['file'] = relative
    preview = f'previews/{identity}{source_video.suffix}'
    destination = contained(root, preview)
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source_video, destination)
    items.append({'director_version': 1, 'id': identity, 'title': str(title).strip() or f'シーン {len(items) + 1}',
                  'scene': scene, 'plan': execution['plan'], 'execution': execution,
                  'source': {'prompt_id': prompt_id, 'node_id': str(node_id)},
                  'preview': preview, 'duration_seconds': result['duration_seconds'], 'frame_count': result['frame_count']})
    write_json(contained(root, 'scenes.json'), items)
    return identity


def load_record(root, identity):
    item = next((item for item in records(root) if item['id'] == identity), None)
    if item is None:
        raise ValueError("保存シーンが見つかりません。")
    for asset in item['scene']['assets']:
        if asset.get('file'):
            path = project_media(root, asset['file'])
            asset['file'] = path.relative_to(Path(folder_paths.get_output_directory()).resolve()).as_posix() + ' [output]'
            reference_path(asset['file'])
    item['video'] = project_preview(root, item)
    return item


def refresh_batch(root, queue):
    path = contained(root, 'batch.json')
    if not path.exists():
        return None
    state = json.loads(path.read_text(encoding='utf-8'))
    for completed in state['completed']:
        if 'project' in completed.get('video', {}):
            completed['video']['project'] = str(root)
    attempt = state.get('attempt')
    if not attempt:
        return state
    prompt_id = attempt['prompt_id']
    entry = queue.get_history(prompt_id).get(prompt_id)
    running, pending = queue.get_current_queue()
    if entry:
        if entry.get('status', {}).get('status_str') == 'success':
            result = successful_result(queue, prompt_id, state['result_node'])
            if result['scene']['execution']['run_name'] != attempt['run_name']:
                raise ValueError("バッチ実行と生成結果が一致しません。")
            state['completed'].append({'id': state['ids'][len(state['completed'])], 'prompt_id': prompt_id,
                                       'video': result['video'], 'duration_seconds': result['duration_seconds']})
            state['attempt'] = None
            state['status'] = 'complete' if len(state['completed']) == len(state['ids']) else ('stopped' if state['status'] == 'stopping' else 'ready')
            state['error'] = ''
        else:
            state['status'] = 'error'
            state['error'] = '生成が失敗または中断されました。未完了シーンから再開できます。'
            state['attempt'] = None
    elif any(item[1] == prompt_id for item in running + pending):
        if state['status'] != 'stopping':
            state['status'] = 'running'
    elif state['status'] == 'stopping' or time.time() - attempt['created'] > 60:
        state['status'] = 'stopped' if state['status'] == 'stopping' else 'error'
        state['error'] = '実行履歴がありません。未完了シーンから再開してください。'
        state['attempt'] = None
    write_json(path, state)
    return state


def project_action(data, queue):
    root = project_path(data['project'])
    action = data.get('action', 'list')
    with PROJECT_LOCK:
        if action == 'open':
            if os.name != 'nt':
                raise ValueError("フォルダを開く機能はWindows上のComfyUIで利用できます。")
            if not root.is_dir():
                raise ValueError(f"保存先フォルダがありません。先にシーンを採用保存してください。保存先：{root}")
            os.startfile(str(root), 'explore')
            return {'directory': str(root)}
        if action == 'list':
            items = records(root)
            return {'scenes': [{'id': s['id'], 'title': s['title'], 'mode': s['scene']['mode'], 'cuts': len(s['plan']['shots']),
                                'duration_seconds': s['duration_seconds'], 'video': project_preview(root, s)} for s in items],
                    'batch': refresh_batch(root, queue), 'directory': str(root)}
        if action == 'load':
            return load_record(root, data['id'])
        if action == 'adopt':
            return {'id': adopt(root, queue, data['prompt_id'], data['node_id'], data.get('title', ''))}
        state = refresh_batch(root, queue)
        if action == 'status':
            return {'batch': state}
        if action in ('start', 'resume'):
            if state and state.get('attempt'):
                if action == 'start':
                    raise ValueError("実行中のバッチがあります。完了または中止を待ってください。")
                state['owner'] = data['owner']
                write_json(contained(root, 'batch.json'), state)
                return {'batch': state}
            if action == 'start':
                all_ids = [s['id'] for s in records(root)]
                if 'start_index' in data:
                    start = data['start_index']
                    if type(start) is not int or not 1 <= start <= len(all_ids):
                        raise ValueError(f"開始番号は1〜{len(all_ids)}で指定してください。")
                    ids = all_ids[start - 1:]
                else:
                    ids = list(dict.fromkeys(data['ids']))
                if not ids or not set(ids).issubset(all_ids):
                    raise ValueError("生成する保存シーンを選択してください。")
                ids = [identity for identity in all_ids if identity in ids]
                state = {'ids': ids, 'completed': [], 'result_node': str(data['result_node']), 'attempt': None,
                         'positions': [all_ids.index(identity) + 1 for identity in ids], 'total': len(all_ids),
                         'directory': 'batches/' + time.strftime('%Y%m%d_%H%M%S') + '_' + uuid4().hex[:8]}
            elif not state or len(state['completed']) == len(state['ids']):
                raise ValueError("再開する未完了シーンがありません。")
            state.update(status='ready', error='', owner=data['owner'])
        elif action == 'next':
            if not state or state['status'] != 'ready' or state['owner'] != data['owner']:
                raise ValueError("この画面から開始した待機中バッチではありません。")
            prompt_id = str(uuid4())
            state['attempt'] = {'prompt_id': prompt_id, 'run_name': 'director_' + uuid4().hex[:16], 'created': time.time()}
            state.setdefault('directory', 'batches/' + time.strftime('%Y%m%d_%H%M%S') + '_' + uuid4().hex[:8])
            position = state.get('positions', list(range(1, len(state['ids']) + 1)))[len(state['completed'])]
            state['attempt']['output'] = {'project': str(root),
                'directory': f"{state['directory']}/scene_{position:04d}_{state['attempt']['run_name'][9:]}"}
            state['status'] = 'submitting'
        elif action == 'stop':
            if state and state.get('attempt'):
                prompt_id = state['attempt']['prompt_id']
                queue.delete_queue_item(lambda item: item[1] == prompt_id)
                queue.interrupt_if_running(prompt_id)
                state['status'] = 'stopping'
            elif state:
                state['status'] = 'stopped'
        elif action == 'fail':
            if state and (state.get('attempt') or {}).get('prompt_id') == data['prompt_id']:
                state.update(status='error', error=str(data['error']), attempt=None)
        else:
            raise ValueError("不明な操作です。")
        if state:
            write_json(contained(root, 'batch.json'), state)
        return {'batch': state}


@PromptServer.instance.routes.post('/h3_scene_director/project')
async def project_request(request):
    try:
        data = await request.json()
        return web.json_response(await asyncio.to_thread(project_action, data, PromptServer.instance.prompt_queue))
    except (ValueError, KeyError, OSError) as error:
        return web.json_response({'error': str(error)}, status=400)


@PromptServer.instance.routes.get('/h3_scene_director/video')
async def project_video(request):
    try:
        path = await asyncio.to_thread(video_file, request.query)
        return web.FileResponse(path)
    except (ValueError, KeyError, OSError) as error:
        return web.json_response({'error': str(error)}, status=400)

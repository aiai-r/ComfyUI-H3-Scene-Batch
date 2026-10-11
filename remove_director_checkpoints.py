import argparse
import copy
import json
from pathlib import Path


def migrate(workflow):
    result = copy.deepcopy(workflow)
    if not any(n['type'] == 'H3SceneDirector' for n in result['nodes']):
        raise ValueError('H3 Scene Director workflowを指定してください。')
    for graph in [result, *result.get('definitions', {}).get('subgraphs', [])]:
        removed = set()
        for node in graph['nodes']:
            if node['type'] == 'MiniMaxH3ChainSegmentSave':
                node['type'] = 'H3SceneSegmentSave'
                keep = {'state', 'images', 'audio'}
                node['widgets_values'] = []
                node.pop('widgets_values_named', None)
            elif node['type'] == 'MiniMaxH3ChainAssemble':
                values = node.get('widgets_values_named') or dict(zip(
                    ['audio_source', 'filename', 'audio_bitrate', 'copy_to_output', 'output_subfolder', 'blend_schedule', 'boundary_tone_match', 'color_stabilization'], node['widgets_values']))
                for name, expected in {'audio_source': 'plan', 'copy_to_output': False, 'output_subfolder': '', 'blend_schedule': 'plan', 'boundary_tone_match': 'off', 'color_stabilization': 'off'}.items():
                    if values.get(name, expected) != expected:
                        raise ValueError(f'Assembleの{name}が標準設定と異なります。保存経路を個別に確認してください。')
                node['type'] = 'H3SceneAssemble'
                keep = {'manifest', 'filename', 'audio_bitrate'}
                node['widgets_values_named'] = {key: values[key] for key in ('filename', 'audio_bitrate')}
                node['widgets_values'] = list(node['widgets_values_named'].values())
            else:
                continue
            node.setdefault('properties', {})['Node name for S&R'] = node['type']
            old_inputs = node['inputs']
            node['inputs'] = [item for item in old_inputs if item['name'] in keep]
            for item in old_inputs:
                if item['name'] not in keep and item.get('link') is not None:
                    removed.add(item['link'])
            for slot, item in enumerate(node['inputs']):
                if item.get('link') is None:
                    continue
                link = next(l for l in graph['links'] if (l['id'] if isinstance(l, dict) else l[0]) == item['link'])
                if isinstance(link, dict):
                    link['target_slot'] = slot
                else:
                    link[4] = slot
        graph['links'] = [l for l in graph['links'] if (l['id'] if isinstance(l, dict) else l[0]) not in removed]
        for node in graph['nodes']:
            for output in node.get('outputs', []):
                if output.get('links'):
                    output['links'] = [link for link in output['links'] if link not in removed]
    return result


def connect_project_outputs(workflow):
    result = copy.deepcopy(workflow)
    graphs = [result, *result.get('definitions', {}).get('subgraphs', [])]
    link_id = max((l['id'] if isinstance(l, dict) else l[0] for graph in graphs for l in graph['links']), default=0)
    for graph in graphs:
        targets = [n for n in graph['nodes'] if n['type'] in ('H3SceneSegmentSave', 'H3SceneAssemble')]
        if not targets:
            continue
        director = next((n for n in graph['nodes'] if n['type'] == 'H3SceneDirector'), None)
        if director is not None:
            origin, output = director['id'], 2
            source_links = director['outputs'][output]['links']
        else:
            output = next(i for i, item in enumerate(graph['inputs']) if item['type'] == 'H3_SCENE')
            origin = -10
            source_links = graph['inputs'][output]['linkIds']
        for node in targets:
            if any(item['name'] == 'scene' and item.get('link') is not None for item in node['inputs']):
                continue
            slot = next((i for i, item in enumerate(node['inputs']) if item['name'] == 'scene'), len(node['inputs']))
            if slot == len(node['inputs']):
                node['inputs'].append({'name': 'scene', 'type': 'H3_SCENE', 'shape': 7, 'link': None})
            link_id += 1
            node['inputs'][slot]['link'] = link_id
            source_links.append(link_id)
            if graph is result:
                graph['links'].append([link_id, origin, output, node['id'], slot, 'H3_SCENE'])
                graph['last_link_id'] = max(graph.get('last_link_id', 0), link_id)
            else:
                graph['links'].append({'id': link_id, 'origin_id': origin, 'origin_slot': output,
                                       'target_id': node['id'], 'target_slot': slot, 'type': 'H3_SCENE'})
                graph['state']['lastLinkId'] = max(graph['state']['lastLinkId'], link_id)
    return result


def director_loop(workflow):
    result = copy.deepcopy(workflow)
    for graph in [result, *result.get('definitions', {}).get('subgraphs', [])]:
        for node in graph['nodes']:
            if node['type'] != 'MiniMaxH3ChainLoopEnd':
                continue
            values = node.get('widgets_values_named') or dict(zip(
                ('between_scene_cleanup', 'execution_mode'), node.get('widgets_values', [])))
            if values.get('between_scene_cleanup', 'off') != 'off' or values.get('execution_mode', 'recursive_legacy') != 'recursive_legacy':
                raise ValueError('Loop Endの設定がDirectorの標準設定と異なります。個別に確認してください。')
            unused = ('between_scene_cleanup', 'execution_mode')
            if any(i.get('link') is not None for i in node['inputs'] if i['name'] in unused):
                raise ValueError('Loop Endの実行設定が接続されています。個別に確認してください。')
            node['type'] = 'H3SceneLoopEnd'
            node['properties']['Node name for S&R'] = node['type']
            node['inputs'] = [i for i in node['inputs'] if i['name'] not in unused]
            node['widgets_values'] = []
            node.pop('widgets_values_named', None)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Replace Director checkpoint output nodes with MP4/WAV output nodes.')
    parser.add_argument('workflow', type=Path)
    parser.add_argument('--project-output', action='store_true', help='Connect the project destination to Director output nodes.')
    parser.add_argument('--director-loop', action='store_true', help='Remove Context Loop editorial and archive handling from Director.')
    args = parser.parse_args()
    original = args.workflow.read_bytes()
    updated = migrate(json.loads(original))
    if args.project_output:
        updated = connect_project_outputs(updated)
    if args.director_loop:
        updated = director_loop(updated)
    backup = args.workflow.with_suffix('.director-loop-backup.json' if args.director_loop else '.project-output-backup.json' if args.project_output else '.checkpoint-backup.json')
    if not backup.exists():
        backup.write_bytes(original)
    if args.workflow.read_bytes() != original:
        raise RuntimeError('Workflow changed during migration; no changes written.')
    args.workflow.write_text(json.dumps(updated, ensure_ascii=False) + '\n', encoding='utf-8')
    print(args.workflow)
    print('Backup:', backup)

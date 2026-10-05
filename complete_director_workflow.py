import argparse
import copy
import json
from pathlib import Path


def complete(workflow):
    result = copy.deepcopy(workflow)
    nodes = {n['id']: n for n in result['nodes']}
    director = nodes[1200]
    if director['type'] != 'H3SceneDirector' or 1210 not in nodes or 1211 in nodes:
        raise ValueError('Expected the stage 2 Director development workflow.')
    director['widgets_values'][0] = 'auto'
    director['widgets_values'].append(False)
    if 'widgets_values_named' in director:
        director['widgets_values_named'].update(run_name='auto', use_current_settings=False)
    director['size'] = [720, 1060]
    node = {'id': 1211, 'type': 'H3SceneResult', 'pos': [nodes[1207]['pos'][0], nodes[1207]['pos'][1] + 550],
            'size': [300, 110], 'flags': {}, 'order': len(nodes), 'mode': 0,
            'inputs': [{'name': 'video_path', 'type': 'STRING', 'link': None}, {'name': 'scene', 'type': 'H3_SCENE', 'link': None},
                       {'name': 'manifest_json', 'type': 'STRING', 'link': None}],
            'outputs': [], 'properties': {'Node name for S&R': 'H3SceneResult'}, 'widgets_values': []}
    result['nodes'].append(node)
    link_id = max(link[0] for link in result['links'])
    video_slot = next(i for i, o in enumerate(nodes[1207]['outputs']) if o['name'] == 'video_path')
    for slot, (origin, output) in enumerate([(1207, video_slot), (1200, 2), (1206, 1)]):
        link_id += 1
        result['links'].append([link_id, origin, output, 1211, slot, node['inputs'][slot]['type']])
        nodes[origin]['outputs'][output]['links'].append(link_id)
        node['inputs'][slot]['link'] = link_id
    result['last_node_id'] = max(1211, result.get('last_node_id', 0))
    result['last_link_id'] = link_id
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('workflow', type=Path)
    args = parser.parse_args()
    if args.workflow.name != 'video_minimax_h3_scene_director_dev.json':
        raise ValueError('Update only the named development workflow.')
    original = args.workflow.read_bytes()
    updated = complete(json.loads(original))
    backup = args.workflow.with_suffix('.stage2-backup.json')
    if backup.exists():
        raise ValueError('Stage 2 backup already exists; inspect before updating again.')
    backup.write_bytes(original)
    args.workflow.write_text(json.dumps(updated, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(args.workflow)

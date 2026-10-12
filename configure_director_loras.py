import argparse
import copy
import json
from pathlib import Path

from director import TURBO_LORAS


def configure(workflow):
    result = copy.deepcopy(workflow)
    if any(n['type'] == 'H3SceneTurboLora' for n in result['nodes']):
        return result
    director, = [n for n in result['nodes'] if n['type'] == 'H3SceneDirector']
    additional, = [n for n in result['nodes'] if n['type'] == 'Power Lora Loader (rgthree)']
    slot = next(i for i, item in enumerate(additional['inputs']) if item['name'] == 'model')
    incoming = next(link for link in result['links'] if link[0] == additional['inputs'][slot]['link'])
    node_id = max(result['last_node_id'], *(n['id'] for n in result['nodes'])) + 1
    link_id = max(result['last_link_id'], *(link[0] for link in result['links'])) + 1
    scene_slot = next(i for i, item in enumerate(director['outputs']) if item['type'] == 'H3_SCENE')
    node = {'id': node_id, 'type': 'H3SceneTurboLora', 'pos': [additional['pos'][0], additional['pos'][1] - 150],
            'size': [270, 80], 'flags': {}, 'order': len(result['nodes']), 'mode': 0,
            'inputs': [{'name': 'model', 'type': 'MODEL', 'link': incoming[0]},
                       {'name': 'scene', 'type': 'H3_SCENE', 'link': link_id}],
            'outputs': [{'name': 'MODEL', 'type': 'MODEL', 'links': [link_id + 1]}],
            'properties': {'Node name for S&R': 'H3SceneTurboLora'}, 'widgets_values': []}
    incoming[3:5] = [node_id, 0]
    result['links'].extend([[link_id, director['id'], scene_slot, node_id, 1, 'H3_SCENE'],
                            [link_id + 1, node_id, 0, additional['id'], slot, 'MODEL']])
    director['outputs'][scene_slot]['links'].append(link_id)
    additional['inputs'][slot]['link'] = link_id + 1
    additional['widgets_values'] = [value for value in additional['widgets_values']
        if not (isinstance(value, dict) and str(value.get('lora', '')).replace('\\', '/').split('/')[-1] in TURBO_LORAS.values())]
    result['nodes'].append(node)
    result['last_node_id'] = node_id
    result['last_link_id'] = link_id + 1
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Add mode-aware turbo LoRA to the Director development workflow.')
    parser.add_argument('workflow', type=Path)
    args = parser.parse_args()
    original = args.workflow.read_bytes()
    updated = configure(json.loads(original))
    backup = args.workflow.with_suffix('.turbo-backup.json')
    if not backup.exists():
        backup.write_bytes(original)
    if args.workflow.read_bytes() != original:
        raise RuntimeError('Workflow changed during migration; no changes written.')
    args.workflow.write_text(json.dumps(updated, ensure_ascii=False) + '\n', encoding='utf-8')
    print(args.workflow)
    print('Backup:', backup)

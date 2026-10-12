import argparse
import copy
import json
from pathlib import Path


def configure(workflow):
    result = copy.deepcopy(workflow)
    for graph in result.get('definitions', {}).get('subgraphs', []):
        targets = [n for n in graph['nodes'] if n['type'] == 'H3SceneConditioning']
        if not targets or any(n['type'] == 'H3ScenePrepareReferences' for n in graph['nodes']):
            continue
        conditioning, = targets
        start, = [n for n in graph['nodes'] if n['type'] == 'MiniMaxH3ChainLoopStart']
        node_id = max(result['last_node_id'], graph['state']['lastNodeId'], *(n['id'] for n in graph['nodes'])) + 1
        link_id = max(graph['state']['lastLinkId'], *(link['id'] for link in graph['links']))
        node = {'id': node_id, 'type': 'H3ScenePrepareReferences',
                'pos': [conditioning['pos'][0], conditioning['pos'][1] - 250],
                'size': [300, 130], 'flags': {}, 'order': len(graph['nodes']), 'mode': 0,
                'inputs': [], 'outputs': [{'name': 'H3_SCENE_REFERENCES', 'type': 'H3_SCENE_REFERENCES', 'links': []}],
                'properties': {'Node name for S&R': 'H3ScenePrepareReferences'}, 'widgets_values': []}
        for name in ('scene', 'plan', 'vae', 'audio_vae'):
            source = start if name == 'plan' else conditioning
            socket = next(item for item in source['inputs'] if item['name'] == name)
            link = next(item for item in graph['links'] if item['id'] == socket['link'])
            link_id += 1
            copied = {**link, 'id': link_id, 'target_id': node_id, 'target_slot': len(node['inputs'])}
            graph['links'].append(copied)
            node['inputs'].append({'name': name, 'type': link['type'], 'link': link_id})
            if link['origin_id'] == -10:
                graph['inputs'][link['origin_slot']]['linkIds'].append(link_id)
            else:
                origin = next(n for n in graph['nodes'] if n['id'] == link['origin_id'])
                origin['outputs'][link['origin_slot']]['links'].append(link_id)
        link_id += 1
        graph['links'].append({'id': link_id, 'origin_id': node_id, 'origin_slot': 0,
                               'target_id': conditioning['id'], 'target_slot': len(conditioning['inputs']),
                               'type': 'H3_SCENE_REFERENCES'})
        node['outputs'][0]['links'].append(link_id)
        conditioning['inputs'].append({'name': 'references', 'type': 'H3_SCENE_REFERENCES', 'shape': 7, 'link': link_id})
        graph['nodes'].append(node)
        graph['state'].update(lastNodeId=node_id, lastLinkId=link_id)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Prepare shared R2V references outside the Director cut loop.')
    parser.add_argument('workflow', type=Path)
    args = parser.parse_args()
    original = args.workflow.read_bytes()
    updated = configure(json.loads(original))
    backup = args.workflow.with_suffix('.references-backup.json')
    if not backup.exists():
        backup.write_bytes(original)
    if args.workflow.read_bytes() != original:
        raise RuntimeError('Workflow changed during migration; no changes written.')
    args.workflow.write_text(json.dumps(updated, ensure_ascii=False) + '\n', encoding='utf-8')
    print(args.workflow)
    print('Backup:', backup)

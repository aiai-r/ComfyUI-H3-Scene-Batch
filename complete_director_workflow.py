import argparse
import copy
import json
from pathlib import Path


REMOVED_INPUTS = {
    **{i: 'LoadImage' for i in range(600, 609)},
    **{i: 'ImageTensorList' for i in range(701, 709)},
    **{i: 'LoadAudio' for i in (802, 845)},
    **{i: 'H3SceneImagePath' for i in range(832, 841)},
    **{i: '5bb9f0b1-40c1-4f96-babf-d3abd87db0bd' for i in (822, 952, 953, 954)},
    **{i: 'PreviewAny' for i in (224, 805, 828, 962, 963, 964, 1208, 1209)},
    **{i: 'PrimitiveFloat' for i in (972, 973, 974)},
    136: 'MiniMaxH3ReferenceToVideo', 825: 'FolderBatch Load Image',
    826: 'FolderBatch Image Queue', 827: 'AILab_HuggingFaceDownloader', 831: 'H3SceneBatchLoad',
}


def clean_layout(workflow):
    result = copy.deepcopy(workflow)
    nodes = {n['id']: n for n in result['nodes']}
    if nodes[1200]['type'] != 'H3SceneDirector' or nodes[1211]['type'] != 'H3SceneResult':
        raise ValueError('Expected the completed Director development workflow.')
    config = nodes[1200]['properties']['h3_llm']
    if not all(key in config for key in ('loader', 'story', 'prompt')):
        raise ValueError('Migrate the LLM settings into Director before removing old nodes.')
    removed = set(nodes) & REMOVED_INPUTS.keys()
    for node_id in removed:
        if nodes[node_id]['type'] != REMOVED_INPUTS[node_id]:
            raise ValueError(f'Node {node_id} was replaced; inspect before cleanup.')
    if any(link[1] in removed and link[3] not in removed for link in result['links']):
        raise ValueError('A legacy input still feeds a retained node; inspect before cleanup.')
    result['nodes'] = [n for n in result['nodes'] if n['id'] not in removed]
    result['links'] = [link for link in result['links'] if link[1] not in removed and link[3] not in removed]
    links = {link[0] for link in result['links']}
    for node in result['nodes']:
        for output in node.get('outputs', []):
            if output.get('links') is not None:
                output['links'] = [link for link in output['links'] if link in links]
    result['groups'] = [group for group in result.get('groups', []) if group.get('id') not in range(1, 12)]
    if 'definitions' in result:
        result['definitions']['subgraphs'] = [g for g in result['definitions'].get('subgraphs', [])
                                                if g['id'] != '5bb9f0b1-40c1-4f96-babf-d3abd87db0bd']
    for node_id, position in {159: [3330, -500], 801: [4080, -500], 841: [3330, 260]}.items():
        nodes[node_id]['pos'] = position
    return result


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
    parser.add_argument('--clean-layout', action='store_true')
    args = parser.parse_args()
    if args.workflow.name != 'video_minimax_h3_scene_director_dev.json':
        raise ValueError('Update only the named development workflow.')
    original = args.workflow.read_bytes()
    updated = clean_layout(json.loads(original) if args.clean_layout else complete(json.loads(original)))
    backup = args.workflow.with_suffix('.pre-input-cleanup.json' if args.clean_layout else '.stage2-backup.json')
    if backup.exists():
        raise ValueError('Backup already exists; inspect before updating again.')
    backup.write_bytes(original)
    args.workflow.write_text(json.dumps(updated, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(args.workflow)

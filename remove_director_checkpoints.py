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


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Replace Director checkpoint output nodes with MP4/WAV output nodes.')
    parser.add_argument('workflow', type=Path)
    args = parser.parse_args()
    original = args.workflow.read_bytes()
    updated = migrate(json.loads(original))
    backup = args.workflow.with_suffix('.checkpoint-backup.json')
    if not backup.exists():
        backup.write_bytes(original)
    if args.workflow.read_bytes() != original:
        raise RuntimeError('Workflow changed during migration; no changes written.')
    args.workflow.write_text(json.dumps(updated, ensure_ascii=False) + '\n', encoding='utf-8')
    print(args.workflow)
    print('Backup:', backup)

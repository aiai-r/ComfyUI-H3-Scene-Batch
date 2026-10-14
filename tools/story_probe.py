"""Run Director story requests through the installed Llama-cpp node and record raw completion diagnostics."""
import importlib.util
import json
from pathlib import Path
import re
import sys
import time
import types


def inspect_story(text, count):
    ids = sorted({int(n) for n in re.findall(r'\bcut\s*(\d+)\b', text, re.I)})
    return {
        'found_ids': ids,
        'expected_ids': list(range(1, count + 1)),
        'all_ids_present': ids == list(range(1, count + 1)),
        'dialogue_present': [line in text for line in ('この箱を棚に置こう', 'はい、運びます')],
        'audio_labels_present': ['<Audio 1>' in text, '<Audio 2>' in text],
        'ending_present': 'ランプ' in text or 'lamp' in text.lower(),
    }


def main():
    source, destination = map(Path, sys.argv[1:3])
    data = json.loads(source.read_text(encoding='utf-8'))
    destination.mkdir(parents=True, exist_ok=True)
    comfy = Path(__file__).resolve().parents[3]
    sys.path.insert(0, str(comfy))
    package_path = comfy / 'custom_nodes' / 'ComfyUI-llama-cpp_vlm'
    package = types.ModuleType('story_probe_llama')
    package.__path__ = [str(package_path)]
    sys.modules[package.__name__] = package
    spec = importlib.util.spec_from_file_location(package.__name__ + '.nodes', package_path / 'nodes.py')
    nodes = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = nodes
    spec.loader.exec_module(nodes)
    storage = nodes.LLAMA_CPP_STORAGE
    loader = data['cases'][0]['graph']['model']['inputs']
    try:
        storage.load_model(loader)
        complete = storage.llm.create_chat_completion
        responses = []

        def record_completion(**kwargs):
            response = complete(**kwargs)
            responses.append(response)
            return response

        storage.llm.create_chat_completion = record_completion
        for case in data['cases']:
            target = destination / (case['name'] + '.json')
            if target.exists():
                continue
            print('START ' + case['name'], flush=True)
            graph = case['graph']
            inputs = dict(graph['writer']['inputs'])
            inputs['llama_model'] = loader
            inputs['parameters'] = graph['parameters']['inputs']
            # Retain loaded weights between tests; save_states remains false.
            inputs['force_offload'] = False
            inputs['unique_id'] = 'story_probe_' + case['name']
            responses.clear()
            started = time.monotonic()
            result = nodes.llama_cpp_instruct_adv().process(**inputs)
            response = responses[-1]
            record = {key: case[key] for key in ('name', 'count', 'max_tokens', 'seed')}
            record.update(seconds=round(time.monotonic() - started, 2),
                          finish_reason=response['choices'][0].get('finish_reason'),
                          usage=response.get('usage'), text=result[0], raw_response=response,
                          checks=inspect_story(result[0], case['count']))
            target.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding='utf-8')
            print('RESULT ' + json.dumps({key: value for key, value in record.items() if key not in ('text', 'raw_response')}, ensure_ascii=False), flush=True)
    finally:
        storage.clean(all=True)


if __name__ == '__main__':
    main()

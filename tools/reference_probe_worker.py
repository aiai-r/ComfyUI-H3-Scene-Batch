"""Local stdin worker for testing the installed writer without starting a server."""
import importlib.util
import json
from pathlib import Path
import sys
import time
import types

comfy = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(comfy))
package_path = comfy / 'custom_nodes' / 'ComfyUI-llama-cpp_vlm'
package = types.ModuleType('reference_probe_llama')
package.__path__ = [str(package_path)]
sys.modules[package.__name__] = package
spec = importlib.util.spec_from_file_location(package.__name__ + '.nodes', package_path / 'nodes.py')
nodes = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = nodes
spec.loader.exec_module(nodes)
storage = nodes.LLAMA_CPP_STORAGE
try:
    for request_line in sys.stdin:
        request = json.loads(request_line)
        graph = request['graph']
        loader = graph['model']['inputs']
        if storage.llm is None:
            storage.load_model(loader)
            original = storage.llm.create_chat_completion
            responses = []

            def completion(**kwargs):
                response = original(**kwargs)
                responses.append(response)
                return response

            storage.llm.create_chat_completion = completion
        inputs = dict(graph['writer']['inputs'])
        inputs.update(llama_model=loader, parameters=graph['parameters']['inputs'], force_offload=False,
                      unique_id=request['name'])
        responses.clear()
        started = time.monotonic()
        text = nodes.llama_cpp_instruct_adv().process(**inputs)[0]
        response = responses[-1]
        result = dict(request, text=text, raw_response=response, seconds=round(time.monotonic() - started, 2),
                      finish_reason=response['choices'][0].get('finish_reason'), usage=response.get('usage'))
        Path(request['output']).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        print('PROBE_RESULT ' + json.dumps({'text': text, 'usage': result['usage'], 'finish_reason': result['finish_reason']}), flush=True)
finally:
    storage.clean(all=True)

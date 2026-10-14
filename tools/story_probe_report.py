"""Summarize recorded runs; field checks are structural, not a substitute for reading the stories."""
import collections
import json
from pathlib import Path
import re
import sys


def audit(record):
    text = record['text']
    headings = list(re.finditer(r'(?im)^(?:[-*]\s+)?(?:#{1,6}\s*)?(?:\*\*)?(?:cut|カット)\s*(\d+)\b[^\n]*', text))
    cuts = {}
    for index, heading in enumerate(headings):
        end = headings[index + 1].start() if index + 1 < len(headings) else len(text)
        cuts[int(heading[1])] = text[heading.start():end]
    expected = set(range(1, record['count'] + 1))
    missing = sorted(expected - cuts.keys())
    unexpected = sorted(cuts.keys() - expected)
    fields = {}
    for index, block in cuts.items():
        fields[str(index)] = {
            'duration_15s': bool(re.search(r'15\s*(?:seconds|s\b|秒)|duration_seconds\**\s*:\**\s*15\b', block, re.I)),
            'start_state': bool(re.search(r'start(?:ing)?[ _]state|開始状態', block, re.I)),
            'end_state': bool(re.search(r'end(?:ing)?[ _]state|終了状態', block, re.I)),
        }
    if record['finish_reason'] == 'length':
        diagnosis = 'output_limit_reached'
    elif missing or unexpected:
        diagnosis = 'normal_stop_wrong_cut_count' if record['finish_reason'] == 'stop' else 'unknown_finish_wrong_cut_count'
    else:
        diagnosis = 'all_cut_headings_present'
    return {key: record[key] for key in ('name', 'count', 'max_tokens', 'seed', 'finish_reason', 'usage', 'seconds')} | {
        'diagnosis': diagnosis, 'missing_cuts': missing, 'unexpected_cuts': unexpected,
        'fields': fields, 'content_checks': record['checks'],
    }


def main():
    directory, output = map(Path, sys.argv[1:3])
    rows = [audit(json.loads(path.read_text(encoding='utf-8'))) for path in sorted(directory.glob('*.json'))]
    groups = collections.defaultdict(list)
    for row in rows:
        groups[(row['count'], row['max_tokens'])].append(row)
    summary = []
    for (count, budget), values in sorted(groups.items()):
        tokens = [v['usage']['completion_tokens'] for v in values]
        summary.append({'count': count, 'max_tokens': budget, 'runs': len(values),
                        'cut_count_ok': sum(not v['missing_cuts'] and not v['unexpected_cuts'] for v in values),
                        'complete_structure_ok': sum(v['diagnosis'] == 'all_cut_headings_present'
                                                     and all(all(fields.values()) for fields in v['fields'].values()) for v in values),
                        'limit_reached': sum(v['finish_reason'] == 'length' for v in values),
                        'output_tokens_min': min(tokens), 'output_tokens_max': max(tokens)})
    output.write_text(json.dumps({'summary': summary, 'runs': rows}, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()

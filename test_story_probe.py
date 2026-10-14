import unittest

from tools.story_probe_report import audit


class StoryProbeTests(unittest.TestCase):
    def record(self, text, finish_reason='stop'):
        return {'name': 'test', 'count': 4, 'max_tokens': 2048, 'seed': 1,
                'finish_reason': finish_reason, 'usage': {'completion_tokens': 20},
                'seconds': 1, 'text': text, 'checks': {}}

    def test_normal_stop_with_missing_cuts_is_not_a_token_limit(self):
        result = audit(self.record('**Cut 1**\nComplete first scene.\n**Cut 2**\nComplete second scene.'))
        self.assertEqual(result['diagnosis'], 'normal_stop_wrong_cut_count')
        self.assertEqual(result['missing_cuts'], [3, 4])

    def test_length_stop_is_reported_even_if_all_headings_exist(self):
        text = '\n'.join(f'**cut{i}**\nScene' for i in range(1, 5))
        self.assertEqual(audit(self.record(text, 'length'))['diagnosis'], 'output_limit_reached')

    def test_both_observed_field_formats_have_duration_and_boundary_states(self):
        for duration in ('**Duration:** 15 seconds', '**duration_seconds:** 15', '**duration_seconds**: 15'):
            text = '\n'.join(f'**cut{i}**\n{duration}\n**start_state:** Start\n**ending_state:** End' for i in range(1, 5))
            result = audit(self.record(text))
            self.assertEqual(result['diagnosis'], 'all_cut_headings_present')
            self.assertTrue(all(all(fields.values()) for fields in result['fields'].values()))


if __name__ == '__main__':
    unittest.main()

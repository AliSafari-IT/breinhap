"""Validate real workflow connection guards and release summaries without SSH/network."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).parents[2]


class WorkflowConnectionTests(unittest.TestCase):
    def run_step(self, workflow, overrides=None):
        text = (ROOT / '.github/workflows' / workflow).read_text()
        script = text.rsplit('        run: |\n', 1)[1]
        script = '\n'.join(line[10:] for line in script.splitlines())
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ['ssh', 'curl']:
                executable = root / name
                executable.write_text('#!/bin/bash\nprintf "%s\\n" "' + name + '" >> "$CALLS"\n')
                executable.chmod(0o755)
            env = dict(os.environ, PATH=f'{root}:{os.environ["PATH"]}', EVENT='workflow_dispatch', SHA='a'*40, HOST='server.example.test', SSH_USER='deploy', PORT='22', KEY='synthetic-key', KNOWN_HOSTS='synthetic-host-key', RUNNER_TEMP=directory, GITHUB_STEP_SUMMARY=str(root / 'summary'), CALLS=str(root / 'calls'))
            env.update(overrides or {})
            result = subprocess.run(['bash', '-c', script], env=env, capture_output=True, text=True)
            calls = (root / 'calls').read_text() if (root / 'calls').exists() else ''
            summary = (root / 'summary').read_text() if (root / 'summary').exists() else ''
            return result, calls, summary

    def test_bad_connection_settings_fail_before_ssh_without_exposing_values(self):
        for workflow in ['web-deploy.yml', 'management-deploy.yml']:
            for overrides, setting in [({'HOST': 'https://server.example.test'}, 'HOST'), ({'HOST': 'server.example.test\n'}, 'HOST'), ({'HOST': 'root@server.example.test'}, 'HOST'), ({'SSH_USER': 'root@server'}, 'SSH_USER'), ({'PORT': 'bad'}, 'PORT'), ({'PORT': '65536'}, 'PORT'), ({'PORT': '0'}, 'PORT')]:
                with self.subTest(workflow=workflow, overrides=overrides):
                    result, calls, _ = self.run_step(workflow, overrides)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(calls, '')
                    self.assertIn(setting, result.stdout)
                    self.assertNotIn('synthetic-key', result.stdout + result.stderr)

    def test_successful_summaries_link_to_visible_pages(self):
        for workflow, url in [('web-deploy.yml', 'https://breinhap.com/'), ('management-deploy.yml', 'https://management.breinhap.com/aanmelden')]:
            with self.subTest(workflow=workflow):
                result, calls, summary = self.run_step(workflow)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(calls, 'ssh\ncurl\n')
                self.assertIn(url, summary)
                self.assertIn('a' * 40, summary)


if __name__ == '__main__':
    unittest.main()

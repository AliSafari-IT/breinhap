"""Run the real image-plan shell with a fake registry and main ref."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

WORKFLOW = Path(__file__).parents[2] / '.github/workflows/management-image.yml'
SHA = 'a' * 40


class ImagePlanTest(unittest.TestCase):
    def run_plan(self, registry='exists', head=SHA, repair_fails=False):
        workflow = WORKFLOW.read_text()
        script = workflow.split('      - name: Plan the tags', 1)[1].split('        run: |\n', 1)[1].split('\n      # On a pull request', 1)[0]
        script = '\n'.join(line[10:] for line in script.splitlines())
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            docker = root / 'docker'
            docker.write_text('''#!/bin/bash
if [[ "$3" == inspect ]]; then
  case "$REGISTRY" in
    exists) echo manifest; exit 0;;
    missing) echo 'manifest unknown' >&2; exit 1;;
    error) echo 'unauthorized' >&2; exit 1;;
  esac
fi
printf '%s\\n' "$*" >> "$CALLS"
[[ "$REPAIR_FAILS" != 1 ]]
''')
            git = root / 'git'
            git.write_text('#!/bin/bash\nprintf "%s\\trefs/heads/main\\n" "$MAIN_HEAD"\n')
            for executable in [docker, git]:
                executable.chmod(0o755)
            env = dict(os.environ, PATH=f'{root}:{os.environ["PATH"]}', IMAGE='ghcr.io/test/management', SHA=SHA, GITHUB_REPOSITORY='test/management', GITHUB_OUTPUT=str(root / 'output'), REGISTRY=registry, MAIN_HEAD=head, CALLS=str(root / 'calls'), REPAIR_FAILS='1' if repair_fails else '0')
            result = subprocess.run(['bash', '-c', script], env=env, capture_output=True, text=True)
            output = (root / 'output').read_text() if (root / 'output').exists() else ''
            calls = (root / 'calls').read_text() if (root / 'calls').exists() else ''
            return result.returncode, output, calls

    def test_existing_current_image_repairs_only_convenience_tag(self):
        status, output, calls = self.run_plan()
        self.assertEqual(status, 0)
        self.assertEqual(output, 'publish=false\n')
        self.assertEqual(calls, f'buildx imagetools create --tag ghcr.io/test/management:management-main ghcr.io/test/management:management-{SHA}\n')

    def test_existing_old_or_unknown_head_does_not_move_convenience_tag(self):
        for head in ['b' * 40, '']:
            with self.subTest(head=head):
                status, output, calls = self.run_plan(head=head)
                self.assertEqual((status, output, calls), (0, 'publish=false\n', ''))

    def test_repair_failure_is_not_reported_as_success(self):
        status, output, _ = self.run_plan(repair_fails=True)
        self.assertNotEqual(status, 0)
        self.assertNotIn('publish=false', output)

    def test_missing_current_image_plans_both_tags(self):
        status, output, calls = self.run_plan(registry='missing')
        self.assertEqual(status, 0)
        self.assertIn('publish=true', output)
        self.assertIn('management-main', output)
        self.assertEqual(calls, '')

    def test_missing_old_image_never_moves_convenience_tag(self):
        status, output, _ = self.run_plan(registry='missing', head='b' * 40)
        self.assertEqual(status, 0)
        self.assertIn('publish=true', output)
        self.assertNotIn('management-main', output)

    def test_registry_auth_error_fails_closed(self):
        status, output, calls = self.run_plan(registry='error')
        self.assertNotEqual(status, 0)
        self.assertEqual((output, calls), ('', ''))


if __name__ == '__main__':
    unittest.main()

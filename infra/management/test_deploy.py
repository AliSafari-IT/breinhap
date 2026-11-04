"""Exercise the real deploy script with fake Git/Docker commands; never connect to a server."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parent
SHA = "a" * 40
DIGEST = "ghcr.io/alisafari-it/breinhap@sha256:" + "b" * 64
PREVIOUS = "ghcr.io/alisafari-it/breinhap@sha256:" + "c" * 64
STUB = r'''#!/usr/bin/env python3
import json, os, sys
name = os.path.basename(sys.argv[0]); args = sys.argv[1:]
with open(os.environ['CALLS'], 'a') as f:
    f.write(json.dumps([name, args, os.environ.get('BREINHAP_MANAGEMENT_IMAGE')]) + '\n')
case = os.environ['CASE']
if name == 'git':
    if args[0] == 'merge-base' and case == 'not-main': sys.exit(1)
elif name == 'docker':
    if args[0] == 'network' and case == 'no-network': sys.exit(1)
    if args[0] == 'pull' and case == 'pull-failure': sys.exit(1)
    if args[:2] == ['image', 'inspect']:
        if 'revision' in args[-1]: print('d'*40 if case == 'wrong-revision' else os.environ['SHA'])
        else: print('invalid' if case == 'wrong-digest' else os.environ['DIGEST'])
    elif args[:1] == ['inspect']: print(os.environ['PREVIOUS'])
    elif args[0] == 'compose':
        if 'ps' in args: print('' if case == 'first-failure' else 'existing-container')
        if 'up' in args and case in ['health-failure', 'first-failure'] and os.environ.get('BREINHAP_MANAGEMENT_IMAGE') != os.environ['PREVIOUS']: sys.exit(1)
'''


class DeployTests(unittest.TestCase):
    def execute(self, case, request=None):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / ".git").mkdir()
            (root / ".redis.management.conf").write_text("port 6379\n")
            (root / ".env.management").write_text("CORE_API_URL=http://core-api:4020\n")
            site = root / "infra/management"
            site.mkdir(parents=True)
            for name in ["deploy.sh", "compose.yml"]:
                shutil.copyfile(SOURCE / name, site / name)
            commands = root / "bin"
            commands.mkdir()
            for name in ["git", "docker"]:
                path = commands / name
                path.write_text(STUB)
                path.chmod(0o755)
            log = root / "calls"
            env = {**os.environ, "PATH": str(commands) + ":" + os.environ["PATH"], "CASE": case,
                   "SHA": SHA, "DIGEST": DIGEST, "PREVIOUS": PREVIOUS, "CALLS": str(log),
                   "SSH_ORIGINAL_COMMAND": request if request is not None else "deploy-management " + SHA}
            result = subprocess.run(["bash", str(site / "deploy.sh")], env=env, capture_output=True, text=True)
            calls = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
            return result.returncode, calls

    def test_rejects_invalid_ssh_commands_before_any_operation(self):
        for request in ["", "deploy-management abc", "deploy-management " + SHA + "; whoami", "deploy-management " + SHA + "\nwhoami"]:
            with self.subTest(request=request):
                code, calls = self.execute("success", request)
                self.assertEqual(code, 2)
                self.assertEqual(calls, [])

    def test_preflight_failures_never_restart_the_service(self):
        for case in ["not-main", "no-network", "pull-failure", "wrong-revision", "wrong-digest"]:
            with self.subTest(case=case):
                code, calls = self.execute(case)
                self.assertNotEqual(code, 0)
                self.assertFalse(any(name == "docker" and "up" in args for name, args, _ in calls))

    def test_success_is_pinned_by_digest_and_only_updates_its_own_project(self):
        code, calls = self.execute("success")
        self.assertEqual(code, 0)
        updates = [(args, image) for name, args, image in calls if name == "docker" and "up" in args]
        self.assertEqual(len(updates), 1)
        args, image = updates[0]
        self.assertEqual(image, DIGEST)
        self.assertEqual(args[args.index("-p") + 1], "breinhap-management")
        self.assertEqual(args[-1], "management")
        self.assertIn("--wait", args)

    def test_failed_health_restores_previous_image_and_fails(self):
        code, calls = self.execute("health-failure")
        self.assertNotEqual(code, 0)
        images = [image for name, args, image in calls if name == "docker" and "up" in args]
        self.assertEqual(images, [DIGEST, PREVIOUS])

    def test_failed_first_deploy_stops_the_unhealthy_service(self):
        code, calls = self.execute("first-failure")
        self.assertNotEqual(code, 0)
        self.assertTrue(any(name == "docker" and "stop" in args for name, args, _ in calls))


if __name__ == "__main__":
    unittest.main()

"""Smoke-test the real website image with the public Host behind an HTTP proxy."""
import http.client
import subprocess
import sys
import time
import uuid

name = 'breinhap-web-routes-' + uuid.uuid4().hex[:12]
try:
    subprocess.run(['docker', 'run', '--rm', '-d', '--name', name, '--read-only',
                    '--tmpfs', '/tmp:size=4m', '--cap-drop', 'ALL', '--security-opt',
                    'no-new-privileges:true', '--memory', '32m', '-p', '127.0.0.1::8080', sys.argv[1]],
                   check=True, stdout=subprocess.DEVNULL)
    endpoint = subprocess.check_output(['docker', 'port', name, '8080/tcp'], text=True).strip()
    assert endpoint.startswith('127.0.0.1:')
    port = int(endpoint.split(':')[1])
    def get(path):
        client = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
        try:
            client.request('GET', path, headers={'Host': 'breinhap.com'})
            response = client.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            client.close()
    for attempt in range(50):
        try:
            if get('/healthz')[0] == 200:
                break
        except (OSError, http.client.HTTPException):
            pass
        time.sleep(0.1)
    else:
        raise RuntimeError('Website did not become healthy')
    for language in ['', '/en']:
        for kind in ['login', 'register']:
            for slash in ['', '/']:
                route = f'{language}/{kind}{slash}'
                status, headers, body = get(route)
                assert status == 200, (route, status, headers.get('Location'))
                assert 'Location' not in headers, route
                assert b'https://management.breinhap.com/' in body, route
                assert 'Content-Security-Policy' in headers, route
    status, headers, _ = get('/en')
    assert status == 200 and 'Location' not in headers, headers
    assert get('/missing-route')[0] == 404
    print('Eight login/register routes serve 200; English home stays on-origin; 404 and CSP preserved')
finally:
    subprocess.run(['docker', 'rm', '-f', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

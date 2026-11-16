"""A real app server isolated from the user's project and render workspace."""
from contextlib import contextmanager
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import httpx


@contextmanager
def isolated_studio(include_workspace=False):
    root=Path(__file__).resolve().parent.parent
    with tempfile.TemporaryDirectory(prefix='animathema-qa-') as workspace:
        with socket.socket() as sock:
            sock.bind(('127.0.0.1',0))
            port=sock.getsockname()[1]
        url=f'http://127.0.0.1:{port}'
        process=subprocess.Popen([sys.executable,str(root/'main.py'),'--no-browser','--port',str(port),'--workspace',workspace],cwd=root,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        try:
            with httpx.Client() as client:
                for attempt in range(100):
                    if process.poll() is not None:
                        raise RuntimeError('Isolated test server stopped before startup.')
                    try:
                        if client.get(url+'/api/health',timeout=.5).status_code==200:
                            break
                    except httpx.TransportError:
                        pass
                    time.sleep(.1)
                else:
                    raise RuntimeError('Isolated test server did not start.')
            yield (url, Path(workspace)) if include_workspace else url
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()

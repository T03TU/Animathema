"""Launch Animathema: python main.py (or python main.py --no-browser --port 8000)."""
import argparse
import os
from pathlib import Path
import socket
import threading
import webbrowser


def main():
    parser = argparse.ArgumentParser(description='Animathema · local visual Manim studio')
    parser.add_argument('--port',type=int,default=8000)
    parser.add_argument('--no-browser',action='store_true')
    parser.add_argument('--workspace',type=Path,help='Optional project/media directory (default: workspace/)')
    args = parser.parse_args()
    if args.workspace:
        os.environ['ANIMATHEMA_WORKSPACE'] = str(args.workspace.resolve())
    try:
        import uvicorn
        from backend.app import app
    except ImportError as exc:
        raise SystemExit(f'Missing Python dependency: {exc.name}.\nActivate your virtual environment, then run: python -m pip install -r requirements.txt') from exc
    with socket.socket() as sock:
        try:
            sock.bind(('127.0.0.1',args.port))
        except OSError:
            raise SystemExit(f'Port {args.port} is already in use. Try: python main.py --port {args.port+1}')
    url = f'http://127.0.0.1:{args.port}'
    print(f'\n  Animathema · Mathematics in motion\n  {url}\n  Ctrl+C to stop\n',flush=True)
    if not args.no_browser:
        def open_when_ready():
            import time
            for _ in range(80):
                try:
                    with socket.create_connection(('127.0.0.1',args.port),timeout=.2):
                        webbrowser.open(url)
                        return
                except OSError:
                    time.sleep(.1)
        threading.Thread(target=open_when_ready,daemon=True).start()
    uvicorn.run(app,host='127.0.0.1',port=args.port,log_level='info')


if __name__=='__main__':
    main()

"""Async subprocess jobs with bounded logs, progress, cancellation and isolated output."""
import asyncio
import importlib.util
import os
from pathlib import Path
import re
import shutil
import signal
import sys
import time
import uuid
from datetime import datetime, timezone

WORKSPACE = Path(os.environ.get('ANIMATHEMA_WORKSPACE', str(Path(__file__).resolve().parent.parent / 'workspace'))).resolve()
WORKSPACE.mkdir(parents=True, exist_ok=True)


def diagnostics():
    available = {'manim': importlib.util.find_spec('manim') is not None,
                 **{n: shutil.which(n) is not None for n in ('ffmpeg','ffprobe','latex','dvisvgm')}}
    hints = {
        'manim':'Activate your virtual environment and run: python -m pip install -r requirements.txt. Manim also needs Cairo and Pango; see the installation guide in README.md.',
        'ffmpeg':'Install FFmpeg (including ffprobe), add its bin directory to PATH, then restart Animathema.',
        'ffprobe':'Install the full FFmpeg package, including ffprobe, and add it to PATH.',
        'latex':'MathTex and Matrix need a TeX distribution. Install TeX Live or MiKTeX and add latex to PATH. Text and the demo work without TeX.',
        'dvisvgm':'Install dvisvgm with your TeX distribution and add it to PATH to convert equations to SVG.',
    }
    return {'dependencies':[{'name':n,'available':v,'hint':hints[n]} for n,v in available.items()], 'python':sys.version.split()[0]}


class Jobs:
    def __init__(self):
        self.jobs = {}
        self.tasks = set()
        self.slots = asyncio.Semaphore(1)

    def create(self, kind, runner):
        # Finished results are retained for the active session, with bounded memory.
        for key in list(self.jobs):
            if len(self.jobs) < 80:
                break
            if self.jobs[key]['status'] in ('completed','failed','cancelled'):
                del self.jobs[key]
        if len(self.jobs) >= 80:
            raise ValueError('Too many active jobs. Cancel a queued job before starting another.')
        job = {'id':uuid.uuid4().hex, 'kind':kind, 'status':'queued', 'progress':0, 'logs':[], 'result':None, 'error':None, 'created':time.time(), '_process':None}
        self.jobs[job['id']] = job
        task = asyncio.create_task(self._run(job, runner))
        job['_task'] = task
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        return self.public(job)

    def public(self, job):
        return {k:v for k,v in job.items() if not k.startswith('_')}

    def log(self, job, line):
        line = re.sub(r'\x1b\[[0-9;]*[a-zA-Z]', '', line).strip()
        if line:
            job['logs'] = (job['logs'] + [line])[-500:]

    async def _run(self, job, runner):
        try:
            async with self.slots:
                if job['status']=='cancelled':
                    return
                job['status']='running'
                job['result'] = await runner(job)
                job['status']='completed'
                job['progress']=100
        except asyncio.CancelledError:
            job['status']='cancelled'
            self.log(job,'Job cancelled.')
        except Exception as e:
            job['status']='failed'
            job['error']=str(e)
            self.log(job,str(e))
        finally:
            process = job.get('_process')
            if process and process.returncode is None:
                await self.stop_process(process)
            job['_process']=None

    async def stop_process(self, process):
        if process.returncode is not None:
            return
        try:
            if os.name=='posix':
                os.killpg(process.pid,signal.SIGTERM)
            else:
                process.terminate()
        except ProcessLookupError:
            return
        try:
            await asyncio.wait_for(process.wait(),5)
        except asyncio.TimeoutError:
            if os.name=='posix':
                os.killpg(process.pid,signal.SIGKILL)
            else:
                process.kill()
            await process.wait()

    async def cancel(self, job):
        if job['status'] in ('queued','running'):
            job['status']='cancelled'
            job['_task'].cancel()
            await asyncio.gather(job['_task'],return_exceptions=True)

    async def close(self):
        await asyncio.gather(*(self.cancel(j) for j in list(self.jobs.values())),return_exceptions=True)

    async def command(self, job, args, *, duration=None, cwd=None):
        self.log(job, 'Running: ' + ' '.join(str(a) for a in args))
        process = await asyncio.create_subprocess_exec(*map(str,args), cwd=cwd,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
            start_new_session=os.name=='posix', limit=1024*1024)
        job['_process']=process
        buffer = ''
        while chunk := await process.stdout.read(4096):
            buffer += chunk.decode('utf-8',errors='replace')
            parts = re.split(r'[\r\n]',buffer)
            buffer = parts.pop()
            for line in parts:
                self.log(job,line)
                if duration and line.startswith('out_time_us='):
                    try:
                        job['progress']=min(98,100*int(line.split('=')[1])/1e6/duration)
                    except ValueError:
                        pass
                elif match := re.search(r'(\d+)%',line):
                    job['progress']=min(95,int(match[1]))
        self.log(job,buffer)
        result = await process.wait()
        job['_process']=None
        if result:
            raise RuntimeError(f'Process exited with code {result}. ' + '\n'.join(job['logs'][-12:]))


jobs = Jobs()


async def render(job, project, quality, code, *, scene_name='AnimathemaScene', custom=False):
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S_%fZ') if custom else None
    folder = (WORKSPACE / 'custom_renders' / f'{stamp}_{job["id"]}'
              if custom else WORKSPACE / 'renders' / job['id'])
    folder.mkdir(parents=True)
    script = folder / (f'scene_{stamp}.py' if custom else 'scene.py')
    script.write_text(code,encoding='utf-8')
    await jobs.command(job,[sys.executable,'-m','manim','render','-ql' if quality=='draft' else '-qh',
        '--media_dir',folder/'media','--format','mp4','--disable_caching','--progress_bar','display',script,scene_name],cwd=folder)
    outputs = [p for p in (folder/'media'/'videos').rglob('*.mp4') if 'partial_movie_files' not in p.parts]
    if not outputs:
        raise RuntimeError(f'Manim finished without producing a video. Edited code must render {scene_name}.')
    path = max(outputs,key=lambda p:p.stat().st_mtime)
    from .video_editor import probe
    info = await probe(path)
    source = path.relative_to(WORKSPACE).as_posix()
    result = {'source':source,'url':'/media/'+source,'name':project.name,
              'render_key':f'code:{scene_name}' if custom else 'visual',**info}
    if custom:
        result.update(scene_name=scene_name, script=script.relative_to(WORKSPACE).as_posix())
    return result

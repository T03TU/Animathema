"""Local API and durable project storage; no frontend build or remote services."""
from contextlib import asynccontextmanager
import importlib.util
import json
import os
from pathlib import Path
import shutil
from urllib.parse import urlparse
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware
from .models import Project, RenderRequest, ExportRequest, SplitRequest, CodeSourceRequest, CodeRenderRequest
from .code_editor import analyze_manim_code, select_scene, syntax_diagnostic
from .presets import catalog, demo
from .scene_compiler import compile_scene
from .render_engine import WORKSPACE, jobs, diagnostics, render
from .video_editor import split, export_video, media_path, probe

ROOT = Path(__file__).resolve().parent.parent
PROJECT_FILE = WORKSPACE/'project.json'


@asynccontextmanager
async def lifespan(app):
    yield
    await jobs.close()


app = FastAPI(title='Animathema',version='1.0.0',lifespan=lifespan)
app.add_middleware(TrustedHostMiddleware,allowed_hosts=['127.0.0.1','localhost','[::1]','testserver'])


@app.middleware('http')
async def local_origin(request: Request, call_next):
    # Browser pages from other origins cannot trigger local Python execution.
    if request.method not in ('GET','HEAD','OPTIONS'):
        origin = request.headers.get('origin')
        if origin and origin != f'{request.url.scheme}://{request.headers.get("host")}':
            return JSONResponse({'detail':'Only the local Animathema interface may modify this workspace.'},status_code=403)
        if request.headers.get('sec-fetch-site')=='cross-site':
            return JSONResponse({'detail':'Cross-site requests are disabled.'},status_code=403)
    return await call_next(request)


@app.exception_handler(ValueError)
async def invalid(request, exc):
    return JSONResponse({'detail':str(exc)},status_code=400)


@app.exception_handler(SyntaxError)
async def syntax(request, exc):
    return JSONResponse({'detail':f'Python syntax error on line {exc.lineno}: {exc.msg}'},status_code=400)


@app.get('/api/health')
def health():
    return diagnostics()


@app.get('/api/presets')
def presets():
    return catalog()


@app.get('/api/project')
def get_project():
    if PROJECT_FILE.exists():
        try:
            return Project.model_validate_json(PROJECT_FILE.read_text(encoding='utf-8'))
        except (ValueError,OSError) as e:
            raise HTTPException(409,'The saved project could not be loaded. Download workspace/project.json before replacing it. '+str(e))
    return demo()


@app.put('/api/project')
async def save_project(project: Project):
    # Validate code generation before saving, while preserving deliberate timing edits.
    for obj in project.objects:
        from .scene_compiler import constructor
        constructor(obj)
    temp = PROJECT_FILE.with_suffix('.tmp')
    temp.write_text(project.model_dump_json(indent=2),encoding='utf-8')
    os.replace(temp,PROJECT_FILE)
    return {'saved':True}


@app.get('/api/demo')
def get_demo():
    return demo()


@app.post('/api/compile')
def compile(project: Project):
    return {'code':compile_scene(project), 'project':project.model_dump()}


@app.post('/api/render',status_code=202)
async def start_render(request: RenderRequest):
    if not importlib.util.find_spec('manim'):
        raise ValueError('Manim is missing. Run python -m pip install -r requirements.txt in the active environment.')
    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
        raise ValueError('Rendering needs FFmpeg and ffprobe. Install the full FFmpeg package and restart Animathema.')
    required = {o.id for o in request.project.objects if o.visible} | {a.target_id for a in request.project.animations if any(o.id==a.object_id and o.visible for o in request.project.objects)}
    if request.project.code_override is None and any(o.kind in ('MathTex','Matrix') and o.id in required for o in request.project.objects):
        if not shutil.which('latex') or not shutil.which('dvisvgm'):
            raise ValueError('This scene uses LaTeX. Install TeX Live or MiKTeX with latex and dvisvgm on PATH, or use Text instead.')
    code = compile_scene(request.project)
    return jobs.create('render',lambda job:render(job,request.project,request.quality,code))


def code_syntax_response(error):
    diagnostic = syntax_diagnostic(error)
    return JSONResponse({
        'detail': f'Python syntax error at line {error.lineno}, column {error.offset}: {error.msg}',
        'diagnostic': diagnostic,
    }, status_code=400)


@app.post('/api/compile/visual')
def compile_visual(project: Project):
    return {'code': compile_scene(project, use_override=False)}


@app.post('/api/code/analyze')
def analyze_editor_source(request: CodeSourceRequest):
    try:
        return analyze_manim_code(request.code)
    except SyntaxError as error:
        return code_syntax_response(error)


@app.post('/api/render/code', status_code=202)
async def start_code_render(request: CodeRenderRequest):
    try:
        analysis = analyze_manim_code(request.code)
    except SyntaxError as error:
        return code_syntax_response(error)
    scene_name = select_scene(analysis, request.scene_name)
    if not importlib.util.find_spec('manim'):
        raise ValueError('Manim is missing. Run python -m pip install -r requirements.txt in the active environment.')
    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
        raise ValueError('Rendering needs FFmpeg and ffprobe. Install the full FFmpeg package and restart Animathema.')
    quality = 'draft' if request.quality == 'low' else 'production'
    project = Project(name=scene_name)
    return jobs.create('render', lambda job: render(
        job, project, quality, analysis['code'], scene_name=scene_name, custom=True))


@app.post('/api/split')
def split_clip(request: SplitRequest):
    return {'clips':split(request.clip,request.time)}


@app.post('/api/export',status_code=202)
async def start_export(request: ExportRequest):
    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
        raise ValueError('Export needs FFmpeg and ffprobe. Install FFmpeg and add its bin folder to PATH.')
    if not request.project.clips:
        raise ValueError('Render your scene first, then add footage to the video track.')
    for clip in request.project.clips:
        media_path(clip.source)
    return jobs.create('export',lambda job:export_video(job,request))


@app.get('/api/jobs/{job_id}')
def get_job(job_id: str):
    if job_id not in jobs.jobs:
        raise HTTPException(404,'Job not found. Jobs are kept for the active app session.')
    return jobs.public(jobs.jobs[job_id])


@app.delete('/api/jobs/{job_id}')
async def cancel_job(job_id: str):
    if job_id not in jobs.jobs:
        raise HTTPException(404,'Job not found.')
    await jobs.cancel(jobs.jobs[job_id])
    return jobs.public(jobs.jobs[job_id])


@app.get('/api/media')
async def media():
    result = []
    for folder in ('renders','exports','custom_renders'):
        root = WORKSPACE/folder
        if root.exists():
            for p in sorted(root.rglob('*.mp4'),key=lambda p:p.stat().st_mtime,reverse=True):
                if 'partial_movie_files' not in p.parts:
                    source = p.relative_to(WORKSPACE).as_posix()
                    result.append({'source':source,'url':'/media/'+source,'name':p.stem})
    return result[:100]


@app.get('/api/media-info')
async def media_info(source: str):
    return await probe(media_path(source))


@app.get('/media/{source:path}')
def get_media(source: str):
    return FileResponse(media_path(source),media_type='video/mp4')


@app.get('/')
def index():
    return FileResponse(ROOT/'frontend'/'index.html')


app.mount('/static',StaticFiles(directory=ROOT/'frontend'),name='static')

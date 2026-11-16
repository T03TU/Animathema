"""Non-destructive clip operations and an FFmpeg video/audio export pipeline."""
import asyncio
import json
from pathlib import Path
import shutil
import uuid
from .models import Clip, ExportRequest
from .render_engine import WORKSPACE, jobs


def media_path(source):
    root = WORKSPACE.resolve()
    path = (root/source).resolve()
    if not path.is_relative_to(root) or path.relative_to(root).parts[0] not in ('renders','exports') or path.suffix.lower() != '.mp4' or not path.is_file():
        raise ValueError('Media must be an existing MP4 inside workspace/renders or workspace/exports.')
    return path


async def probe(path):
    if not shutil.which('ffprobe'):
        raise ValueError('ffprobe is missing. Install the full FFmpeg package and restart Animathema.')
    process = await asyncio.create_subprocess_exec('ffprobe','-v','error','-show_format','-show_streams','-of','json',str(path),stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
    try:
        out,err = await asyncio.wait_for(process.communicate(),30)
    except BaseException:
        if process.returncode is None:
            process.kill()
            await process.wait()
        raise
    if process.returncode:
        raise ValueError('Cannot read video: '+err.decode(errors='replace')[-500:])
    data = json.loads(out)
    video = next((s for s in data['streams'] if s['codec_type']=='video'),None)
    if not video:
        raise ValueError('This file has no video stream.')
    return {'duration':float(data['format']['duration']),'width':video['width'],'height':video['height'],'has_audio':any(s['codec_type']=='audio' for s in data['streams'])}


def split(clip: Clip, time: float):
    if not clip.start+.001 < time < clip.start+clip.duration-.001:
        raise ValueError('Place the playhead inside the selected video clip to split it.')
    cut = clip.in_point + (time-clip.start)*clip.speed
    left = clip.model_copy(update={'out_point':cut})
    right = clip.model_copy(update={'id':'clip_'+uuid.uuid4().hex[:12], 'name':clip.name+' · split','in_point':cut,'start':time})
    return [left,right]


def tempo(speed):
    factors = []
    while speed > 2:
        factors.append(2)
        speed /= 2
    while speed < .5:
        factors.append(.5)
        speed /= .5
    factors.append(speed)
    return ','.join(f'atempo={s}' for s in factors)


async def export_video(job, request: ExportRequest):
    clips = sorted(request.project.clips,key=lambda c:c.start)
    if not clips:
        raise ValueError('Render a scene or add a rendered clip before exporting.')
    folder = WORKSPACE/'exports'/job['id']
    folder.mkdir(parents=True)
    width,height,fps = request.width,request.height,request.fps
    args = ['ffmpeg','-hide_banner','-y']
    filters, labels = [],[]
    cursor = 0
    index = 0
    for clip in clips:
        if clip.start < cursor-.001:
            raise ValueError('Video clips overlap. Move them apart before exporting; gaps export as black.')
        path = media_path(clip.source)
        info = await probe(path)
        if clip.out_point > info['duration']+.05:
            raise ValueError(f'{clip.name}: out point exceeds the source duration.')
        gap = clip.start-cursor
        if gap > .001:
            g = f'g{index}'
            filters.extend([f'color=c=black:s={width}x{height}:r={fps}:d={gap}[{g}v]',f'anullsrc=r=48000:cl=stereo,atrim=duration={gap}[{g}a]'])
            labels.extend([f'[{g}v]',f'[{g}a]'])
        args.extend(['-i',str(path)])
        c = clip.crop
        crop_w = max(2,int(info['width']*c.width)//2*2)
        crop_h = max(2,int(info['height']*c.height)//2*2)
        crop_x = min(info['width']-crop_w, int(info['width']*c.x)//2*2)
        crop_y = min(info['height']-crop_h, int(info['height']*c.y)//2*2)
        filters.append(f'[{index}:v]trim=start={clip.in_point}:end={clip.out_point},setpts=(PTS-STARTPTS)/{clip.speed},crop={crop_w}:{crop_h}:{crop_x}:{crop_y},scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps={fps},format=yuv420p[v{index}]')
        if info['has_audio']:
            filters.append(f'[{index}:a]atrim=start={clip.in_point}:end={clip.out_point},asetpts=PTS-STARTPTS,{tempo(clip.speed)},aresample=48000,aformat=channel_layouts=stereo,apad,atrim=duration={clip.duration}[a{index}]')
        else:
            filters.append(f'anullsrc=r=48000:cl=stereo,atrim=duration={clip.duration}[a{index}]')
        labels.extend([f'[v{index}]',f'[a{index}]'])
        cursor = clip.start+clip.duration
        index += 1
    filters.append(''.join(labels)+f'concat=n={len(labels)//2}:v=1:a=1[outv][outa]')
    graph = folder/'filters.txt'
    graph.write_text(';\n'.join(filters),encoding='utf-8')
    output = folder/'Animathema.mp4'
    args.extend(['-filter_complex_script',str(graph),'-map','[outv]','-map','[outa]','-c:v','libx264','-preset','fast','-crf','18','-c:a','aac','-b:a','192k','-movflags','+faststart','-progress','pipe:1','-nostats',str(output)])
    await jobs.command(job,args,duration=cursor)
    source = output.relative_to(WORKSPACE).as_posix()
    return {'url':'/media/'+source,'source':source,**await probe(output)}

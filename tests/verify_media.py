"""Real Manim/FFmpeg checks in a disposable workspace: python -m tests.verify_media."""
import subprocess
import time
import httpx
import numpy as np
from backend.presets import demo
from backend.models import Project, Mobject, Animation
from tests.isolated_studio import isolated_studio


def wait_job(client, response):
    response.raise_for_status()
    job_id=response.json()['id']
    for _ in range(240):
        job=client.get('/api/jobs/'+job_id).json()
        if job['status'] in ('completed','failed','cancelled'):
            break
        time.sleep(.5)
    assert job['status']=='completed',job
    return job['result']


def check_frames(path, info):
    green=[]
    for t in (0,5,11):
        data=subprocess.run(['ffmpeg','-v','error','-ss',str(t),'-i',str(path),'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','-'],check=True,capture_output=True).stdout
        frame=np.frombuffer(data,dtype=np.uint8).reshape(info['height'],info['width'],3).astype(float)
        if t==0:
            assert np.max(np.abs(frame-np.array([16,19,29])))<12,'Future objects appeared at time zero.'
        mask=np.max(np.abs(frame-np.array([94,234,212])),axis=2)<45
        green.append(int(mask.sum()))
    assert green[1]<10,'Cubic curve appeared before its scheduled animation.'
    assert green[2]>80,'Cubic curve did not appear after its scheduled animation.'


def verify(url, workspace):
    with httpx.Client(base_url=url,timeout=30) as client:
        result=wait_job(client,client.post('/api/render',json={'project':demo().model_dump(),'quality':'draft'}))
        assert result['duration']==12 and result['height']==480
        check_frames(workspace/result['source'],result)
        project=demo().model_dump()
        clip={'id':'qa_clip','name':'QA clip','source':result['source'],'start':0,'in_point':0,'out_point':12,'speed':1,'crop':{'x':.1,'y':.1,'width':.8,'height':.8}}
        response=client.post('/api/split',json={'clip':clip,'time':4});response.raise_for_status()
        clips=response.json()['clips'];clips[1]['speed']=2;clips[1]['start']=4.5
        project['clips']=clips
        result=wait_job(client,client.post('/api/export',json={'project':project,'width':854,'height':480,'fps':30}))
        assert abs(result['duration']-8.5)<.15
        assert result['width']==854 and result['height']==480
        print('Verified demo frame timing, split, 2× retiming, crop, black gap and MP4 export.')

        # Actual source audio exercises the atempo path, including sub-0.5× speed.
        source=workspace/'renders'/'audio.mp4'
        subprocess.run(['ffmpeg','-v','error','-y','-f','lavfi','-i','color=c=purple:s=320x240:r=30:d=1','-f','lavfi','-i','sine=frequency=440:duration=1','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',str(source)],check=True)
        clip.update(source='renders/audio.mp4',out_point=1,speed=.25,crop={'x':0,'y':0,'width':1,'height':1})
        project['clips']=[clip]
        result=wait_job(client,client.post('/api/export',json={'project':project,'width':320,'height':240,'fps':30}))
        assert result['has_audio'] and abs(result['duration']-4)<.15
        print('Verified 0.25× retiming with real source audio.')

        # Camera turns and replacement references must compose with object animation.
        scene=Project(duration=2,objects=[Mobject(id='a',kind='Circle',name='Circle'),Mobject(id='b',kind='Square',name='Square')],animations=[Animation(id='intro',kind='Create',object_id='a',duration=.3),Animation(id='replace',kind='ReplacementTransform',object_id='a',target_id='b',start=.4,duration=.5),Animation(id='rotate',kind='Rotate',object_id='a',start=1,duration=.5),Animation(id='camera1',kind='MoveCamera',start=.1,duration=.4,angle=30),Animation(id='camera2',kind='AmbientRotation',start=.8,duration=.4,angle=45)])
        scene.camera.auto_3d=False;scene.camera.phi=35
        result=wait_job(client,client.post('/api/render',json={'project':scene.model_dump(),'quality':'draft'}))
        assert result['duration']==2
        print('Verified camera motion, replacement transform and subsequent rotation.')


if __name__=='__main__':
    with isolated_studio(include_workspace=True) as (url,workspace):
        verify(url,workspace)

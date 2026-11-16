"""Reproduce bugs.ods reports in an isolated app, with real rendered-frame checks.
Run: python -m tests.verify_reported_bugs
"""
import os
from pathlib import Path
import shutil
import subprocess
import time
import httpx
import numpy as np
from playwright.sync_api import sync_playwright, expect
from tests.isolated_studio import isolated_studio
from tests.verify_media import wait_job


def scene(kind='Transform', same_source=False):
    return {
        'name':'Untitled scene','duration':2.2,'fps':30,
        'camera':{'dimension':'3D','auto_3d':False,'phi':65,'theta':-45},
        'objects':[
            {'id':'cube','kind':'Cube','name':'Cube','color':'#f2777a'},
            {'id':'sphere','kind':'Sphere','name':'Sphere','color':'#5eead4'},
        ],
        'animations':[
            {'id':f'change{i}','kind':kind,
             'object_id':'cube' if same_source or i%2==0 else 'sphere',
             'target_id':'sphere' if i%2==0 else 'cube',
             'start':i*.5,'duration':.3,'track':2}
            for i in range(4)],
    }


def check_changes(path, result):
    for index,at in enumerate((.4,.9,1.4,1.9)):
        raw=subprocess.run(['ffmpeg','-v','error','-ss',str(at),'-i',str(path),'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','-'],check=True,capture_output=True).stdout
        image=np.frombuffer(raw,dtype=np.uint8).reshape(result['height'],result['width'],3).astype(float)
        red=(image[:,:,0]>image[:,:,1]*1.5)&(image[:,:,0]>image[:,:,2]*1.3)
        green=(image[:,:,1]>image[:,:,0]*1.4)&(image[:,:,1]>image[:,:,2]*1.05)
        expected,other=(green.sum(),red.sum()) if index%2==0 else (red.sum(),green.sum())
        assert expected>100 and expected>other*2,(index,int(expected),int(other))


def playhead(page):
    return page.locator('#playhead').evaluate('(e)=>parseFloat(e.style.left)')


def scrub(page, at, target='#ruler'):
    rect=page.locator('#timeline-content').bounding_box()
    px=float(page.locator('#timeline-zoom').input_value())
    box=page.locator(target).bounding_box()
    page.mouse.click(rect['x']+at*px,box['y']+min(12,box['height']/2))
    assert abs(playhead(page)-at*px)<1,(at,playhead(page))


def verify(url,workspace):
    with httpx.Client(base_url=url,timeout=30) as client:
        # Real output must change at every step, for aliases, same-source returns,
        # and replacements that need boundary cleanup before later animations.
        for kind,same in [('Transform',False),('Transform',True),('ReplacementTransform',False)]:
            result=wait_job(client,client.post('/api/render',json={'project':scene(kind,same),'quality':'draft'}))
            print('Checking rendered chain:',kind,'same source:',same,flush=True)
            check_changes(workspace/result['source'],result)
        print('Verified all four rendered changes in alternating, same-source and replacement chains.',flush=True)

        empty=scene();empty['animations']=[]
        client.put('/api/project',json=empty).raise_for_status()
        with sync_playwright() as p:
            browser=p.chromium.launch(executable_path=os.environ.get('ANIMATHEMA_CHROME') or shutil.which('google-chrome'),headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
            page=browser.new_page(viewport={'width':1440,'height':1000})
            errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
            page.goto(url);page.wait_for_selector('.outliner-row')
            # The UI schedules a selected target as the continuation of the shape
            # that transformed into it, rather than adding an invisible actor.
            for index,object_id in enumerate(['cube','sphere','cube','sphere']):
                page.locator(f'[data-object="{object_id}"]').click()
                page.locator('#quick-animation').select_option('Transform')
                if index:
                    assert float(page.locator('[data-field="start"]').input_value())>=.3
                field=page.locator('[data-field="duration"]');field.fill('0.3');field.press('Tab')
                field=page.locator('[data-field="start"]');field.fill(str(index*.5));field.press('Tab')
                if index==0:
                    page.locator('[data-object="cube"]').click()
                    page.locator('#quick-animation').select_option('Transform')
                    expect(page.locator('[data-field="target_id"]')).to_have_value('cube')
                    page.locator('#delete-selection').click()
            expect(page.locator('.timeline-block')).to_have_count(4)
            assert page.evaluate('window.AnimathemaStudio.getProject().objects.length')==2

            def render():
                with page.expect_response(lambda r:r.url.endswith('/api/render') and r.request.method=='POST') as response:
                    page.locator('#draft-render').click()
                job_id=response.value.json()['id']
                page.wait_for_function('!window.AnimathemaStudio.isBusy()',timeout=60000)
                result=client.get('/api/jobs/'+job_id).json()
                assert result['status']=='completed',result
                return result['result']

            clip_id=None;previous=None
            for index in range(3):
                result=render()
                expect(page.locator('.video-block')).to_have_count(1)
                clips=page.evaluate('structuredClone(window.AnimathemaStudio.getProject().clips)')
                assert clips[0]['source']==result['source'] and clips[0]['source']!=previous
                if clip_id is not None:assert clips[0]['id']==clip_id
                clip_id=clips[0]['id'];previous=clips[0]['source']
                assert page.evaluate('window.AnimathemaStudio.getProject().objects.length')==2
                assert page.evaluate('window.AnimathemaStudio.getProject().animations.length')==4
                for at in (.2,1.6,.8):scrub(page,at)
                scrub(page,1.1,'[data-track="0"]')
                scrub(page,.9,'.video-block')
                page.locator('#play').click()
                scrub(page,.4)
                expect(page.locator('#play')).to_have_text('▶')
                at=playhead(page);page.wait_for_timeout(100);assert abs(playhead(page)-at)<.1
                # Lost/cancelled gestures must not continue changing time on hover.
                ruler=page.locator('#ruler').bounding_box()
                page.mouse.move(ruler['x']+20,ruler['y']+12);page.mouse.down()
                page.mouse.move(ruler['x']+40,ruler['y']+12,steps=3)
                before=playhead(page)
                page.evaluate('window.dispatchEvent(new PointerEvent("pointercancel",{pointerId:1,isPrimary:true,bubbles:true}))')
                page.evaluate('(x)=>window.dispatchEvent(new PointerEvent("pointermove",{pointerId:1,isPrimary:true,buttons:0,clientX:x,clientY:500}))',ruler['x']+100)
                assert abs(playhead(page)-before)<.1
                page.mouse.up()
                page.mouse.move(ruler['x']+140,ruler['y']+12)
                assert abs(playhead(page)-before)<.1
                scrub(page,1.3)
                # A selection/DOM rebuild in the middle of a drag must not break it.
                page.mouse.move(ruler['x']+20,ruler['y']+12);page.mouse.down()
                page.locator('[data-object="cube"]').evaluate('(e)=>e.click()')
                page.mouse.move(ruler['x']+85,ruler['y']+12,steps=4);page.mouse.up()
                assert abs(playhead(page)-85)<1
                scrub(page,.6)
            check_changes(workspace/result['source'],result)
            print('Verified repeated renders reuse one clip and timeline navigation survives cancellation, playback and DOM rebuilds.',flush=True)

            # Cuts, retiming, crop and IDs survive another render of this scene.
            scrub(page,1.0)
            page.locator('#split-clip').click()
            expect(page.locator('.video-block')).to_have_count(2)
            field=page.locator('[data-field="speed"][type="number"]');field.fill('2');field.press('Tab')
            page.locator('#crop-aspect').select_option('1:1')
            before=page.evaluate('structuredClone(window.AnimathemaStudio.getProject().clips)')
            result=render()
            after=page.evaluate('structuredClone(window.AnimathemaStudio.getProject().clips)')
            assert len(before)==len(after)==2
            for a,b in zip(before,after):
                for field in ['id','start','in_point','out_point','speed','crop']:
                    assert a[field]==b[field],(field,a,b)
                assert b['source']==result['source']
            expect(page.locator('#save-state')).to_have_text('Saved locally',timeout=5000)
            page.reload();page.wait_for_selector('.outliner-row')
            expect(page.locator('.video-block')).to_have_count(2)
            render();expect(page.locator('.video-block')).to_have_count(2)

            # Explicitly adding a historical take remains independent of updates.
            page.locator('#media-open').click()
            page.locator('[data-add-media]').first.click()
            expect(page.locator('.video-block')).to_have_count(3)
            manual=page.evaluate('structuredClone(window.AnimathemaStudio.getProject().clips.at(-1))')
            render();expect(page.locator('.video-block')).to_have_count(3)
            manual_after=page.evaluate('(id)=>window.AnimathemaStudio.getProject().clips.find(c=>c.id===id)',manual['id'])
            assert manual_after==manual
            print('Verified re-rendering preserves edited clips and explicit historical takes, including after reload.',flush=True)

            # A shorter revision must not turn a later edit into an empty clip.
            old_segments=page.evaluate('structuredClone(window.AnimathemaStudio.getProject().clips)')
            while page.locator('[data-block-type="animation"]').count():
                page.locator('[data-block-type="animation"]').first.click()
                page.locator('#delete-selection').click()
            field=page.locator('[data-field="scene.duration"]');field.fill('0.4');field.press('Tab')
            short=render()
            segments=page.evaluate('structuredClone(window.AnimathemaStudio.getProject().clips)')
            assert len(segments)==3 and all(c['out_point']>c['in_point'] for c in segments)
            assert segments[0]['source']==short['source']
            assert segments[1]['source']==old_segments[1]['source']
            assert segments[2]==manual
            print('Verified shorter revisions retain out-of-range edits as valid historical footage.',flush=True)

            # A completed render must never attach itself to a newly opened project.
            page.locator('#code-workspace-toggle').click()
            page.locator('#direct-code-source').fill('import time\nclass DelayedScene(Scene):\n    def construct(self):\n        time.sleep(1)\n        self.wait(0.2)\n')
            with page.expect_response(lambda r:r.url.endswith('/api/render/code')) as response:
                page.locator('#direct-code-draft').click()
            job_id=response.value.json()['id']
            page.locator('#project-menu').click();page.locator('#menu-new').click()
            page.wait_for_function('!window.AnimathemaStudio.isBusy()',timeout=60000)
            assert client.get('/api/jobs/'+job_id).json()['status']=='completed'
            expect(page.locator('.outliner-row')).to_have_count(0)
            expect(page.locator('.video-block')).to_have_count(0)
            assert not errors,errors
            browser.close()
            print('Verified render completion cannot create unwanted footage in a different project.',flush=True)


if __name__=='__main__':
    with isolated_studio(include_workspace=True) as (url,workspace):
        verify(url,workspace)

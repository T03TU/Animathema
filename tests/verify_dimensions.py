"""Real browser navigation and Manim framing QA in an isolated workspace.
Run: python -m tests.verify_dimensions
"""
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import httpx
import numpy as np
from playwright.sync_api import sync_playwright, expect
from tests.isolated_studio import isolated_studio


def camera(page):
    return page.evaluate('structuredClone(window.AnimathemaStudio.getProject().camera)')


def drag(page, button='middle', dx=65, dy=30, modifiers=(), empty=False):
    rect=page.locator('#stage').bounding_box()
    x,y=(rect['x']+14,rect['y']+rect['height']-12) if empty else (rect['x']+rect['width']/2,rect['y']+rect['height']/2)
    for key in modifiers: page.keyboard.down(key)
    page.mouse.move(x,y);page.mouse.down(button=button)
    page.mouse.move(x+dx,y+dy,steps=8);page.mouse.up(button=button)
    for key in modifiers: page.keyboard.up(key)


def verify(url,workspace):
    with sync_playwright() as p, httpx.Client(base_url=url,timeout=30) as client:
        browser=p.chromium.launch(executable_path=os.environ.get('ANIMATHEMA_CHROME') or shutil.which('google-chrome'),headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
        page=browser.new_page(viewport={'width':1440,'height':1000})
        errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto(url);page.wait_for_selector('.outliner-row')
        expect(page.locator('#viewport')).to_have_attribute('data-dimension','2D')
        expect(page.locator('#axis-gizmo button:visible')).to_have_count(2)
        expect(page.locator('[data-field="position.2"]')).to_have_count(0)
        assert not (workspace/'project.json').exists(),'Opening a project must not rewrite it.'
        page.locator('#view-3d').click()
        expect(page.locator('#viewport')).to_have_attribute('data-dimension','3D')
        expect(page.locator('#axis-gizmo button:visible')).to_have_count(6)
        expect(page.locator('[data-field="position.2"]')).to_be_visible()
        before=camera(page)
        before_positions=page.evaluate('window.AnimathemaStudio.getProject().objects.map(o=>o.position)')
        bitmap=page.locator('#stage').evaluate('(c)=>c.toDataURL()')
        drag(page)
        after=camera(page)
        assert after['phi']!=before['phi'] and after['theta']!=before['theta']
        assert bitmap!=page.locator('#stage').evaluate('(c)=>c.toDataURL()')
        assert before_positions==page.evaluate('window.AnimathemaStudio.getProject().objects.map(o=>o.position)')
        for options in ({'button':'left','empty':True},{'button':'left','modifiers':['Alt']}):
            before=camera(page);drag(page,**options);after=camera(page)
            assert after['theta']!=before['theta']
        before=camera(page);drag(page,modifiers=['Shift']);after=camera(page)
        assert before['phi']==after['phi'] and before['theta']==after['theta']
        assert before['frame_center']!=after['frame_center']
        before=camera(page);drag(page,button='right',dx=-35,dy=20);after=camera(page)
        assert before['frame_center']!=after['frame_center']
        page.mouse.wheel(0,-120);page.wait_for_timeout(250)
        assert camera(page)['zoom']>after['zoom']
        assert not errors,errors

        # Verify the rotation against Manim's exact camera matrix convention.
        from manim import ThreeDCamera, DEGREES
        matrix=page.evaluate('window.StageViewport.math.rotation(52,23)')
        manim=ThreeDCamera(phi=52*DEGREES,theta=23*DEGREES)
        assert np.allclose(matrix,manim.generate_rotation_matrix())
        for axis,phi,theta in [('+X',90,0),('-X',90,-180),('+Y',90,90),('-Y',90,-90),('+Z',0,-90),('-Z',180,-90)]:
            page.locator(f'[data-view-axis="{axis}"]').click()
            try:
                page.wait_for_function('(target)=>{const c=window.AnimathemaStudio.getProject().camera;return Math.abs(c.phi-target[0])<.01&&Math.abs(c.theta-target[1])<.01}',arg=[phi,theta],timeout=5000)
            except Exception:
                print('Failed axis snap:',axis,camera(page),'Browser errors:',errors,flush=True)
                raise
            c=camera(page)
            assert abs(c['phi']-phi)<.01 and abs(c['theta']-theta)<.01,(axis,c)
            assert c['projection']=='orthographic'
        for view in ['front','side','top','iso']:
            page.locator('#view-preset').select_option(view)
            phi,theta={'front':(90,-90),'side':(90,0),'top':(0,-90),'iso':(65,-45)}[view]
            page.wait_for_function('(target)=>{const c=window.AnimathemaStudio.getProject().camera;return Math.abs(c.phi-target[0])<.01&&Math.abs(c.theta-target[1])<.01}',arg=[phi,theta],timeout=5000)
        page.locator('#fit-view').click()
        assert camera(page)['frame_center']==[0,0,0] and camera(page)['zoom']==1

        # Volumes and surfaces use the same matrix; object dragging stays in the view plane.
        for kind in ['Cube','Sphere','Surface']:
            page.locator('#preset-search').fill(kind)
            page.locator(f'[data-preset="{kind}"]').click()
        sphere_id=page.evaluate('window.AnimathemaStudio.getProject().objects.find(o=>o.kind==="Sphere").id')
        page.locator(f'[data-object="{sphere_id}"]').click()
        for axis,value in [(0,'3'),(1,'-1'),(2,'2')]:
            field=page.locator(f'[data-field="position.{axis}"]');field.fill(value);field.press('Tab')
        point=page.evaluate('window.StageViewport.project(3,-1,2)')
        rect=page.locator('#stage').bounding_box()
        page.mouse.move(rect['x']+point[0],rect['y']+point[1]);page.mouse.down()
        page.mouse.move(rect['x']+point[0]+24,rect['y']+point[1]-13,steps=5);page.mouse.up()
        moved=page.evaluate('(id)=>window.AnimathemaStudio.getProject().objects.find(o=>o.id===id).position',sphere_id)
        projected=page.evaluate('(p)=>window.StageViewport.project(...p)',moved)
        assert np.allclose(projected[:2],[point[0]+24,point[1]-13],atol=1),moved
        page.locator('#preset-search').fill('')
        page.screenshot(path=str(Path(tempfile.gettempdir())/'animathema-3d-viewport.png'))
        page.locator('#view-3d').click()
        expect(page.locator('#axis-gizmo button:visible')).to_have_count(2)
        expect(page.locator('[data-field="position.2"]')).to_have_count(0)
        assert camera(page)['phi']==0 and camera(page)['theta']==-90
        assert moved==page.evaluate('(id)=>window.AnimathemaStudio.getProject().objects.find(o=>o.id===id).position',sphere_id)
        before=camera(page);drag(page);after=camera(page)
        assert before['phi']==after['phi']==0 and before['theta']==after['theta']==-90
        page.screenshot(path=str(Path(tempfile.gettempdir())/'animathema-2d-viewport.png'))
        page.locator('#view-3d').click()
        page.wait_for_timeout(1600)
        saved=camera(page);page.reload();page.wait_for_selector('.outliner-row')
        assert camera(page)==saved
        expect(page.locator('#viewport')).to_have_attribute('data-dimension','3D')

        # Render saved framing with a pinned, identifiable HUD and real 3D geometry.
        project=client.get('/api/demo').json()
        project.update(duration=.4,animations=[],objects=[
            {'id':'axes','kind':'Axes','name':'Space'},
            {'id':'cube','kind':'Cube','name':'Cube','position':[-1,0,0],'color':'#ee8c91'},
            {'id':'sphere','kind':'Sphere','name':'Sphere','position':[1,0,1],'color':'#76cda7'},
            {'id':'hud','kind':'Text','name':'Pinned HUD','fixed_in_frame':True,'stroke_width':0,'color':'#ff00ff','position':[0,2.9,0],'params':{'text':'PINNED HUD','font_size':30}},
        ])
        project['camera']=dict(saved,dimension='3D',phi=54,theta=27,zoom=1.4,frame_center=[1,2,3],projection='perspective')
        compiled=client.post('/api/compile',json=project).json()['code']
        assert 'phi=54.0*DEGREES, theta=27.0*DEGREES, zoom=1.4' in compiled
        assert 'view_center = np.array([1.0, 2.0, 3.0])' in compiled
        assert 'obj_axes = ThreeDAxes(' in compiled
        response=client.post('/api/render',json={'project':project,'quality':'draft'});response.raise_for_status()
        job_id=response.json()['id']
        for _ in range(120):
            job=client.get('/api/jobs/'+job_id).json()
            if job['status'] in ('completed','failed','cancelled'):break
            time.sleep(.5)
        assert job['status']=='completed',job
        result=job['result']
        output=workspace/result['source']
        pixels=subprocess.run(['ffmpeg','-v','error','-i',str(output),'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','-'],check=True,capture_output=True).stdout
        image=np.frombuffer(pixels,dtype=np.uint8).reshape(result['height'],result['width'],3)
        mask=(image[:,:,0]>180)&(image[:,:,2]>180)&(image[:,:,1]<110)
        ys,xs=np.where(mask)
        assert len(xs)>40,'Pinned HUD not visible in the rendered frame.'
        assert abs((xs.min()+xs.max())/2-result['width']/2)<15
        assert abs((ys.min()+ys.max())/2-66)<15
        assert not errors,errors
        browser.close()
        print('Verified 2D/3D gizmos, all orbit/pan gestures, zoom, six axis snaps, view presets, 3D dragging, depth preservation, reload persistence, Manim projection matrix, camera compilation and rendered fixed HUD.')


if __name__=='__main__':
    with isolated_studio(include_workspace=True) as (url,workspace):
        verify(url,workspace)

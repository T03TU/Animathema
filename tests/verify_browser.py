"""Run from the project root: python -m tests.verify_browser.
Launches its own server in a disposable temporary workspace, leaving your project untouched.
Uses system Chrome, ANIMATHEMA_CHROME, or Playwright's installed Chromium.
"""
import os, shutil, tempfile
from playwright.sync_api import sync_playwright, expect
import json
from pathlib import Path

from tests.isolated_studio import isolated_studio

def verify(base_url):
    with sync_playwright() as p:
     browser=p.chromium.launch(executable_path=os.environ.get('ANIMATHEMA_CHROME') or shutil.which('google-chrome'),headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
     page=browser.new_page(viewport={'width':1440,'height':1000},device_scale_factor=1)
     errors=[];failed=[]
     page.on('pageerror',lambda e:errors.append(str(e)))
     page.on('response',lambda r:failed.append((r.status,r.url)) if r.status>=400 else None)
     page.goto(base_url);page.wait_for_selector('.outliner-row')
     page.locator('#project-menu').click();page.locator('#menu-demo').click()
     expect(page.locator('.outliner-row')).to_have_count(6)
     # Camera properties and the hierarchical animation outliner are interactive.
     page.locator('#select-camera').click()
     expect(page.locator('[data-field="scene.camera.theta"]')).to_have_value('-90')
     page.locator('[data-field="scene.camera.zoom"]').fill('1.2')
     page.locator('[data-field="scene.camera.zoom"]').press('Tab')
     page.locator('#undo').click()
     expect(page.locator('[data-field="scene.camera.zoom"]')).to_have_value('1')
     page.locator('[data-expand="sine"]').click()
     page.locator('[data-outliner-animation="a_sine"]').click()
     expect(page.locator('[data-field="start"]')).to_have_value('1.7')
     # Search, preset insertion, properties, undo and redo.
     page.locator('#preset-search').fill('Circle');page.locator('[data-preset="Circle"]').click()
     expect(page.locator('.outliner-row')).to_have_count(7)
     page.locator('[data-field="position.0"]').fill('1.5');page.locator('[data-field="position.0"]').press('Tab')
     expect(page.locator('[data-field="position.0"]')).to_have_value('1.5')
     page.locator('#undo').click();expect(page.locator('[data-field="position.0"]')).to_have_value('0')
     page.locator('#redo').click();expect(page.locator('[data-field="position.0"]')).to_have_value('1.5')
     # Add animation, drag a timing block, and resize its edge.
     page.locator('#quick-animation').select_option('Create')
     block=page.locator('.timeline-block.selected');before=block.bounding_box()
     page.mouse.move(before['x']+before['width']/2,before['y']+before['height']/2);page.mouse.down();page.mouse.move(before['x']+before['width']/2+68,before['y']+before['height']/2,steps=6);page.mouse.up()
     expect(page.locator('[data-field="start"]')).to_have_value('1')
     edge=page.locator('.timeline-block.selected .block-edge.right');r=edge.bounding_box()
     page.mouse.move(r['x']+3,r['y']+10);page.mouse.down();page.mouse.move(r['x']+37,r['y']+10,steps=6);page.mouse.up()
     assert float(page.locator('[data-field="duration"]').input_value())>1.9
     # Code inspector, syntax highlighting, local override, reset.
     page.locator('[data-inspector="code"]').click();expect(page.locator('#code-highlight')).to_contain_text('AnimathemaScene')
     page.locator('#edit-code').click();code=page.locator('#code-editor').input_value();page.locator('#code-editor').fill(code+'\n# browser QA override\n');page.locator('#apply-code').click();expect(page.locator('#code-warning')).to_be_visible()
     page.locator('#reset-code').click();expect(page.locator('#code-warning')).to_be_hidden()
     # Restore clean demo using the project menu.
     page.locator('#project-menu').click();page.locator('#menu-demo').click();expect(page.locator('.outliner-row')).to_have_count(6)
     page.locator('#preset-search').fill('')
     # Run an actual render from the UI, then split and retime its footage.
     page.locator('#draft-render').click();expect(page.locator('.video-block')).to_have_count(1,timeout=60000)
     expect(page.locator('[data-mode="render"]')).to_have_class('active')
     page.locator('#ruler').click(position={'x':272,'y':12})
     page.locator('#split-clip').click();expect(page.locator('.video-block')).to_have_count(2)
     page.locator('[data-field="speed"][type="number"]').fill('2');page.locator('[data-field="speed"][type="number"]').press('Tab')
     page.locator('#crop-aspect').select_option('9:16');expect(page.locator('#crop-toggle')).to_have_class('tool active')
     assert float(page.locator('[data-field="crop.width"]').input_value())<.4
     page.locator('#show-crop').click()
     page.screenshot(path=str(Path(tempfile.gettempdir())/'animathema-monitor.png'),full_page=True)
     # Export the edited clips through the UI.
     page.locator('#export-open').click();page.locator('#export-resolution').select_option('854,480');page.locator('#export-submit').click()
     expect(page.locator('#job-download')).to_be_visible(timeout=60000)
     assert page.locator('#job-status').inner_text()=='completed'
     # The responsive layout stays within the page at phone dimensions.
     page.locator('#console-close').click();page.locator('[data-mode="stage"]').click();page.locator('#fit-view').click();page.screenshot(path=str(Path(tempfile.gettempdir())/'animathema-studio.png'),full_page=True)
     page.set_viewport_size({'width':430,'height':900});page.wait_for_timeout(300);page.screenshot(path=str(Path(tempfile.gettempdir())/'animathema-mobile.png'),full_page=True)
     assert page.evaluate('document.documentElement.scrollWidth')<=430
     print('Browser checks passed: presets, properties, undo/redo, animation drag/resize, code overrides, real rendering, video split, retiming, crop, MP4 export, responsive layout.')
     print('JavaScript errors:',errors);print('Failed responses:',failed)
     assert not errors and not failed
     browser.close()

if __name__ == "__main__":
    with isolated_studio() as url:
        verify(url)

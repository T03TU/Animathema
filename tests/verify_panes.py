"""Browser layout and editing checks in a disposable workspace: python -m tests.verify_panes."""
import os
from pathlib import Path
import shutil
import tempfile
from playwright.sync_api import sync_playwright, expect
from tests.isolated_studio import isolated_studio


def verify(url, workspace):
    with sync_playwright() as p:
        browser = p.chromium.launch(
            executable_path=os.environ.get('ANIMATHEMA_CHROME') or shutil.which('google-chrome'),
            headless=True, args=['--no-sandbox', '--disable-dev-shm-usage'])
        page = browser.new_page(viewport={'width':1440,'height':1000})
        errors=[]
        page.on('pageerror',lambda error:errors.append(str(error)))
        page.goto(url)
        page.wait_for_selector('.outliner-row')
        assert not (workspace/'project.json').exists()
        original=page.locator('#viewport').bounding_box()
        original_project=page.evaluate('JSON.stringify(window.AnimathemaStudio.getProject())')

        # Collapsing side panes gives the viewport their space; restoration is exact.
        page.locator('#pane-left .pane-collapse[data-pane-toggle="left"]').click()
        expect(page.locator('#pane-left > .pane-restore')).to_be_visible()
        assert page.locator('#viewport').bounding_box()['width']>original['width']+190
        page.locator('#pane-inspector .pane-collapse[data-pane-toggle="inspector"]').click()
        assert page.locator('#viewport').bounding_box()['width']>original['width']+420
        page.locator('#pane-timeline [data-pane-toggle="timeline"]').click()
        assert page.locator('#viewport').bounding_box()['height']>original['height']+200
        assert page.locator('#play').is_visible(),'Playback remains available on the collapsed timeline.'
        assert page.evaluate('JSON.stringify(window.AnimathemaStudio.getProject())')==original_project
        assert not (workspace/'project.json').exists(),'Layout changes must not save or alter the scene.'
        page.reload();page.wait_for_selector('.outliner-row',state='attached')
        expect(page.locator('#pane-left > .pane-restore')).to_be_visible()
        expect(page.locator('#pane-inspector > .pane-restore')).to_be_visible()
        expect(page.locator('#pane-timeline [data-pane-toggle="timeline"]')).to_have_attribute('aria-expanded','false')
        page.locator('#pane-expand-all').click()
        restored=page.locator('#viewport').bounding_box()
        assert abs(restored['width']-original['width'])<1 and abs(restored['height']-original['height'])<1

        # Individual sidebar sections release their height without clearing contents.
        collection=page.locator('#pane-outliner').bounding_box()['height']
        page.locator('[data-pane-section="library"]').click()
        expect(page.locator('#preset-search')).to_be_hidden()
        assert page.locator('#pane-outliner').bounding_box()['height']>collection+100
        page.locator('[data-pane-section="library"]').click()
        library=page.locator('#pane-library').bounding_box()['height']
        page.locator('[data-pane-section="outliner"]').click()
        expect(page.locator('#outliner')).to_be_hidden()
        assert page.locator('#pane-library').bounding_box()['height']>library+100
        page.locator('[data-pane-section="outliner"]').click()

        # Folded inspector sections retain values and survive selection rerenders.
        transform=page.locator('[data-property-fold="Transform"]')
        transform.click()
        expect(page.locator('[data-field="position.0"]')).to_be_hidden()
        page.locator('[data-object="linear"]').click()
        expect(page.locator('[data-field="position.0"]')).to_be_hidden()
        page.locator('[data-property-fold="Transform"]').click()
        expect(page.locator('[data-field="position.0"]')).to_have_value('0')

        # Focus is reversible, including a previously collapsed pane, and keyboard safe.
        page.locator('#pane-inspector .pane-collapse').click()
        before_focus=page.locator('#viewport').bounding_box()
        page.locator('#pane-focus').click()
        expect(page.locator('#pane-focus')).to_have_attribute('aria-pressed','true')
        assert page.locator('#viewport').bounding_box()['height']>before_focus['height']+200
        expect(page.locator('#pane-viewport .pane-collapse')).to_be_disabled()
        page.screenshot(path=str(Path(tempfile.gettempdir())/'animathema-focus-layout.png'))
        page.locator('#pane-focus').focus();page.keyboard.press('Space')
        expect(page.locator('#pane-focus')).to_have_attribute('aria-pressed','false')
        expect(page.locator('#pane-inspector > .pane-restore')).to_be_visible()
        assert page.locator('#play').inner_text()=='▶','Space on a layout control must not start playback.'
        assert abs(page.locator('#viewport').bounding_box()['width']-before_focus['width'])<1
        page.locator('#pane-expand-all').click()

        # Timeline-only layout expands to fill the available width and height.
        page.locator('#pane-viewport .pane-collapse').click()
        expect(page.locator('#pane-viewport > .pane-restore')).to_be_visible()
        assert page.locator('#pane-inspector').bounding_box()['width']>400
        page.locator('#pane-left .pane-collapse[data-pane-toggle="left"]').click()
        page.locator('#pane-inspector .pane-collapse').click()
        expect(page.locator('#pane-timeline [data-pane-toggle="timeline"]')).to_be_disabled()
        assert page.locator('#pane-timeline').bounding_box()['height']>700
        assert page.locator('#pane-timeline').bounding_box()['width']>1400
        page.locator('#pane-expand-all').click()

        # Resizing still works and collapsing preserves the chosen size.
        resizer=page.locator('#left-resizer').bounding_box()
        page.mouse.move(resizer['x']+2,resizer['y']+80);page.mouse.down()
        page.mouse.move(resizer['x']+48,resizer['y']+80,steps=5);page.mouse.up()
        width=page.locator('#pane-left').bounding_box()['width']
        page.locator('#pane-left .pane-collapse[data-pane-toggle="left"]').click()
        page.locator('#pane-left > .pane-restore').click()
        assert abs(page.locator('#pane-left').bounding_box()['width']-width)<1

        # Search reveals its pane; hiding the viewport preserves an un-applied code draft.
        page.locator('#pane-left .pane-collapse[data-pane-toggle="left"]').click()
        page.keyboard.press('/')
        expect(page.locator('#preset-search')).to_be_focused()
        page.locator('#code-workspace-toggle').click()
        code='class DraftScene(Scene):\n    def construct(self):\n        self.wait(1)\n'
        page.locator('#direct-code-source').fill(code)
        page.locator('#pane-viewport .pane-collapse').click()
        page.locator('#pane-viewport > .pane-restore').click()
        expect(page.locator('#direct-code-source')).to_have_value(code)
        page.locator('[data-mode="stage"]').click()
        page.locator('#view-3d').click()
        page.locator('#pane-focus').click()
        expect(page.locator('#axis-gizmo button:visible')).to_have_count(6)
        rect=page.locator('#stage').bounding_box()
        before=page.evaluate('window.AnimathemaStudio.getProject().camera.theta')
        page.mouse.move(rect['x']+rect['width']/2,rect['y']+rect['height']/2)
        page.mouse.down(button='middle');page.mouse.move(rect['x']+rect['width']/2+45,rect['y']+rect['height']/2+15,steps=5);page.mouse.up(button='middle')
        assert page.evaluate('window.AnimathemaStudio.getProject().camera.theta')!=before
        page.locator('#pane-focus').click()

        # Narrow layouts can collapse each pane and restore without overflowing.
        page.set_viewport_size({'width':430,'height':900})
        page.locator('#pane-expand-all').click()
        assert page.evaluate('document.documentElement.scrollWidth')<=430
        for key in ['left','inspector','timeline']:
            page.locator(f'#pane-{key} .pane-collapse[data-pane-toggle="{key}"]').click()
        assert page.locator('#viewport').bounding_box()['width']>370
        assert page.locator('#viewport').bounding_box()['height']>500
        page.screenshot(path=str(Path(tempfile.gettempdir())/'animathema-panes-mobile.png'),full_page=True)
        page.locator('#pane-expand-all').click()
        page.locator('#pane-viewport .pane-collapse').click()
        page.locator('#pane-left .pane-collapse[data-pane-toggle="left"]').click()
        assert page.locator('#pane-timeline').bounding_box()['width']>400
        assert page.evaluate('document.documentElement.scrollWidth')<=430
        page.locator('#pane-expand-all').click()
        assert not errors,errors
        browser.close()
        print('Verified pane space reclamation, restore/persistence, nested folding, focus mode, keyboard activation, timeline-only layout, resize preservation, code drafts, 3D navigation and mobile layout.')


if __name__=='__main__':
    with isolated_studio(include_workspace=True) as (url,workspace):
        verify(url,workspace)

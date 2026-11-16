"""Isolated Code workspace + real rendering/NLE QA: python -m tests.verify_code_workspace."""
import os
from pathlib import Path
import shutil
import tempfile
import httpx
from playwright.sync_api import sync_playwright, expect
from tests.isolated_studio import isolated_studio


CUSTOM_CODE = '''# Import intentionally omitted: render mode supplies it.
class First(Scene):
    def construct(self):
        self.add(Square(color=BLUE))
        self.wait(0.4)

class PastedScene(MovingCameraScene):
    def construct(self):
        self.play(Create(Circle(color=GREEN)), run_time=0.2)
        self.wait(0.2)
'''


def verify(url, workspace):
    with sync_playwright() as p, httpx.Client(base_url=url, timeout=30) as client:
        browser = p.chromium.launch(
            executable_path=os.environ.get('ANIMATHEMA_CHROME') or shutil.which('google-chrome'),
            headless=True, args=['--no-sandbox', '--disable-dev-shm-usage'])
        context = browser.new_context(viewport={'width':1440, 'height':1000},
                                      permissions=['clipboard-read', 'clipboard-write'])
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(url)
        page.wait_for_selector('.outliner-row')
        page.locator('#code-workspace-toggle').click()
        editor = page.locator('#direct-code-source')
        expect(editor).to_have_value(__import__('re').compile('obj_sine'))
        expect(page.locator('#direct-code-status')).to_have_text('Synced with Visual Scene')
        assert page.locator('#direct-code-highlight .py-keyword').count() > 0
        assert len(page.locator('#direct-code-lines').inner_text().splitlines()) > 10

        # Visual edits continue to flow into the workspace until the first input.
        page.locator('#preset-search').fill('Circle')
        page.locator('[data-preset="Circle"]').click()
        expect(editor).to_have_value(__import__('re').compile('Circle\\(radius='))
        editor.fill(CUSTOM_CODE)
        expect(page.locator('#direct-code-status')).to_have_text('Custom Code Override')
        expect(page.locator('#direct-code-scene option')).to_have_count(2)
        page.locator('#direct-code-scene').select_option('PastedScene')
        page.locator('#preset-search').fill('Square')
        page.locator('[data-preset="Square"]').click()
        page.wait_for_timeout(500)
        expect(editor).to_have_value(CUSTOM_CODE)
        page.locator('[data-mode="stage"]').click()
        page.locator('#code-workspace-toggle').click()
        expect(editor).to_have_value(CUSTOM_CODE)

        # Reload retains the custom draft and scene selection in browser storage.
        page.reload()
        page.wait_for_selector('.outliner-row')
        page.locator('#code-workspace-toggle').click()
        expect(editor).to_have_value(CUSTOM_CODE)
        expect(page.locator('#direct-code-scene')).to_have_value('PastedScene')
        page.locator('#direct-code-copy').click()
        assert page.evaluate('navigator.clipboard.readText()') == CUSTOM_CODE
        with page.expect_download() as download:
            page.locator('#direct-code-download').click()
        saved = workspace / 'downloaded.py'
        download.value.save_as(saved)
        assert saved.read_text() == CUSTOM_CODE

        # Editor indentation and detailed Python diagnostics do not create jobs.
        editor.fill('class TabScene(Scene):\n')
        editor.press('Control+End')
        editor.press('Tab')
        expect(editor).to_have_value('class TabScene(Scene):\n    ')
        editor.press('Shift+Tab')
        expect(editor).to_have_value('class TabScene(Scene):\n')
        editor.fill('class Broken(Scene)\n    pass\n')
        expect(page.locator('#direct-code-diagnostic')).to_contain_text('line 1, column')
        assert page.locator('#direct-code-lines .error-line').count() == 1
        page.locator('#direct-code-draft').click()
        expect(page.locator('.video-block')).to_have_count(0)

        editor.fill(CUSTOM_CODE)
        expect(page.locator('#direct-code-scene option')).to_have_count(2)
        page.locator('#direct-code-scene').select_option('PastedScene')
        page.screenshot(path=str(Path(tempfile.gettempdir()) / 'animathema-code-workspace.png'))
        with page.expect_response(lambda r: r.url.endswith('/api/render/code')) as response:
            page.locator('#direct-code-draft').click()
        job_id = response.value.json()['id']
        expect(page.locator('.video-block')).to_have_count(1, timeout=60000)
        expect(page.locator('[data-mode="render"]')).to_have_class('active')
        result = client.get('/api/jobs/' + job_id).json()['result']
        assert result['scene_name'] == 'PastedScene'
        assert result['source'].startswith('custom_renders/') and result['height'] == 480
        script = workspace / result['script']
        assert script.stem.startswith('scene_20')
        assert script.read_text() == 'from manim import *\n' + CUSTOM_CODE
        assert any(item['source'] == result['source'] for item in client.get('/api/media').json())
        assert client.get(result['url'], headers={'Range':'bytes=0-127'}).status_code == 206

        # Custom-source clips use the existing post-processing controls unchanged.
        page.locator('#ruler').click(position={'x':13.6, 'y':10})
        page.locator('#split-clip').click()
        expect(page.locator('.video-block')).to_have_count(2)
        page.locator('[data-field="speed"][type="number"]').fill('2')
        page.locator('[data-field="speed"][type="number"]').press('Tab')
        page.locator('#crop-aspect').select_option('1:1')
        page.locator('#export-open').click()
        page.locator('#export-resolution').select_option('854,480')
        page.locator('#export-submit').click()
        expect(page.locator('#job-download')).to_be_visible(timeout=60000)
        assert page.locator('#job-status').inner_text() == 'completed'
        page.locator('#console-close').click()

        # The production button submits high quality and still selects the scene.
        page.locator('#code-workspace-toggle').click()
        expect(editor).to_have_value(CUSTOM_CODE)
        page.locator('#direct-code-scene').select_option('First')
        with page.expect_response(lambda r: r.url.endswith('/api/render/code')) as response:
            page.locator('#direct-code-production').click()
        production_id = response.value.json()['id']
        expect(page.locator('.video-block')).to_have_count(3, timeout=60000)
        production = client.get('/api/jobs/' + production_id).json()['result']
        assert production['width'] == 1920 and production['height'] == 1080
        assert production['scene_name'] == 'First'

        # Python runtime failures retain the standard live console traceback.
        page.locator('#code-workspace-toggle').click()
        editor.fill('class Failing(Scene):\n    def construct(self):\n        raise RuntimeError("DIRECT_CODE_QA_FAILURE")\n')
        page.locator('#direct-code-draft').click()
        expect(page.locator('#job-status')).to_have_text('failed', timeout=60000)
        expect(page.locator('#console-output')).to_contain_text('DIRECT_CODE_QA_FAILURE')
        expect(page.locator('.video-block')).to_have_count(3)
        page.locator('#console-close').click()
        page.locator('#direct-code-reset').click()
        expect(page.locator('#direct-code-status')).to_have_text('Synced with Visual Scene')
        expect(editor).to_have_value(__import__('re').compile('class AnimathemaScene'))

        page.set_viewport_size({'width':430,'height':900})
        assert page.evaluate('document.documentElement.scrollWidth') <= 430
        page.screenshot(path=str(Path(tempfile.gettempdir()) / 'animathema-code-mobile.png'), full_page=True)
        assert not errors, errors
        browser.close()
        print('Verified visual sync, custom draft protection, syntax errors, scene selection, clipboard/download, draft and production rendering, runtime tracebacks, NLE export, and responsive code layout.')


if __name__ == '__main__':
    with isolated_studio(include_workspace=True) as (url, workspace):
        verify(url, workspace)

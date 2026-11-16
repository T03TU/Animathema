"""Additive code-mode contracts and AST-only inspection; no project files modified."""
import ast
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from backend.app import app
from backend.code_editor import analyze_manim_code, select_scene
from backend.presets import demo
from backend.models import CodeRenderRequest


@pytest.mark.parametrize('base', [
    'Scene', 'ThreeDScene', 'MovingCameraScene', 'VectorScene', 'GraphScene',
    'ZoomedScene', 'LinearTransformationScene', 'SpecialThreeDScene',
])
def test_scene_bases_and_missing_import(base):
    original = f'# source stays intact\nclass Example({base}):\n    pass\n'
    result = analyze_manim_code(original)
    assert result['scenes'] == ['Example']
    assert result['import_added']
    assert result['code'] == 'from manim import *\n' + original


def test_existing_import_and_exact_source_preserved():
    code = 'from manim import *\n\nclass MyScene(Scene):\n    pass\n'
    result = analyze_manim_code(code)
    assert result['code'] == code and not result['import_added']


def test_aliases_qualified_bases_and_local_inheritance():
    code = '''import manim as mn
from manim.scene.scene import Scene as Base
class First(Base): pass
class Second(mn.ThreeDScene): pass
class Derived(First): pass
class Helper: pass
class FakeScene(Helper): pass
'''
    result = analyze_manim_code(code)
    assert result['scenes'] == ['First', 'Second', 'Derived']
    assert select_scene(result) == 'First'
    assert select_scene(result, 'Second') == 'Second'
    with pytest.raises(ValueError, match='was not found'):
        select_scene(result, 'Missing')


def test_nested_classes_are_not_cli_scenes():
    result = analyze_manim_code('class Helper:\n    class Nested(Scene): pass\n')
    assert not result['scenes']
    with pytest.raises(ValueError, match='No Manim scene'):
        select_scene(result)


def test_analysis_never_executes_user_source(tmp_path):
    marker = tmp_path / 'should_not_exist'
    result = analyze_manim_code(f'from pathlib import Path\nPath({str(marker)!r}).touch()\nclass SafeToInspect(Scene): pass\n')
    assert result['scenes'] == ['SafeToInspect']
    assert not marker.exists()


def test_import_insertion_preserves_docstring_and_future_imports():
    original = '# comment\n"""Module description."""\nfrom __future__ import annotations\n\nclass FutureScene(Scene): pass\n'
    result = analyze_manim_code(original)
    compile(result['code'], '<test>', 'exec')
    tree = ast.parse(result['code'])
    assert ast.get_docstring(tree) == 'Module description.'
    assert result['code'].replace('from manim import *\n', '', 1) == original
    assert result['code'].index('from __future__') < result['code'].index('from manim')


@pytest.mark.parametrize('source', ['class Bad(Scene)\n    pass\n', 'return 3\n'])
def test_detailed_syntax_errors_use_editor_coordinates(source):
    with TestClient(app) as client:
        for endpoint in ('/api/code/analyze', '/api/render/code'):
            response = client.post(endpoint, json={'code': source})
            assert response.status_code == 400
            data = response.json()
            assert data['diagnostic']['line'] == 1
            assert data['diagnostic']['column'] > 0
            assert data['diagnostic']['text'].strip() == source.splitlines()[0]
            assert 'column' in data['detail']


def test_custom_render_contract_and_validation():
    assert CodeRenderRequest(code='class A(Scene): pass').quality == 'low'
    with TestClient(app) as client:
        assert client.post('/api/render/code', json={'code':'pass', 'quality':'medium'}).status_code == 422
        assert client.post('/api/render/code', json={'code':'pass'}).status_code == 400
        assert client.post('/api/render/code', json={'code':'class A(Scene): pass', 'scene_name':'Other'}).status_code == 400
        response = client.post('/api/code/analyze', json={'code':'class A(Scene): pass\nclass B(ThreeDScene): pass'})
        assert response.json()['scenes'] == ['A', 'B']
        assert client.post('/api/render/code', json={'code':'class A(Scene): pass'}, headers={'Origin':'https://example.com'}).status_code == 403


def test_visual_source_endpoint_does_not_mutate_legacy_override():
    project = demo()
    project.code_override = 'class AnimathemaScene(Scene):\n    pass\n'
    with TestClient(app) as client:
        old = client.post('/api/compile', json=project.model_dump()).json()
        visual = client.post('/api/compile/visual', json=project.model_dump()).json()
    assert old['code'] == project.code_override
    assert 'obj_sine' in visual['code']
    assert project.code_override == 'class AnimathemaScene(Scene):\n    pass\n'

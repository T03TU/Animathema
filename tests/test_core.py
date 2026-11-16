"""Regression tests for compilation, local API boundaries and non-destructive editing."""
import ast
import asyncio
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from backend.app import app
from backend.models import Project, Mobject, Animation, Clip, Crop
from backend.presets import demo, OBJECTS
from backend.scene_compiler import compile_scene, expression, constructor
from backend.video_editor import split, media_path, tempo


def test_demo_is_standalone_and_timed():
    code = compile_scene(demo())
    ast.parse(code)
    assert 'class AnimathemaScene(ThreeDScene)' in code
    assert 'Succession(Wait(6.2)' in code
    assert 'lag_ratio=0' in code
    assert 'MathTex(' not in code


@pytest.mark.parametrize('kind',OBJECTS)
def test_all_presets_produce_python(kind):
    obj=Mobject(id='object',kind=kind,name=kind,params=OBJECTS[kind][2])
    ast.parse(constructor(obj),mode='eval')


@pytest.mark.parametrize('source',["__import__('os').system('echo bad')",'x.__class__','[1,2,3]','sin(x, y)','2**1000000','x**x','open(x)'])
def test_expression_rejects_code(source):
    with pytest.raises((ValueError,SyntaxError)):
        expression(source)


def test_math_expression_maps_names_without_corrupting_variables():
    assert expression('exp(x)+cos(x)')=='np.exp(x) + np.cos(x)'
    text=constructor(Mobject(id='v',kind='VectorField',name='v',params={'x_expression':'exp(x)','y_expression':'sin(y)'}))
    assert 'np.exp(x)' in text


def test_overlapping_same_object_is_actionable():
    p=demo()
    p.animations.append(Animation(id='overlap',kind='Rotate',object_id='sine',start=2,duration=1))
    with pytest.raises(ValueError,match='overlap'):
        compile_scene(p)


def test_hidden_objects_do_not_animate():
    p=demo();p.objects[1].visible=False
    code=compile_scene(p)
    assert 'Create(obj_sine' not in code


def test_split_preserves_speed_crop_and_exact_timing():
    c=Clip(id='clip',name='Test',source='renders/test.mp4',start=2,in_point=1,out_point=9,speed=2,crop=Crop(x=.1,y=.1,width=.8,height=.8))
    left,right=split(c,4)
    assert left.out_point==5
    assert right.in_point==5 and right.start==4
    assert left.duration+right.duration==c.duration
    assert right.crop==c.crop and right.speed==c.speed
    assert c.out_point==9
    with pytest.raises(ValueError):
        split(c,2)


def test_rejects_invalid_crop_and_media_paths():
    with pytest.raises(ValueError):Crop(x=.5,width=.8)
    for source in ('../../etc/passwd','/etc/passwd','project.json','renders/../project.json'):
        with pytest.raises(ValueError):media_path(source)
    assert tempo(4)=='atempo=2,atempo=2.0'
    assert tempo(.25)=='atempo=0.5,atempo=0.5'


def test_api_health_compilation_and_origin_protection():
    with TestClient(app) as client:
        assert client.get('/').status_code==200
        assert client.get('/api/health').json()['dependencies']
        assert client.post('/api/compile',json=demo().model_dump()).status_code==200
        assert client.post('/api/compile',json=demo().model_dump(),headers={'Origin':'https://example.com'}).status_code==403
        assert client.get('/api/health',headers={'Host':'evil.example'}).status_code==400
        assert client.post('/api/export',json={'project':demo().model_dump()}).status_code==400
        assert client.get('/api/jobs/missing').status_code==404


def test_invalid_project_is_not_accepted():
    p=demo().model_dump();p['objects'][0]['scale']=-1
    with TestClient(app) as client:
        assert client.post('/api/compile',json=p).status_code==422


def test_timing_group_cannot_pre_add_future_objects():
    code=compile_scene(demo())
    assert 'group=Group(), lag_ratio=0' in code
    assert 'obj_sine.set_fill(opacity=0)' in code


def test_hidden_latex_is_not_constructed_unless_used_as_target():
    p=Project(objects=[Mobject(id='hidden',kind='MathTex',name='Hidden equation',visible=False)])
    assert 'MathTex(' not in compile_scene(p)


def test_camera_and_anchored_graph_coordinates_compile():
    p=demo();p.camera.auto_3d=False;p.camera.phi=30;p.camera.zoom=1.5
    code=compile_scene(p)
    assert 'phi=30*DEGREES' in code and 'zoom=1.5' in code
    assert 'about_point=ORIGIN).shift(' in code


def test_replacement_uses_replacement_object_for_later_animation():
    p=Project(objects=[Mobject(id='a',kind='Circle',name='A'),Mobject(id='b',kind='Square',name='B')],animations=[Animation(id='replace',kind='ReplacementTransform',object_id='a',target_id='b',duration=1),Animation(id='rotate',kind='Rotate',object_id='a',start=2)])
    code=compile_scene(p)
    assert 'ReplacementTransform(obj_a, obj_b,' in code
    assert 'Rotate(obj_b,' in code


def test_project_defaults_are_returned_for_json_import():
    with TestClient(app) as client:
        data=client.post('/api/compile',json={'name':'Minimal scene'}).json()
        assert data['project']['objects']==[]
        assert data['project']['camera']['theta']==-90


def test_camera_turns_capture_current_value_when_animation_begins():
    p=Project(animations=[Animation(id='turn',kind='MoveCamera',start=1)])
    assert 'ApplyMethod(self.camera.theta_tracker.increment_value' in compile_scene(p)

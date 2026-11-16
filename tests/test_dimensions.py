"""Dimension state and camera compilation without changing legacy project behavior."""
import math
import pytest
from backend.models import Project, Camera, Mobject, Animation
from backend.scene_compiler import compile_scene, constructor


def test_explicit_2d_locks_camera_and_flattens_without_mutating_scene():
    p = Project(camera=Camera(dimension='2D', phi=70, theta=35, zoom=1.4,
                             frame_center=(2,3,4)), objects=[
        Mobject(id='axes',kind='ThreeDAxes',name='Axes',position=(1,2,3)),
        Mobject(id='vector',kind='Vector',name='Vector',params={'x':1,'y':2,'z':3}),
    ])
    code=compile_scene(p)
    assert 'phi=0.0*DEGREES, theta=-90.0*DEGREES, zoom=1.4' in code
    assert 'focal_distance=1000000, frame_center=ORIGIN' in code
    assert 'view_center = np.array([2.0, 3.0, 0])' in code
    assert 'obj_axes = Axes(' in code
    assert '.shift([1.0, 2.0, 0])' in code
    assert 'Vector([1.0, 2.0, 0])' in code
    assert p.objects[0].position == (1,2,3)
    assert p.camera.phi == 70


def test_3d_uses_user_angles_zoom_pan_and_upgrades_coordinate_axes():
    p=Project(camera=Camera(dimension='3D',auto_3d=True,phi=52,theta=23,zoom=1.7,
                           frame_center=(1,-2,3),focal_distance=25),
              objects=[Mobject(id='axes',kind='Axes',name='Space')])
    code=compile_scene(p)
    assert 'phi=52.0*DEGREES, theta=23.0*DEGREES, zoom=1.7' in code
    assert 'focal_distance=25.0, frame_center=ORIGIN' in code
    assert 'view_center = np.array([1.0, -2.0, 3.0])' in code
    assert 'obj_axes.shift(-view_center)' in code
    assert 'obj_axes = ThreeDAxes(' in code
    assert 'z_length=6' in code
    assert 'set_shade_in_3d(True)' in code


def test_orthographic_snap_and_fixed_overlay_registration():
    p=Project(camera=Camera(dimension='3D',projection='orthographic',phi=90,theta=0),
              objects=[Mobject(id='hud',kind='Text',name='Overlay',fixed_in_frame=True)],
              animations=[Animation(id='write',kind='Write',object_id='hud',start=2)])
    code=compile_scene(p)
    assert 'focal_distance=1000000' in code
    assert 'self.add_fixed_in_frame_mobjects(obj_hud)' in code
    assert 'self.remove(obj_hud)' in code
    assert 'self.add(obj_hud)' not in code


def test_legacy_camera_remains_compatible():
    p=Project(camera=Camera(phi=30,theta=-45,auto_3d=False))
    assert p.camera.dimension is None
    assert 'phi=30.0*DEGREES, theta=-45.0*DEGREES' in compile_scene(p)


@pytest.mark.parametrize('center',[(float('nan'),0,0),(0,float('inf'),0),(10001,0,0)])
def test_camera_center_requires_finite_bounded_coordinates(center):
    with pytest.raises(ValueError): Camera(frame_center=center)


def test_parametric_and_surface_depth_only_flatten_when_explicitly_2d():
    o=Mobject(id='curve',kind='ParametricFunction',name='Helix',params={'z_expression':'t'})
    assert ', t])' in constructor(o,'3D')
    assert ', 0])' in constructor(o,'2D')
    surface=Mobject(id='surface',kind='Surface',name='Surface')
    assert 'np.array([u,v,0])' in constructor(surface,'2D')

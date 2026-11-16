"""Lifecycle planning for repeated transforms, including returning to original shapes."""
import pytest
from backend.models import Project, Mobject, Animation, Clip
from backend.scene_compiler import _animation_lifecycles, compile_scene


def project(kind='Transform', same_source=False):
    return Project(objects=[Mobject(id='a',kind='Cube',name='Cube'),
                            Mobject(id='b',kind='Sphere',name='Sphere')],animations=[
        Animation(id=f'change{i}',kind=kind,object_id='a' if same_source or i%2==0 else 'b',
                  target_id='b' if i%2==0 else 'a',start=i*.5,duration=.3)
        for i in range(4)])


@pytest.mark.parametrize('kind',['Transform','ReplacementTransform'])
@pytest.mark.parametrize('same_source',[False,True])
def test_repeated_transforms_share_a_lifecycle_and_pristine_targets(kind,same_source):
    p=project(kind,same_source)
    initial,groups,replacements=_animation_lifecycles(p,p.animations)
    assert initial=={'a'}
    assert len(groups)==1
    blocks=next(iter(groups.values()))
    assert [a.target_id for a,*_ in blocks]==['b','a','b','a']
    assert [target for a,source,target,new in blocks]==['template_b','template_a','template_b','template_a']
    if kind=='ReplacementTransform':
        assert [source for a,source,target,new in blocks]==['obj_a','replacement_change0','replacement_change1','replacement_change2']
        assert len(replacements)==4
    else:
        assert all(source=='obj_a' for a,source,target,new in blocks)
    code=compile_scene(p)
    assert 'self.add(obj_a)' in code
    assert 'self.active_animation.clean_up_from_scene(self.scene)' in code


def test_explicitly_introduced_objects_keep_independent_lifecycles():
    p=project()
    p.animations=[Animation(id='intro_a',kind='Create',object_id='a',duration=.2),
                  Animation(id='intro_b',kind='Create',object_id='b',duration=.2),
                  Animation(id='swap_a',kind='Transform',object_id='a',target_id='b',start=.4,duration=.4),
                  Animation(id='swap_b',kind='Transform',object_id='b',target_id='a',start=.4,duration=.4)]
    initial,groups,_=_animation_lifecycles(p,p.animations)
    assert not initial
    assert len(groups)==2
    assert groups['a'][1][1]=='obj_a' and groups['b'][1][1]=='obj_b'


def test_overlapping_alias_animations_are_rejected():
    p=project()
    p.animations[1].start=.2
    with pytest.raises(ValueError,match='transformed object overlap'):
        compile_scene(p)


def test_render_link_is_optional_and_survives_splitting():
    from backend.video_editor import split
    c=Clip(id='clip',name='Render',source='renders/test.mp4',out_point=3,render_key='visual')
    a,b=split(c,1)
    assert a.render_key==b.render_key=='visual'
    assert Project().render_sources=={}

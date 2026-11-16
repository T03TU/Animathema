"""Compile a scene graph to standalone Manim CE Python, with concurrent timing."""
import ast
import json
import math
from .models import Project
from .presets import OBJECTS, ANIMATIONS

MATH_NAMES = {'sin','cos','tan','exp','sqrt','log','abs','sinh','cosh','tanh','arctan','arcsin','arccos','pi','e'}


def expression(source, variables=('x',)):
    """Accept mathematical expressions, never Python statements, accessors or imports."""
    source = str(source)
    if len(source) > 500:
        raise ValueError('Expressions must be under 500 characters.')
    tree = ast.parse(source, mode='eval')
    for node in ast.walk(tree):
        if not isinstance(node, (ast.Expression, ast.BinOp, ast.UnaryOp, ast.Call, ast.Name, ast.Load, ast.Constant, ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Pow, ast.Mod, ast.USub, ast.UAdd)):
            raise ValueError('Use arithmetic and math functions only (for example sin(x)).')
        if isinstance(node, ast.Name) and node.id not in MATH_NAMES | set(variables):
            raise ValueError(f'Unknown math name: {node.id}')
        if isinstance(node, ast.Call) and (not isinstance(node.func, ast.Name) or node.func.id not in MATH_NAMES - {'pi','e'} or node.keywords or len(node.args) != 1):
            raise ValueError('Math functions take one argument.')
        if isinstance(node, ast.Constant) and (type(node.value) not in (int,float) or abs(node.value) > 1e6):
            raise ValueError('Use finite numeric constants up to 1000000.')
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Pow):
            if not isinstance(node.right, ast.Constant) or abs(node.right.value) > 20:
                raise ValueError('Use a constant exponent between -20 and 20.')
    class NumpyNames(ast.NodeTransformer):
        def visit_Name(self, node):
            if node.id in MATH_NAMES and node.id != 'abs':
                return ast.copy_location(ast.Attribute(value=ast.Name(id='np', ctx=ast.Load()), attr=node.id, ctx=ast.Load()), node)
            return node
    return ast.unparse(NumpyNames().visit(tree))


def number(params, key, default, low=-10000, high=10000):
    n = float(params.get(key, default))
    if not math.isfinite(n) or not low <= n <= high:
        raise ValueError(f'{key} must be between {low} and {high}.')
    return n


def interval(p, a, b, da, db):
    lo, hi = number(p,a,da),number(p,b,db)
    if hi <= lo:
        raise ValueError(f'{b} must be greater than {a}.')
    return f'[{lo!r}, {hi!r}]'


def constructor(o, dimension=None):
    p, k = o.params, o.kind
    if k not in OBJECTS:
        raise ValueError(f'Unknown preset: {k}')
    n = lambda key, default, low=-10000, high=10000: number(p,key,default,low,high)
    text = repr(str(p.get('text','Hello mathematics'))[:2000])
    if k in ('Axes','NumberPlane','ThreeDAxes'):
        if dimension == '3D' and k == 'Axes':
            k = 'ThreeDAxes'
        elif dimension == '2D' and k == 'ThreeDAxes':
            k = 'Axes'
        z = ', z_range=[-3, 3, 1], z_length=6' if k == 'ThreeDAxes' else ''
        return f'{k}(x_range=[-6, 6, 1], y_range=[-3, 3, 1], x_length=12, y_length=6{z}, tips=False)'
    if k == 'FunctionGraph':
        return f'FunctionGraph(lambda x: {expression(p.get("expression","sin(x)"))}, x_range={interval(p,"x_min","x_max",-5,5)})'
    if k == 'ParametricFunction':
        xyz = ', '.join('0' if dimension == '2D' and key == 'z_expression' else expression(p.get(key,d),('t',)) for key,d in [('x_expression','2*cos(t)'),('y_expression','2*sin(t)'),('z_expression','0')])
        return f'ParametricFunction(lambda t: np.array([{xyz}]), t_range={interval(p,"t_min","t_max",0,6.283)})'
    if k == 'Surface':
        z = '0' if dimension == '2D' else expression(p.get('expression','sin(u)*cos(v)'),('u','v'))
        return f'Surface(lambda u,v: np.array([u,v,{z}]), u_range={interval(p,"u_min","u_max",-3,3)}, v_range={interval(p,"v_min","v_max",-3,3)}, resolution=(24,24))'
    if k == 'VectorField':
        x,y = expression(p.get('x_expression','-y/3'),('x','y')), expression(p.get('y_expression','x/3'),('x','y'))
        return f'ArrowVectorField(lambda p: (lambda x,y: np.array([{x}, {y}, 0]))(p[0],p[1]), x_range=[-5,5,1], y_range=[-3,3,1])'
    if k in ('Circle','Dot'):
        return f'{k}(radius={n("radius",1 if k=="Circle" else .08,.005,100)})'
    if k == 'Square':
        return f'Square(side_length={n("side_length",2,.01,100)})'
    if k == 'Cube':
        return f'Cube(side_length={n("side_length",2,.01,100)}, fill_opacity=0.7)'
    if k == 'Sphere':
        return f'Sphere(radius={n("radius",1,.01,100)}, resolution=(24,16))'
    if k == 'Polygon':
        return f'RegularPolygon(n={int(n("sides",3,3,30))}, radius={n("radius",1.3,.01,100)})'
    if k in ('Vector','Line'):
        end = [n('x',2),n('y',1),0 if dimension == '2D' else n('z',0)]
        return f'Vector({end!r})' if k=='Vector' else f'Line(ORIGIN, {end!r})'
    if k == 'Brace':
        return f'Brace(Line(LEFT*{n("width",3,.01,100)/2}, RIGHT*{n("width",3,.01,100)/2}), DOWN)'
    if k in ('Matrix','Table'):
        values = p.get('values', '[[1,0],[0,1]]')
        values = json.loads(values) if isinstance(values,str) else values
        if not isinstance(values,list) or not 1 <= len(values) <= 20 or any(not isinstance(row,list) or not 1 <= len(row) <= 20 for row in values) or len({len(r) for r in values}) != 1:
            raise ValueError('Enter a rectangular JSON array of up to 20 × 20 entries.')
        if any(type(v) not in (str,int,float) or len(str(v)) > 100 for row in values for v in row):
            raise ValueError('Matrix entries must be short text or numbers.')
        values = [[str(v) for v in row] for row in values]
        return f'Matrix({values!r})' if k=='Matrix' else f'Table({values!r}, include_outer_lines=True)'
    if k in ('Text','Title','MathTex'):
        fs = n('font_size',32,6,200)
        if k=='Title':
            return f'Text({text}, font_size={fs}, font="sans-serif")'  # Centered title, positioned by scene graph.
        return f'Text({text}, font_size={fs}, font="sans-serif")' if k=='Text' else f'{k}({text}, font_size={fs})'
    raise ValueError(f'No compiler for {k}')


def compile_scene(project: Project, *, use_override=True):
    if use_override and project.code_override is not None:
        ast.parse(project.code_override)
        if not any(isinstance(n,ast.ClassDef) and n.name=='AnimathemaScene' for n in ast.parse(project.code_override).body):
            raise ValueError('Edited code must define class AnimathemaScene.')
        return project.code_override
    visible = {o.id:o for o in project.objects if o.visible}
    animations = [a for a in project.animations if a.kind in ('Wait','MoveCamera','AmbientRotation') or a.object_id in visible]
    for a in animations:
        if a.kind not in ANIMATIONS:
            raise ValueError(f'Unknown animation: {a.kind}')
    # Simultaneous independent objects are supported; competing transforms are ambiguous.
    for oid in visible:
        blocks = sorted([a for a in animations if a.object_id==oid],key=lambda a:a.start)
        if any(b.start < a.start+a.duration-1e-6 for a,b in zip(blocks,blocks[1:])):
            raise ValueError(f'Animations on {visible[oid].name} overlap. Move them apart on the timeline.')
    camera = sorted([a for a in animations if a.kind in ('MoveCamera','AmbientRotation')],key=lambda a:a.start)
    if any(b.start<a.start+a.duration-1e-6 for a,b in zip(camera,camera[1:])):
        raise ValueError('Camera animations overlap. Move them apart on the timeline.')
    lines = ['# Generated by Animathema · edit or render with Manim Community Edition', 'from manim import *','import numpy as np','','','class AnimathemaScene(ThreeDScene):','    def construct(self):', f'        self.camera.background_color = {project.background!r}']
    dimension = project.camera.dimension
    auto = dimension is None and project.camera.auto_3d and any(o.visible and o.kind in ('Surface','ThreeDAxes','Cube','Sphere') for o in project.objects)
    phi,theta = (65,-45) if auto else (project.camera.phi,project.camera.theta)
    if dimension == '2D':
        phi,theta = 0.0,-90.0
    settings = ''
    if dimension is not None:
        focal = 1000000 if dimension == '2D' or project.camera.projection == 'orthographic' else project.camera.focal_distance
        center = list(project.camera.frame_center)
        if dimension == '2D':
            center[2] = 0
        settings = f', focal_distance={focal!r}, frame_center=ORIGIN'
    lines.append(f'        self.set_camera_orientation(phi={phi!r}*DEGREES, theta={theta!r}*DEGREES, zoom={project.camera.zoom!r}{settings})')
    if dimension is not None:
        lines.append('        # Center world geometry on the orbit target; keep HUD in screen space.')
        lines.append(f'        view_center = np.array({center!r})')
    required = set(visible) | {a.target_id for a in animations if a.target_id}
    for i,o in enumerate(project.objects):
        if o.id not in required:
            continue
        label = ' '.join(o.name.splitlines())
        lines.append(f'        # {label}: {o.kind}')
        lines.append(f'        obj_{o.id} = {constructor(o, dimension)}')
        lines.append(f'        obj_{o.id}.set_color({o.color!r}).set_stroke(width={o.stroke_width!r}).set_opacity({o.opacity!r})')
        if o.kind not in ('Dot','Text','Title','MathTex','Matrix','Table','Surface','Vector','VectorField','Cube','Sphere'):
            lines.append(f'        obj_{o.id}.set_fill(opacity=0)')
        position = list(o.position)
        if dimension == '2D':
            position[2] = 0
        if o.kind in ('Axes','NumberPlane','ThreeDAxes','FunctionGraph','ParametricFunction','Surface','VectorField','Vector','Line'):
            lines.append(f'        obj_{o.id}.scale({o.scale!r}, about_point=ORIGIN).shift({position!r}).set_z_index({i})')
        else:
            lines.append(f'        obj_{o.id}.scale({o.scale!r}).move_to({position!r}).set_z_index({i})')
        if dimension is not None and not o.fixed_in_frame:
            lines.append(f'        obj_{o.id}.shift(-view_center)')
        if o.fixed_in_frame:
            lines.append(f'        self.add_fixed_in_frame_mobjects(obj_{o.id})')
            lines.append(f'        self.remove(obj_{o.id})  # Keep scheduled introductions hidden until their start.')
        elif dimension == '3D':
            lines.append(f'        obj_{o.id}.set_shade_in_3d(True)')
    intro = {'Create','Write','FadeIn'}
    introduced = {a.object_id for a in animations if a.kind in intro}
    targets = {a.target_id for a in animations if a.kind in ('Transform','ReplacementTransform')}
    initial = [f'obj_{o.id}' for o in project.objects if o.visible and o.id not in introduced | targets]
    if initial:
        lines.append(f'        self.add({", ".join(initial)})')
    lines.extend(['','        # Each independent animation is delayed to its absolute timeline start.', '        timeline = []'])
    aliases = {o.id:f'obj_{o.id}' for o in project.objects}
    for a in sorted(animations,key=lambda a:a.start):
        kw = f'run_time={a.duration!r}, rate_func={a.easing}'
        obj = aliases.get(a.object_id, f'obj_{a.object_id}')
        if a.kind=='Wait':
            code = f'Wait({a.duration!r})'
        elif a.kind in ('MoveCamera','AmbientRotation'):
            # Animation of the camera tracker composes with normal Manim animations.
            code = f'ApplyMethod(self.camera.theta_tracker.increment_value, {a.angle!r} * DEGREES, {kw})'
        elif a.kind in ('Transform','ReplacementTransform'):
            target = aliases[a.target_id]
            code = f'{a.kind}({obj}, {target}' + ('.copy()' if a.kind=='Transform' else '') + f', {kw})'
            if a.kind=='ReplacementTransform':
                aliases[a.object_id] = target
        elif a.kind=='MoveAlongPath':
            code = f'MoveAlongPath({obj}, obj_{a.target_id}, {kw})'
        elif a.kind=='Rotate':
            code = f'Rotate({obj}, angle={a.angle!r} * DEGREES, {kw})'
        else:
            code = f'{a.kind}({obj}, {kw})'
        if a.start > 0:
            code = f'Succession(Wait({a.start!r}), {code})'
        lines.append(f'        timeline.append({code})')
    duration = max([project.duration]+[a.start+a.duration for a in animations])
    lines.extend([f'        timeline.append(Wait({duration!r}))','        self.play(AnimationGroup(*timeline, group=Group(), lag_ratio=0))',''])
    return '\n'.join(lines)

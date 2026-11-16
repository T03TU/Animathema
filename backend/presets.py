"""Preset metadata is shared by the shelf, property editor, compiler and demo."""
OBJECTS = {
    'Axes': ('Coordinates', '↗', {}),
    'NumberPlane': ('Coordinates', '▦', {}),
    'ThreeDAxes': ('Coordinates', '⤢', {}),
    'FunctionGraph': ('Plots', '∿', {'expression': 'sin(x)', 'x_min': -5, 'x_max': 5}),
    'ParametricFunction': ('Plots', '〰', {'x_expression': '2*cos(t)', 'y_expression': '2*sin(t)', 'z_expression': '0', 't_min': 0, 't_max': 6.283}),
    'Surface': ('Plots', '◈', {'expression': 'sin(u)*cos(v)', 'u_min': -3, 'u_max': 3, 'v_min': -3, 'v_max': 3}),
    'VectorField': ('Plots', '⇶', {'x_expression': '-y/3', 'y_expression': 'x/3'}),
    'Circle': ('Geometry', '○', {'radius': 1}),
    'Square': ('Geometry', '□', {'side_length': 2}),
    'Polygon': ('Geometry', '△', {'sides': 3, 'radius': 1.3}),
    'Vector': ('Geometry', '↗', {'x': 2, 'y': 1, 'z': 0}),
    'Line': ('Geometry', '╱', {'x': 2, 'y': 1}),
    'Dot': ('Geometry', '•', {'radius': .08}),
    'Brace': ('Geometry', '⏟', {'width': 3}),
    'Matrix': ('Algebra', '▤', {'values': '[[1, 0], [0, 1]]'}),
    'Table': ('Algebra', '▥', {'values': '[[1, 2], [3, 4]]'}),
    'MathTex': ('Typography', '∑', {'text': r'\sum_{n=0}^{\infty}\frac{x^n}{n!}', 'font_size': 42}),
    'Text': ('Typography', 'T', {'text': 'Mathematics in motion', 'font_size': 32}),
    'Title': ('Typography', 'T̲', {'text': 'A beautiful idea', 'font_size': 38}),
}
ANIMATIONS = ['Create', 'Write', 'FadeIn', 'FadeOut', 'Transform', 'ReplacementTransform', 'Indicate', 'MoveAlongPath', 'Rotate', 'MoveCamera', 'AmbientRotation', 'Wait']
LATEX = {
    'Integral': r'\int_a^b f(x)\,dx',
    'Summation': r'\sum_{n=0}^{\infty}\frac{x^n}{n!}',
    'Limit': r'\lim_{x\to 0}\frac{\sin x}{x}=1',
    'Derivative': r'\frac{d}{dx}x^n=nx^{n-1}',
}


def catalog():
    return {'objects': [{'kind': k, 'category': v[0], 'icon': v[1], 'params': v[2]} for k,v in OBJECTS.items()], 'animations': ANIMATIONS, 'latex': LATEX}


def demo():
    from .models import Project
    objects = [
        dict(id='axes', kind='Axes', name='Coordinate space', color='#475569', position=[0,-.5,0]),
        dict(id='sine', kind='FunctionGraph', name='sin(x)', color='#a78bfa', position=[0,-.5,0], params={'expression':'sin(x)', 'x_min':-5,'x_max':5}),
        dict(id='linear', kind='FunctionGraph', name='First order · x', color='#f5b65b', position=[0,-.5,0], params={'expression':'x','x_min':-3,'x_max':3}),
        dict(id='cubic', kind='FunctionGraph', name='Third order · x − x³/6', color='#5eead4', position=[0,-.5,0], params={'expression':'x-x**3/6','x_min':-3.4,'x_max':3.4}),
        dict(id='title',kind='Text',stroke_width=0,name='Scene title',position=[0,2.9,0],color='#e2e8f0',params={'text':'A little closer to sine.','font_size':34}),
        dict(id='subtitle',kind='Text',stroke_width=0,name='Series caption',position=[0,2.15,0],color='#94a3b8',params={'text':'Taylor series  /  around x = 0','font_size':17}),
    ]
    animations = [
        dict(id='a_axes',kind='Create',object_id='axes',start=0,duration=1.5,track=0),
        dict(id='a_title',kind='Write',object_id='title',start=.2,duration=1.3,track=1),
        dict(id='a_subtitle',kind='FadeIn',object_id='subtitle',start=1.2,duration=1,track=1),
        dict(id='a_sine',kind='Create',object_id='sine',start=1.7,duration=2,track=0),
        dict(id='a_linear',kind='Create',object_id='linear',start=4,duration=1.5,track=2),
        dict(id='a_cubic',kind='Create',object_id='cubic',start=6.2,duration=2,track=2),
        dict(id='a_indicate',kind='Indicate',object_id='cubic',start=9,duration=1.5,track=2,easing='there_and_back'),
    ]
    return Project(name='A little closer to sine',objects=objects,animations=animations)

"""Static inspection of editor source. Inspection never imports or executes user code."""
import ast


# Includes CE scene types and legacy scene names, whose availability is determined
# by the installed Manim version when rendering. Local subclasses are resolved too.
SCENE_BASES = {
    'Scene', 'ThreeDScene', 'MovingCameraScene', 'ZoomedScene', 'VectorScene',
    'LinearTransformationScene', 'GraphScene', 'SpecialThreeDScene',
    'SampleSpaceScene', 'ReconfigurableScene',
}


def analyze_manim_code(code: str):
    tree = ast.parse(code, filename='<editor>')
    # ast.parse alone accepts some invalid programs, such as a top-level return.
    # Compiling to a code object checks them without executing that object.
    try:
        compile(tree, '<editor>', 'exec', dont_inherit=True)
    except SyntaxError as error:
        # Errors detected from an AST (rather than parsing text) omit source text.
        if error.text is None and error.lineno:
            error.text = code.splitlines(keepends=True)[error.lineno - 1]
        raise
    names = set(SCENE_BASES)
    modules = set()
    has_manim_import = False
    for node in tree.body:
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name == 'manim' or alias.name.startswith('manim.'):
                    has_manim_import = True
                    modules.add(alias.asname or alias.name.split('.')[0])
        elif isinstance(node, ast.ImportFrom) and node.level == 0:
            if node.module == 'manim' or (node.module or '').startswith('manim.'):
                has_manim_import = True
                for alias in node.names:
                    if alias.name in SCENE_BASES:
                        names.add(alias.asname or alias.name)

    def is_scene_base(base):
        if isinstance(base, ast.Name):
            return base.id in names
        if isinstance(base, ast.Attribute) and base.attr in SCENE_BASES:
            root = base.value
            while isinstance(root, ast.Attribute):
                root = root.value
            return isinstance(root, ast.Name) and root.id in modules
        return False

    classes = [node for node in tree.body if isinstance(node, ast.ClassDef)]
    # A fixed point handles both direct and indirect local inheritance, including
    # multiple inheritance, without evaluating class bodies or annotations.
    found = set()
    while True:
        additions = {node.name for node in classes
                     if node.name not in found and any(is_scene_base(b) for b in node.bases)}
        if not additions:
            break
        found.update(additions)
        names.update(additions)
    scenes = list(dict.fromkeys(node.name for node in classes if node.name in found))
    prepared = code
    import_added = not has_manim_import
    if import_added:
        # Keep module docstrings and __future__ imports legal. All original text,
        # including comments and formatting, is otherwise retained verbatim.
        preamble_end = 0
        for index, node in enumerate(tree.body):
            if (index == 0 and isinstance(node, ast.Expr)
                    and isinstance(node.value, ast.Constant)
                    and isinstance(node.value.value, str)):
                preamble_end = node.end_lineno
            elif isinstance(node, ast.ImportFrom) and node.module == '__future__':
                preamble_end = node.end_lineno
            else:
                break
        lines = code.splitlines(keepends=True)
        prefix = ''.join(lines[:preamble_end])
        if prefix and not prefix.endswith(('\n', '\r')):
            prefix += '\n'
        prepared = prefix + 'from manim import *\n' + ''.join(lines[preamble_end:])
        # Also validate the actual execution source (e.g. unusual semicolon use
        # next to a future import must not silently produce invalid Python).
        compile(prepared, '<editor>', 'exec', dont_inherit=True)
    return {'code': prepared, 'scenes': scenes, 'import_added': import_added}


def select_scene(analysis, scene_name=None):
    scenes = analysis['scenes']
    if not scenes:
        raise ValueError('No Manim scene class found. Define a class inheriting from Scene, ThreeDScene, MovingCameraScene, or another Manim scene class.')
    if scene_name is not None and scene_name not in scenes:
        raise ValueError(f'Scene {scene_name!r} was not found. Available scenes: {", ".join(scenes)}.')
    return scene_name or scenes[0]


def syntax_diagnostic(error):
    return {
        'message': error.msg,
        'line': error.lineno,
        'column': error.offset,
        'end_line': error.end_lineno,
        'end_column': error.end_offset,
        'text': error.text,
    }

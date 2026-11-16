"""Validated, portable project format. Times are seconds; crop coordinates are normalized."""
import math
from typing import Literal
from pydantic import BaseModel, Field, ConfigDict, model_validator, field_validator


class Model(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)


class Mobject(Model):
    id: str = Field(pattern=r'^[a-zA-Z][a-zA-Z0-9_]{0,63}$')
    kind: str
    name: str = Field(max_length=120)
    position: tuple[float, float, float] = (0, 0, 0)
    scale: float = Field(default=1, ge=.01, le=100)
    color: str = Field(default='#a78bfa', pattern=r'^#[0-9a-fA-F]{6}$')
    stroke_width: float = Field(default=3, ge=0, le=30)
    opacity: float = Field(default=1, ge=0, le=1)
    visible: bool = True
    locked: bool = False
    fixed_in_frame: bool = False
    params: dict = Field(default_factory=dict)

    @field_validator('position')
    @classmethod
    def finite_position(cls, value):
        if any(not math.isfinite(n) or abs(n) > 10000 for n in value):
            raise ValueError('Position must be finite and within ±10000.')
        return value


class Animation(Model):
    id: str = Field(pattern=r'^[a-zA-Z][a-zA-Z0-9_]{0,63}$')
    kind: str
    object_id: str | None = None
    target_id: str | None = None
    start: float = Field(default=0, ge=0, le=3600)
    duration: float = Field(default=1, ge=.05, le=600)
    easing: Literal['smooth', 'linear', 'there_and_back', 'ease_in_sine', 'ease_out_sine'] = 'smooth'
    track: int = Field(default=0, ge=0, le=7)
    angle: float = Field(default=90, ge=-3600, le=3600)


class Crop(Model):
    x: float = Field(default=0, ge=0, le=1)
    y: float = Field(default=0, ge=0, le=1)
    width: float = Field(default=1, gt=0, le=1)
    height: float = Field(default=1, gt=0, le=1)

    @model_validator(mode='after')
    def bounds(self):
        if self.x + self.width > 1.000001 or self.y + self.height > 1.000001:
            raise ValueError('Crop must fit inside the source frame.')
        return self


class Clip(Model):
    id: str = Field(pattern=r'^[a-zA-Z][a-zA-Z0-9_]{0,63}$')
    name: str = Field(max_length=200)
    source: str = Field(max_length=500)
    start: float = Field(default=0, ge=0, le=3600)
    in_point: float = Field(default=0, ge=0, le=14400)
    out_point: float = Field(gt=0, le=14400)
    speed: float = Field(default=1, ge=.25, le=4)
    crop: Crop = Field(default_factory=Crop)

    @property
    def duration(self):
        return (self.out_point - self.in_point) / self.speed

    @model_validator(mode='after')
    def bounds(self):
        if self.out_point <= self.in_point:
            raise ValueError('Clip out point must follow its in point.')
        return self


class Camera(Model):
    phi: float = Field(default=0, ge=0, le=180)
    theta: float = Field(default=-90, ge=-360, le=360)
    zoom: float = Field(default=1, ge=.1, le=5)
    auto_3d: bool = True
    dimension: Literal['2D', '3D'] | None = None
    projection: Literal['perspective', 'orthographic'] = 'perspective'
    frame_center: tuple[float, float, float] = (0, 0, 0)
    focal_distance: float = Field(default=20, ge=1, le=1000)

    @field_validator('frame_center')
    @classmethod
    def finite_center(cls, value):
        if any(not math.isfinite(n) or abs(n) > 10000 for n in value):
            raise ValueError('Camera center must be finite and within ±10000.')
        return value


class Project(Model):
    version: Literal[1] = 1
    name: str = Field(default='Untitled scene', min_length=1, max_length=120)
    background: str = Field(default='#10131d', pattern=r'^#[0-9a-fA-F]{6}$')
    duration: float = Field(default=12, ge=.1, le=3600)
    fps: int = Field(default=30, ge=1, le=120)
    camera: Camera = Field(default_factory=Camera)
    objects: list[Mobject] = Field(default_factory=list, max_length=200)
    animations: list[Animation] = Field(default_factory=list, max_length=1000)
    clips: list[Clip] = Field(default_factory=list, max_length=200)
    code_override: str | None = Field(default=None, max_length=200000)

    @model_validator(mode='after')
    def references(self):
        all_ids = [o.id for o in self.objects] + [a.id for a in self.animations] + [c.id for c in self.clips]
        if len(set(all_ids)) != len(all_ids):
            raise ValueError('Every object, animation and clip must have a unique ID.')
        ids = {o.id for o in self.objects}
        for a in self.animations:
            if a.kind not in ('Wait', 'MoveCamera', 'AmbientRotation') and a.object_id not in ids:
                raise ValueError(f'{a.kind} references an unknown object.')
            if a.kind in ('Transform', 'ReplacementTransform', 'MoveAlongPath') and a.target_id not in ids:
                raise ValueError(f'{a.kind} needs a target object or path.')
        return self


class RenderRequest(Model):
    project: Project
    quality: Literal['draft', 'production'] = 'draft'


class ExportRequest(Model):
    project: Project
    width: int = Field(default=1920, ge=128, le=3840, multiple_of=2)
    height: int = Field(default=1080, ge=128, le=3840, multiple_of=2)
    fps: int = Field(default=30, ge=1, le=120)


class SplitRequest(Model):
    clip: Clip
    time: float = Field(ge=0)


class CodeSourceRequest(Model):
    code: str = Field(min_length=1, max_length=200000)


class CodeRenderRequest(CodeSourceRequest):
    scene_name: str | None = Field(default=None, max_length=200)
    quality: Literal['low', 'high'] = 'low'

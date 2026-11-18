"""Render the README hero: blender -b -P docs/assets/src/hero_scene.py -- --theme dark --out docs/assets/hero-dark.png"""
import argparse
import math
import os
import struct
import sys
import tempfile
import time
import zlib

import bpy
import numpy as np
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
ap = argparse.ArgumentParser()
ap.add_argument('--theme', choices=['dark', 'light'], default='dark')
ap.add_argument('--out', required=True)
ap.add_argument('--samples', type=int, default=96)
ap.add_argument('--preview', help='also write an 880 px wide copy here')
args = ap.parse_args(argv)

W, H = 2000, 1120
THEMES = {
    'dark': dict(bg='#0f1113', ink='#f2f1ec', muted='#9a9ea6', accent='#2dd4bf', pill_ink='#062421', dim='#6b717a',
                 slab='#1a1d21', lane_dim='#2a2f35', person='#d9d4c8', light=1.0, world=0.05),
    'light': dict(bg='#f5f4ef', ink='#15171a', muted='#5d636b', accent='#0d9488', pill_ink='#ffffff', dim='#8f949a',
                  slab='#c9c2b4', lane_dim='#b9b4a9', person='#2b2f36', light=0.5, world=0.05),
}
T = THEMES[args.theme]
FONT_DIR = 'C:/Windows/Fonts'


def srgb(h):
    h = h.lstrip('#')
    return [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]


def lin(h):
    return [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in srgb(h)]


def font(name):
    path = os.path.join(FONT_DIR, name)
    return bpy.data.fonts.load(path, check_existing=True) if os.path.exists(path) else None


bpy.ops.wm.read_factory_settings(use_empty=True)
main = bpy.context.scene
main.name = 'main'

# ---------------------------------------------------------------- materials
_mats = {}


def mat(name, color, rough=0.45, metal=0.0, emit=0.0, alpha=1.0, glass=False):
    key = (name, color, rough, metal, emit, alpha, glass)
    if key in _mats:
        return _mats[key]
    m = bpy.data.materials.new(name)
    try:
        m.use_nodes = True
    except AttributeError:
        pass
    p = m.node_tree.nodes.get('Principled BSDF')
    c = lin(color) + [1.0]
    p.inputs['Base Color'].default_value = c
    p.inputs['Roughness'].default_value = rough
    p.inputs['Metallic'].default_value = metal
    if emit:
        p.inputs['Emission Color'].default_value = c
        p.inputs['Emission Strength'].default_value = emit
    if glass:
        p.inputs['Transmission Weight'].default_value = 1.0
        p.inputs['Roughness'].default_value = 0.02
        p.inputs['IOR'].default_value = 1.45
    if alpha < 1:
        p.inputs['Alpha'].default_value = alpha
    m.diffuse_color = c
    _mats[key] = m
    return m


SHELL = mat('shell', '#ece9e2', 0.38)
SHELL_GHOST = mat('ghost', '#b8bcc2' if args.theme == 'dark' else '#7d838c', 0.5, alpha=0.32 if args.theme == 'dark' else 0.45)
FACE = mat('face', '#15181c', 0.18)
FACE_GHOST = mat('face_ghost', '#15181c', 0.3, alpha=0.3)
JOINT = mat('joint', '#3a3f46', 0.4, 0.3)
ACCENT = mat('accent', T['accent'], 0.35)
GLOW = mat('glow', T['accent'], 0.3, emit=6.0)
GLOW_DIM = mat('glow_dim', T['dim'], 0.3, emit=1.0, alpha=0.5)
GREEN = mat('green', '#22c55e', 0.3, emit=8.0)
PAPER = mat('paper', '#fbfaf6', 0.6, emit=0.15)
INK_LINE = mat('ink_line', '#7d838c', 0.6)
WOOD = mat('desk', '#3b4048' if args.theme == 'dark' else '#8a8174', 0.5)
METAL = mat('metal', '#2b3036', 0.35, 0.6)
SLAB = mat('slab', T['slab'], 0.85)
LANE = mat('lane', T['accent'], 0.4, emit=0.6)
LANE_DIM = mat('lane_dim', T['lane_dim'], 0.6)
GLASS = mat('glass', '#e6fbf7', glass=True)
PERSON = mat('person', T['person'], 0.45)
FOLDER = mat('folder', T['accent'], 0.4)


def finish(o, m, bevel=0.0, seg=4):
    o.data.materials.append(m)
    if bevel:
        b = o.modifiers.new('bevel', 'BEVEL')
        b.width = bevel
        b.segments = seg
        b.limit_method = 'ANGLE'
        b.harden_normals = False
    for poly in o.data.polygons:
        poly.use_smooth = True
    return o


def box(loc, size, m, bevel=0.04, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = bpy.context.object
    o.scale = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return finish(o, m, bevel)


def cyl(loc, r, depth, m, rot=(0, 0, 0), verts=40, bevel=0.0):
    bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=depth, location=loc, rotation=rot, vertices=verts)
    return finish(bpy.context.object, m, bevel, 3)


def sphere(loc, r, m, scale=(1, 1, 1)):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=r, location=loc, segments=40, ring_count=20)
    o = bpy.context.object
    o.scale = scale
    return finish(o, m)


def limb(p0, p1, r, m):
    p0, p1 = Vector(p0), Vector(p1)
    d = p1 - p0
    o = cyl((p0 + p1) / 2, r, d.length, m)
    o.rotation_mode = 'QUATERNION'
    o.rotation_quaternion = d.to_track_quat('Z', 'Y')
    return [o, sphere(p1, r * 1.45, m)]


def sheet(loc, rot, m=PAPER, size=(0.42, 0.56), lines=True):
    bpy.ops.mesh.primitive_plane_add(size=1, location=loc, rotation=rot)
    o = bpy.context.object
    o.scale = (size[0], size[1], 1)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    s = o.modifiers.new('solid', 'SOLIDIFY')
    s.thickness = 0.008
    finish(o, m)
    if lines:
        for i in range(4):
            w = size[0] * (0.7 if i % 2 else 0.55)
            ln = box((0, 0, 0), (w, 0.028, 0.004), INK_LINE, 0)
            ln.parent = o
            ln.location = (-(size[0] * 0.72 - w) / 2, size[1] * 0.3 - i * 0.09, 0.006)
    return o


# ---------------------------------------------------------------- characters
def robot(x, y, face=0.0, ghost=False, scale=1.0, arms=None, tie=False):
    """Build a robot standing on the floor at (x, y), facing -y rotated by `face` degrees."""
    shell, face_m = (SHELL_GHOST, FACE_GHOST) if ghost else (SHELL, FACE)
    root = bpy.data.objects.new('robot', None)
    main.collection.objects.link(root)
    parts = []
    parts += [cyl((-0.17, 0, 0.2), 0.085, 0.4, JOINT if not ghost else shell), cyl((0.17, 0, 0.2), 0.085, 0.4, JOINT if not ghost else shell)]
    parts += [box((-0.17, -0.04, 0.05), (0.22, 0.3, 0.1), shell, 0.04), box((0.17, -0.04, 0.05), (0.22, 0.3, 0.1), shell, 0.04)]
    parts.append(box((0, 0, 0.78), (0.78, 0.52, 0.78), shell, 0.16))
    parts.append(box((0, -0.262, 0.86), (0.42, 0.02, 0.2), face_m, 0.03))
    if not ghost:
        for i in range(3):
            parts.append(sphere((-0.11 + i * 0.11, -0.275, 0.86), 0.032, GLOW if i == 1 else ACCENT))
    parts.append(cyl((0, 0, 1.22), 0.1, 0.12, JOINT if not ghost else shell))
    parts.append(box((0, 0, 1.52), (0.74, 0.56, 0.54), shell, 0.18))
    parts.append(box((0, -0.27, 1.53), (0.56, 0.04, 0.36), face_m, 0.1))
    eye = GLOW_DIM if ghost else GLOW
    for ex in (-0.13, 0.13):
        e = cyl((ex, -0.3, 1.55), 0.055, 0.03, eye, rot=(math.pi / 2, 0, 0))
        e.scale = (1, 1.35, 1)
        parts.append(e)
    parts.append(cyl((0, 0, 1.88), 0.02, 0.2, JOINT if not ghost else shell))
    parts.append(sphere((0, 0, 2.0), 0.06, eye))
    if tie:
        parts.append(box((0, -0.27, 1.11), (0.1, 0.04, 0.08), ACCENT, 0.02))
        bpy.ops.mesh.primitive_cone_add(vertices=4, radius1=0.11, radius2=0.04, depth=0.42, location=(0, -0.275, 0.88), rotation=(0, 0, math.pi / 4))
        t = bpy.context.object
        t.scale = (1, 0.25, 1)
        t.rotation_euler = (math.pi, 0, math.pi / 4)
        parts.append(finish(t, ACCENT))
        parts.append(box((0.0, -0.268, 1.14), (0.5, 0.02, 0.05), FACE, 0.01))
    for side, target in (arms or {}).items():
        sx = -0.45 if side == 'l' else 0.45
        parts.append(sphere((sx, 0, 1.02), 0.1, JOINT if not ghost else shell))
        parts += limb((sx, 0, 1.02), target, 0.075, shell)
    if not arms:
        for sx in (-0.45, 0.45):
            parts.append(sphere((sx, 0, 1.02), 0.1, JOINT if not ghost else shell))
            parts += limb((sx, 0, 1.02), (sx * 1.12, -0.04, 0.5), 0.075, shell)
    for p in parts:
        p.parent = root
    root.location = (x, y, 0)
    root.rotation_euler = (0, 0, math.radians(face))
    root.scale = (scale,) * 3
    return root


def at(root, local):
    return root.matrix_world @ Vector(local)


# ---------------------------------------------------------------- stage
STAGE = (-7.7, -4.7, 7.7, 1.45)
GHOST_XY = [(-7.0 + i * 1.45, -3.75) for i in range(4)]
box(((STAGE[0] + STAGE[2]) / 2, (STAGE[1] + STAGE[3]) / 2, -0.15), (STAGE[2] - STAGE[0], STAGE[3] - STAGE[1], 0.3), SLAB, 0.12)

LANE_Y = -1.25
X_OPUS, X_FORK, X_LUNA, X_GROK, X_GATE, X_YOU = -6.5, -4.7, -2.4, 1.7, 4.4, 6.7


def strip(p0, p1, w, m, z=0.012):
    p0, p1 = Vector((*p0, z)), Vector((*p1, z))
    d = p1 - p0
    o = box((p0 + p1) / 2, (d.length + w, w, 0.02), m, 0.009)
    o.rotation_euler = (0, 0, math.atan2(d.y, d.x))
    return o


strip((X_OPUS + 0.6, LANE_Y), (X_YOU - 0.5, LANE_Y), 0.14, LANE)
for gx, gy in GHOST_XY:
    strip((X_FORK, LANE_Y), (gx, gy + 0.5), 0.06, LANE_DIM)
cyl((X_FORK, LANE_Y, 0.03), 0.2, 0.06, ACCENT)
cyl((X_FORK, LANE_Y, 0.07), 0.1, 0.04, GLOW)

# Opus: podium, tie, pointing at the lane
opus = robot(X_OPUS, 0.55, face=12, tie=True, arms={'r': (1.05, -0.35, 1.45), 'l': (-0.3, -0.62, 1.2)})
box((X_OPUS + 0.05, -0.25, 0.4), (1.1, 0.62, 0.8), WOOD, 0.06)
box((X_OPUS + 0.05, -0.565, 0.62), (0.9, 0.02, 0.1), ACCENT, 0.01)
for i in range(4):
    sheet((X_OPUS + 0.05 + i * 0.01, -0.25, 0.81 + i * 0.012), (0, 0, math.radians(8 * i - 6)), lines=False)
for i, t in enumerate((0.15, 0.42, 0.7)):
    x = X_OPUS + 0.9 + (X_FORK - X_OPUS - 0.6) * t * 1.6
    sheet((x, LANE_Y + 0.25 - t * 0.2, 1.3 - abs(t - 0.4) * 1.2), (math.radians(68), math.radians(-10 + 14 * i), math.radians(-8 + 10 * i)))

# optional workers: ghosts on the branches
GHOSTS = []
for gx, gy in GHOST_XY:
    GHOSTS.append(robot(gx, gy, ghost=True, scale=0.62))
    bpy.ops.mesh.primitive_torus_add(major_radius=0.42, minor_radius=0.025, location=(gx, gy, 0.02))
    finish(bpy.context.object, LANE_DIM)

# Luna: desk + typewriter
DESK_Z = 0.82
box((X_LUNA, -0.15, DESK_Z), (1.9, 0.95, 0.08), WOOD, 0.03)
for dx in (-0.85, 0.85):
    for dy in (-0.52, 0.22):
        cyl((X_LUNA + dx, -0.15 + dy, DESK_Z / 2), 0.04, DESK_Z, METAL)
tw = (X_LUNA - 0.05, -0.32)
box((tw[0], tw[1], DESK_Z + 0.14), (0.95, 0.62, 0.22), METAL, 0.06)
box((tw[0], tw[1] - 0.17, DESK_Z + 0.2), (0.86, 0.32, 0.06), FACE, 0.02, rot=(math.radians(-14), 0, 0))
for r in range(3):
    for k in range(8):
        cyl((tw[0] - 0.33 + k * 0.095, tw[1] - 0.29 + r * 0.085, DESK_Z + 0.215 + r * 0.022), 0.032, 0.03, SHELL)
cyl((tw[0], tw[1] + 0.2, DESK_Z + 0.33), 0.08, 1.05, FACE, rot=(0, math.pi / 2, 0))
for sx in (-0.56, 0.56):
    cyl((tw[0] + sx, tw[1] + 0.2, DESK_Z + 0.33), 0.1, 0.06, ACCENT, rot=(0, math.pi / 2, 0))
sheet((tw[0], tw[1] + 0.3, DESK_Z + 0.5), (math.radians(62), 0, 0), size=(0.5, 0.42))
luna = robot(X_LUNA, 0.62, arms={'l': (-0.28, -0.75, 1.06), 'r': (0.24, -0.75, 1.06)})
for i in range(3):
    sheet((X_LUNA + 0.72, -0.2, DESK_Z + 0.05 + i * 0.012), (0, 0, math.radians(-10 + 7 * i)), lines=False)
for i, t in enumerate((0.2, 0.5, 0.8)):
    x = X_LUNA + 0.9 + (X_GROK - X_LUNA - 1.5) * t
    sheet((x, LANE_Y + 0.3, 1.45 - abs(t - 0.5) * 1.0), (math.radians(70), math.radians(8 - 10 * i), math.radians(10 - 8 * i)))

# Grok: holds the sheet in one hand and a magnifier in front of it in the other
grok = robot(X_GROK, 0.4, face=-22, arms={'r': (0.15, -0.78, 0.68), 'l': (-0.38, -0.55, 1.02)})


def held(o):
    o.parent = grok
    return o


held(sheet((-0.1, -0.6, 1.17), (math.radians(80), 0, 0), size=(0.5, 0.6)))
LENS = Vector((0.0, -0.88, 1.17))
bpy.ops.mesh.primitive_torus_add(major_radius=0.25, minor_radius=0.03, location=LENS, rotation=(math.radians(80), 0, 0))
held(finish(bpy.context.object, ACCENT))
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.235, location=LENS, rotation=(math.radians(80), 0, 0), segments=48, ring_count=24)
lens_glass = bpy.context.object
lens_glass.scale = (1, 1, 0.22)
held(finish(lens_glass, GLASS))
for part in limb((0.03, -0.87, 0.9), (0.12, -0.8, 0.66), 0.04, FACE) + [cyl((0.02, -0.88, 0.9), 0.034, 0.07, ACCENT)]:
    held(part)

# findings return path: a dashed lane from Grok back to Opus's podium
RET_Y = LANE_Y + 0.42
x = X_GROK - 0.5
while x > X_OPUS + 0.75:
    strip((x, RET_Y), (max(x - 0.22, X_OPUS + 0.75), RET_Y), 0.07, LANE)
    x -= 0.38
strip((X_GROK - 0.25, 0.05), (X_GROK - 0.5, RET_Y), 0.07, LANE)
bpy.ops.mesh.primitive_cone_add(vertices=3, radius1=0.17, depth=0.03, location=(X_OPUS + 0.62, RET_Y, 0.02), rotation=(0, 0, math.pi))
finish(bpy.context.object, LANE)

# Gate: a sign with a lit check mark and an open barrier
GB = Vector((X_GATE, LANE_Y + 0.85, 0))
cyl(GB + Vector((0, 0.05, 0.9)), 0.06, 1.8, METAL)
box(GB + Vector((0, 0, 2.05)), (1.15, 0.1, 0.85), FACE, 0.06)
box(GB + Vector((0, -0.02, 2.05)), (1.25, 0.08, 0.95), METAL, 0.06)
check = [Vector(v) for v in ((-0.3, -0.07, 2.07), (-0.08, -0.07, 1.84), (0.32, -0.07, 2.3))]
for a, b in zip(check, check[1:]):
    limb(GB + a, GB + b, 0.06, GREEN)
sphere(GB + check[0], 0.087, GREEN)
house = Vector((X_GATE, LANE_Y - 0.8, 0))
box(house + Vector((0, 0, 0.45)), (0.36, 0.36, 0.9), METAL, 0.06)
sphere(house + Vector((0, -0.19, 0.75)), 0.07, GREEN)
for k in range(5):
    p0 = house + Vector((0, 0, 0.92)) + Vector((0.12, 0, 0.3)) * k
    limb(p0, p0 + Vector((0.12, 0, 0.3)), 0.05, ACCENT if k % 2 else SHELL)

# You: a stylised person holding the hand-off folder
SKIN = mat('skin', '#d6a27c', 0.5)
HAIR = mat('hair', '#3a2a22', 0.6)
PANTS = mat('pants', '#55606d' if args.theme == 'dark' else '#3f4652', 0.6)
you = bpy.data.objects.new('you', None)
main.collection.objects.link(you)
body = []
for sx in (-0.13, 0.13):
    body += [box((sx, -0.05, 0.05), (0.18, 0.32, 0.1), FACE, 0.04), cyl((sx, 0, 0.5), 0.085, 0.8, PANTS)]
body.append(box((0, 0, 0.9), (0.44, 0.28, 0.2), PANTS, 0.08))
body.append(box((0, 0, 1.2), (0.62, 0.36, 0.68), PERSON, 0.16))
bpy.ops.mesh.primitive_torus_add(major_radius=0.13, minor_radius=0.045, location=(0, 0, 1.55))
body.append(finish(bpy.context.object, PERSON))
body.append(cyl((0, 0, 1.58), 0.07, 0.14, SKIN))
body.append(sphere((0, 0, 1.82), 0.22, SKIN, (1, 1, 1.08)))
body.append(sphere((0, 0.03, 1.88), 0.23, HAIR, (1.02, 1.0, 0.86)))
for ex in (-0.075, 0.075):
    body.append(sphere((ex, -0.2, 1.8), 0.025, FACE))
for sx, hand in ((-0.33, (-0.2, -0.38, 1.1)), (0.33, (0.2, -0.38, 1.1))):
    elbow = (sx * 1.05, -0.12, 1.08)
    body += [sphere((sx, 0, 1.42), 0.09, PERSON)] + limb((sx, 0, 1.42), elbow, 0.07, PERSON) + limb(elbow, hand, 0.06, PERSON)
    body.append(sphere(hand, 0.07, SKIN))
body.append(box((0, -0.44, 1.14), (0.52, 0.06, 0.4), FOLDER, 0.03, rot=(math.radians(-12), 0, 0)))
body.append(box((0, -0.47, 1.12), (0.4, 0.02, 0.05), PAPER, 0.01, rot=(math.radians(-12), 0, 0)))
for o in body:
    o.parent = you
you.location = (X_YOU, 0.1, 0)
you.rotation_euler = (0, 0, math.radians(-25))

# ---------------------------------------------------------------- camera and light
cam_data = bpy.data.cameras.new('cam')
cam_data.type = 'ORTHO'
cam = bpy.data.objects.new('cam', cam_data)
main.collection.objects.link(cam)
cam.rotation_euler = (math.radians(62), 0, math.radians(8))
main.camera = cam
FIT_BOTTOM, FIT_SIDE = 1096, 190
rot = cam.rotation_euler.to_matrix()
pts = [rot.transposed() @ Vector((x, y, z)) for x in STAGE[0::2] for y in STAGE[1::2] for z in (-0.3, 0)]
xs, ys = [p.x for p in pts], [p.y for p in pts]
upp = (max(xs) - min(xs)) / (W - 2 * FIT_SIDE)
cam_data.ortho_scale = upp * W
centre = Vector(((max(xs) + min(xs)) / 2, min(ys) + (FIT_BOTTOM - H / 2) * upp, 40))
cam.location = rot @ centre


def area(loc, energy, size, color='#ffffff'):
    d = bpy.data.lights.new('l', 'AREA')
    d.energy = energy * T['light']
    d.size = size
    d.color = lin(color)
    o = bpy.data.objects.new('l', d)
    main.collection.objects.link(o)
    o.location = loc
    o.rotation_euler = (Vector((0, 0.5, 0.8)) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()


area((-7, -9, 12), 5200, 10, '#fff4e6')
area((9, -6, 7), 1800, 8, '#e6f3ff')
area((0, 10, 9), 2200, 12)

world = bpy.data.worlds.new('w')
main.world = world
try:
    world.use_nodes = True
except AttributeError:
    pass
bg_node = world.node_tree.nodes.get('Background')
bg_node.inputs['Color'].default_value = lin(T['bg']) + [1]
bg_node.inputs['Strength'].default_value = T['world'] * 10

r = main.render
r.engine = 'CYCLES'
r.resolution_x, r.resolution_y, r.resolution_percentage = W, H, 100
r.film_transparent = True
r.image_settings.file_format = 'PNG'
r.image_settings.color_mode = 'RGBA'
main.view_settings.view_transform = 'Standard'
main.cycles.samples = args.samples
main.cycles.use_denoising = True
prefs = bpy.context.preferences.addons['cycles'].preferences
for kind in ('OPTIX', 'CUDA'):
    try:
        prefs.compute_device_type = kind
        prefs.get_devices()
        if any(d.type == kind for d in prefs.devices):
            for d in prefs.devices:
                d.use = d.type == kind
            main.cycles.device = 'GPU'
            break
    except TypeError:
        continue

# ---------------------------------------------------------------- 2D overlay
def px(p):
    v = world_to_camera_view(main, cam, Vector(p))
    return v.x * W, (1 - v.y) * H


ov = bpy.data.scenes.new('overlay')
ov.render.engine = 'BLENDER_WORKBENCH'
ov.render.resolution_x, ov.render.resolution_y, ov.render.resolution_percentage = W, H, 100
ov.render.film_transparent = True
ov.display.shading.light = 'FLAT'
ov.display.shading.color_type = 'MATERIAL'
ov.display.render_aa = '32'
ov.view_settings.view_transform = 'Standard'
ocd = bpy.data.cameras.new('ocam')
ocd.type = 'ORTHO'
ocd.ortho_scale = W
ocam = bpy.data.objects.new('ocam', ocd)
ov.collection.objects.link(ocam)
ocam.location = (W / 2, -H / 2, 50)
ov.camera = ocam
_z = [1.0]


def flat(color):
    return mat('flat' + color, color)


def text(s, x, y, size, color, fnt, align='LEFT', track=1.0, wrap=None):
    cu = bpy.data.curves.new('t', 'FONT')
    cu.body = s
    if fnt:
        cu.font = fnt
    cu.size = size
    cu.align_x = align
    cu.space_character = track
    if wrap:
        cu.text_boxes[0].width = wrap
        cu.space_line = 1.08
    o = bpy.data.objects.new('t', cu)
    o.data.materials.append(flat(color))
    ov.collection.objects.link(o)
    _z[0] += 0.01
    o.location = (x, -y, _z[0])
    return o


def width(o):
    bpy.context.view_layer.update()
    ev = o.evaluated_get(bpy.context.evaluated_depsgraph_get())
    return ev.dimensions.x


def rrect(x, y, w, h, color, r=None):
    bpy.ops.mesh.primitive_plane_add(size=1)
    o = bpy.context.object
    bpy.context.collection.objects.unlink(o)
    ov.collection.objects.link(o)
    o.scale = (w, h, 1)
    o.data.transform(o.matrix_basis)
    o.scale = (1, 1, 1)
    b = o.modifiers.new('r', 'BEVEL')
    b.affect = 'VERTICES'
    b.width = min(r if r is not None else h / 2, w / 2, h / 2) - 0.01
    b.segments = 10
    o.data.materials.append(flat(color))
    _z[0] += 0.01
    o.location = (x + w / 2, -(y + h / 2), _z[0])
    return o


F_SANS = font('segoeui.ttf')
F_SEMI = font('seguisb.ttf')
F_BOLD = font('segoeuib.ttf')
F_BLACK = font('seguibl.ttf')
F_MONO = font('CascadiaMono.ttf')


def pill(label, cx, cy, arrow=None):
    t = text(label, 0, 0, 25, T['pill_ink'], F_BOLD, track=1.12)
    w = width(t) + 44 + (24 if arrow else 0)
    x0 = cx - w / 2
    rrect(x0, cy - 21, w, 42, T['accent'])
    tx = x0 + 22 + (24 if arrow == 'left' else 0)
    t.location = (tx, -(cy + 9), _z[0] + 0.01)
    if arrow:
        text('>' if arrow == 'right' else '<', x0 + w - 30 if arrow == 'right' else x0 + 18, cy + 9, 25, T['pill_ink'], F_BOLD)
    return t


def name_card(cx, top, role, name):
    text(role, cx, top - 4, 23, T['accent'], F_MONO, 'CENTER', 1.2)
    text(name, cx, top + 50, 46, T['ink'], F_BLACK, 'CENTER')


# header (same copy as before)
text('conduct', 186, 124, 54, T['ink'], F_BOLD)
for (cx, cy, r, c) in ((112, 104, 10, T['accent']), (152, 86, 6, T['ink']), (152, 104, 6, T['ink']), (152, 122, 6, T['ink'])):
    rrect(cx - r, cy - r, 2 * r, 2 * r, c)
for (x1, y1) in ((152, 86), (152, 104), (152, 122)):
    dx, dy = x1 - 112, y1 - 104
    ln = rrect(112, 104 - 2.5, math.hypot(dx, dy), 5, T['accent'])
    ln.data.transform(__import__('mathutils').Matrix.Translation((-math.hypot(dx, dy) / 2, 0, 0)))
    ln.location = (112, -104, ln.location.z - 0.05)
    ln.rotation_euler = (0, 0, -math.atan2(dy, dx))
text('CLAUDE CODE SKILL · MIT', 1900, 116, 30, T['muted'], F_MONO, 'RIGHT', 1.36)
text('One model plans.', 96, 236, 104, T['ink'], F_BLACK, track=0.97)
o = text('Other vendors', 96, 342, 104, T['accent'], F_BLACK, track=0.97)
text('build.', 96 + width(o) + 28, 342, 104, T['ink'], F_BLACK, track=0.97)
text('A vendor other than the builder writes the acceptance gate before any code exists. Cross-vendor review checks the diff, then you merge.',
     1290, 216, 32, T['muted'], F_SANS, wrap=610)
text('EXAMPLE TEAM · ANY VENDOR CAN TAKE A ROLE', 100, 420, 27, T['ink'], F_MONO, track=1.27)
text('THE CONDUCTOR NEVER WRITES CODE', 1900, 420, 27, T['accent'], F_MONO, 'RIGHT', 1.27)

# scene labels, anchored to projected 3D points
LABEL_GAP = 24
for root, role, name in ((opus, 'CONDUCTOR · ANTHROPIC', 'Opus 5.5'), (luna, 'WORKER · OPENAI', 'GPT Luna'),
                         (grok, 'REVIEWER · XAI', 'Grok')):
    hx, hy = px(at(root, (0, 0, 2.1)))
    name_card(hx, hy - 76, role, name)
gx, gy = px(GB + Vector((0, 0, 2.55)))
text('GATE', gx, gy - 70, 38, T['ink'], F_BLACK, 'CENTER')
text('written first by Grok', gx, gy - 36, 26, T['muted'], F_SANS, 'CENTER')
yx, yy = px(at(you, (0, 0, 1.85)))
text('OPERATOR', yx, yy - 98, 23, T['muted'], F_MONO, 'CENTER', 1.25)
text('You', yx, yy - 44, 46, T['ink'], F_BLACK, 'CENTER')
for g, n in zip(GHOSTS, ('DeepSeek', 'GLM', 'OpenRouter', '+ any CLI')):
    nx, ny = px(at(g, (0, -0.75, 0)))
    text(n, nx, ny + 26, 28, T['muted'], F_SEMI, 'CENTER')
lx, ly = px((GHOST_XY[-1][0] + 0.9, GHOST_XY[-1][1], 0.4))
text('OPTIONAL WORKERS · PLUG IN', lx, ly, 25, T['muted'], F_MONO, 'LEFT', 1.2)

for label, wx, arrow in (('BRIEF', (X_FORK + X_LUNA) / 2 - 0.3, 'right'), ('DIFF', (X_LUNA + X_GROK) / 2 + 0.6, 'right'),
                         ('HAND-OFF', (X_GATE + X_YOU) / 2 + 0.1, 'right')):
    cx, cy = px((wx, LANE_Y, 0))
    pill(label, cx, cy, arrow)
fx, fy = px((X_LUNA + 1.2, RET_Y, 0))
pill('FINDINGS', fx, fy - 4, 'left')

# ---------------------------------------------------------------- render + compose
t0 = time.time()
tmp = tempfile.mkdtemp()


def render(scene, name):
    path = os.path.join(tmp, name + '.png')
    scene.render.filepath = path
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    bpy.ops.render.render(write_still=True, scene=scene.name)
    img = bpy.data.images.load(path)
    a = np.empty(W * H * 4, np.float32)
    img.pixels.foreach_get(a)
    return a.reshape(H, W, 4)


scene_px = render(main, 'scene')
t_scene = time.time() - t0
over_px = render(ov, 'overlay')

yy, xx = np.mgrid[0:H, 0:W]
yy = H - 1 - yy
out = np.zeros((H, W, 4), np.float32)
out[..., :3] = srgb(T['bg'])
glow = np.exp(-(((xx - 1000) / 900) ** 2 + ((yy - 860) / 330) ** 2))[..., None]
out[..., :3] += (np.array(srgb(T['accent'])) - out[..., :3]) * glow * (0.07 if args.theme == 'dark' else 0.05)
for layer in (scene_px, over_px):
    a = layer[..., 3:4]
    out[..., :3] = layer[..., :3] * a + out[..., :3] * (1 - a)
R = 56
cx = np.clip(xx, R, W - 1 - R)
cy = np.clip(yy, R, H - 1 - R)
dist = np.hypot(xx - cx, yy - cy)
out[..., 3] = np.clip(R + 0.5 - dist, 0, 1)
out = np.round(np.clip(out, 0, 1) * 255) / 255


def palette_png(rgba, path, colors=256, seed=7):
    """Write an 8-bit palette PNG (k-means palette), since Blender's own PNG writer has no quantizer."""
    flat = rgba.reshape(-1, 4).astype(np.float32)
    rng = np.random.default_rng(seed)
    sample = flat[rng.choice(len(flat), 120000, replace=False)]
    pal = sample[rng.choice(len(sample), colors, replace=False)]

    def nearest(px_):
        out_ = np.empty(len(px_), np.int64)
        for k in range(0, len(px_), 65536):
            c = px_[k:k + 65536]
            d = (c * c).sum(1)[:, None] - 2 * c @ pal.T + (pal * pal).sum(1)[None]
            out_[k:k + 65536] = d.argmin(1)
        return out_

    for _ in range(12):
        idx = nearest(sample)
        for j in range(colors):
            members = sample[idx == j]
            pal[j] = members.mean(0) if len(members) else sample[rng.integers(len(sample))]
    pal = np.clip(np.round(pal), 0, 255)
    rows = nearest(flat).astype(np.uint8).reshape(rgba.shape[:2])
    raw = b''.join(bytes(1) + r.tobytes() for r in rows)

    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data))

    pal8 = pal.astype(np.uint8)
    with open(path, 'wb') as f:
        f.write(bytes.fromhex('89504e470d0a1a0a'))
        f.write(chunk(b'IHDR', struct.pack('>IIBBBBB', rgba.shape[1], rgba.shape[0], 8, 3, 0, 0, 0)))
        f.write(chunk(b'PLTE', pal8[:, :3].tobytes()))
        f.write(chunk(b'tRNS', pal8[:, 3].tobytes()))
        f.write(chunk(b'IDAT', zlib.compress(raw, 9)))
        f.write(chunk(b'IEND', b''))


palette_png(np.flipud(np.round(out * 255)).astype(np.uint8), os.path.abspath(args.out))
if args.preview:
    img = bpy.data.images.new('preview', W, H, alpha=True)
    img.pixels.foreach_set(out.ravel())
    img.scale(880, round(880 * H / W))
    img.filepath_raw = os.path.abspath(args.preview)
    img.file_format = 'PNG'
    img.save()
print(f'HERO {args.theme}: scene {t_scene:.1f}s, total {time.time() - t0:.1f}s, {os.path.getsize(args.out) // 1024} KB')

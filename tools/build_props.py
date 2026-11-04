"""Build game-ready prop images from sliced sheets (tools/slice_props.py output).
Each prop is resized to 2x its on-screen height (crisp on retina, drawn at 0.5), quantized to a 256-colour PNG,
and listed in data/props.json as { id: { h: display height px, w: display width px } }.
Usage: python3 -I tools/build_props.py SLICE_DIR"""
import sys, json, os
from PIL import Image, ImageEnhance

SLICES = sys.argv[1]
# id: (slice file, on-screen height)
PROPS = {
    # meadow sheet
    'rock_big': ('mead_00', 70), 'rock_mid': ('mead_01', 54), 'rock_small': ('mead_02', 40), 'rock_spire': ('mead_03', 96),
    'oak_a': ('mead_04', 122), 'oak_b': ('mead_05', 118), 'pine': ('mead_06', 128),
    'bush_white': ('mead_07', 40), 'bush_pink': ('mead_08', 40),
    'grass_a': ('mead_09', 22), 'grass_b': ('mead_17', 22), 'grass_c': ('mead_25', 20), 'grass_fl1': ('mead_10', 24), 'grass_fl2': ('mead_11', 24),
    'fl_white': ('mead_12', 22), 'fl_pink': ('mead_13', 22), 'fl_purple': ('mead_14', 22), 'fl_yellow': ('mead_15', 24),
    'fb_white': ('mead_21', 26), 'fb_pink': ('mead_22', 26), 'fb_blue': ('mead_23', 28), 'fb_mix': ('mead_24', 28),
    'mush_big': ('mead_16', 34), 'mush_red': ('mead_18', 24), 'mush_small': ('mead_19', 22), 'mush_orange': ('mead_20', 20),
    # town sheet
    'house_tree': ('town_00', 250), 'house_blue': ('town_01', 196), 'house_vine': ('town_02', 192), 'house_mill': ('town_03', 214),
    'banner': ('town_04', 82), 'sign_board': ('town_06', 58), 'lamp': ('town_07', 62), 'stall_blue': ('town_08', 96), 'stall_red': ('town_09', 96),
    'signpost': ('town_10', 64), 'well': ('town_11', 84), 'bench': ('town_17', 26), 'garden': ('town_19', 58), 'flower_bush': ('town_20', 42),
    'tent': ('town_21', 104), 'crate': ('town_22', 30), 'cart': ('town_23', 40), 'hay_crates': ('town_26', 50), 'pot_stand': ('town_27', 62),
    'stool': ('town_28', 24), 'stump_axe': ('town_29', 34), 'barrel_stone': ('town_33', 46),
    # snow + desert sheet (sliced with dilate 0: the objects touch)
    'snow_cliff': ('sd_00', 112), 'snow_rock_big': ('sd_01', 56), 'snow_pine_tall': ('sd_02', 132), 'snow_pine_small': ('sd_03', 92), 'snow_pine_b': ('sd_16', 122),
    'ice_crystal_small': ('sd_07', 34), 'ice_crystal_big': ('sd_08', 58), 'snow_rock_flat': ('sd_15', 34), 'snow_bush_round': ('sd_17', 36), 'ice_sprig': ('sd_18', 16),
    'snow_berry_bush': ('sd_19', 38), 'snow_drift': ('sd_20', 24), 'snow_bush': ('sd_21', 30), 'snow_berry_small': ('sd_22', 28), 'snowman': ('sd_23', 50),
    'bare_tree_snow': ('sd_28', 118), 'stone_arch': ('sd_36', 74), 'stone_pillar': ('sd_43', 76), 'snow_patch': ('sd_44', 18), 'ice_shard': ('sd_45', 34), 'ice_pond': ('sd_46', 52),
    'sand_rock_big': ('sd_04', 80), 'sand_arch': ('sd_05', 82), 'sand_pillar': ('sd_06', 72), 'sand_tower': ('sd_09', 86), 'cactus_tall': ('sd_10', 62), 'agave': ('sd_11', 36),
    'cactus_barrel': ('sd_12', 26), 'cactus_rock': ('sd_13', 72), 'cactus_round': ('sd_24', 28), 'cactus_small': ('sd_25', 22), 'dead_tree': ('sd_26', 98), 'desert_grass': ('sd_27', 30),
    'sand_rocks': ('sd_31', 62), 'skull': ('sd_32', 22), 'sand_stone_small': ('sd_33', 24), 'dry_grass': ('sd_34', 16), 'dune': ('sd_35', 40), 'sand_slab': ('sd_40', 36),
    'cactus_group': ('sd_41', 62), 'dune_b': ('sd_47', 42), 'sand_rock_small': ('sd_48', 30), 'cactus': ('sd_49', 46), 'dry_grass_b': ('sd_50', 20), 'dry_grass_c': ('sd_51', 18),
    # four-theme sheet (marsh / sky / lava / void quadrants, prepped with tools/prep_sheet.py --holes 150)
    'marsh_pond': ('marsh_00', 120), 'marsh_tree_isle': ('marsh_01', 126), 'marsh_bridge': ('marsh_02', 60), 'reeds_mush': ('marsh_03', 44), 'mush_tiny': ('marsh_04', 14),
    'mush_purple': ('marsh_05', 32), 'mush_glow_big': ('marsh_06', 52), 'marsh_rock_pool': ('marsh_07', 32), 'moss_rock': ('marsh_08', 32), 'boardwalk': ('marsh_09', 80),
    'reeds': ('marsh_10', 44), 'log': ('marsh_11', 32), 'stump_moss': ('marsh_12', 26), 'mist': ('marsh_13', 28), 'mush_glow_small': ('marsh_14', 18), 'glow_grass': ('marsh_15', 28),
    'moss_rock_b': ('marsh_16', 26), 'moss_rock_s': ('marsh_17', 22),
    'sky_falls': ('sky_00', 130), 'sky_crystal_isle': ('sky_03', 60), 'sky_crystal': ('sky_04', 56), 'sky_gem': ('sky_05', 20), 'sky_gem_b': ('sky_06', 18), 'sky_obelisk': ('sky_07', 48),
    'sky_tree_isle': ('sky_08', 66), 'sky_portal': ('sky_10', 36), 'sky_shard': ('sky_12', 16), 'sky_shard_b': ('sky_13', 14),
    'lava_float': ('lava_01', 46), 'ember_shard': ('lava_02', 16), 'lava_spike_rock': ('lava_03', 46), 'lava_platform': ('lava_04', 56), 'lava_ruin_floor': ('lava_05', 40),
    'ember_shard_b': ('lava_06', 18), 'lava_pillar': ('lava_07', 48), 'lava_pillars': ('lava_08', 54), 'lava_ruin': ('lava_09', 46), 'lava_crystal_pile': ('lava_10', 42),
    'lava_arch': ('lava_11', 96), 'lava_crystal_rock': ('lava_13', 62), 'ember_ball': ('lava_14', 16), 'lava_arch_b': ('lava_15', 92), 'lava_obelisk': ('lava_16', 76), 'lava_crystal': ('lava_17', 58),
    'void_crystal_isle': ('void_00', 128), 'void_float': ('void_01', 48), 'void_shard': ('void_02', 14), 'void_rock_float': ('void_03', 28), 'void_pebble': ('void_04', 14),
    'void_shard_b': ('void_06', 18), 'void_rune_plat': ('void_07', 52), 'void_shard_c': ('void_08', 16), 'void_pillar': ('void_10', 36), 'void_tree': ('void_11', 96),
    'void_crystal_float': ('void_12', 80), 'void_gate': ('void_13', 100), 'void_slab': ('void_14', 42), 'void_crystal_rock': ('void_15', 40), 'void_crystal': ('void_16', 38),
    'palm': ('sd_30', 100), 'oak_green': ('sd_29', 96), 'bush_green_a': ('sd_37', 24), 'bush_green_b': ('sd_38', 30), 'bush_snowy': ('sd_39', 30), 'bush_green_c': ('sd_42', 36),
}
os.makedirs('public/props', exist_ok=True)
out = {}
for pid, (f, h) in PROPS.items():
    im = Image.open(f'{SLICES}/{f}.png').convert('RGBA')
    H = h * 2; W = round(im.width * H / im.height)
    im = im.resize((W, H), Image.LANCZOS)
    # the sheets are more saturated than the characters: tone them down so the cast reads first
    a0 = im.getchannel('A'); im = ImageEnhance.Brightness(ImageEnhance.Color(im.convert('RGB')).enhance(0.78)).enhance(0.93).convert('RGBA'); im.putalpha(a0)
    a = im.getchannel('A').point(lambda v: 255 if v > 110 else 0)   # hard edge: no grey fringe from the old backdrop
    im.putalpha(a)
    q = im.quantize(256, method=Image.FASTOCTREE, dither=Image.NONE)
    q.save(f'public/props/{pid}.png', optimize=True)
    out[pid] = {'h': h, 'w': round(W / 2)}
json.dump({'_note': 'Generated by tools/build_props.py from art/props/*_sheet.webp (sliced with tools/slice_props.py). h/w = on-screen size in px.', **out},
          open('data/props.json', 'w'), indent=1)
print(len(out), 'props', sum(os.path.getsize(f'public/props/{p}.png') for p in out) // 1024, 'KB')

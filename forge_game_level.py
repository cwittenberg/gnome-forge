#!/usr/bin/env python3
import random
from forge_game_math import ForgeAABB

class ForgeTileMap:
    def __init__(self, grid_data, tile_size=32):
        self.grid = grid_data
        self.tile_size = tile_size
        self.rows = len(grid_data)
        self.cols = len(grid_data[0]) if self.rows > 0 else 0
        self.colliders = []
        self._build_colliders()

    @property
    def width(self):
        return self.cols * self.tile_size

    @property
    def height(self):
        return self.rows * self.tile_size

    def get_bounds(self):
        return ForgeAABB(0, 0, self.width, self.height)
        
    def rebuild_colliders(self):
        """Re-evaluates the grid to apply physics updates when walls break or doors open."""
        self._build_colliders()

    def _build_colliders(self):
        self.colliders.clear()
        for r in range(self.rows):
            for c in range(self.cols):
                if self.grid[r][c] > 0:
                    self.colliders.append(
                        ForgeAABB(c * self.tile_size, r * self.tile_size, self.tile_size, self.tile_size)
                    )

    def draw(self, cr, colors=None):
        if not colors:
            colors = {1: (0.3, 0.3, 0.3), 2: (0.4, 0.2, 0.1)}
        for r in range(self.rows):
            for c in range(self.cols):
                val = self.grid[r][c]
                if val > 0:
                    color = colors.get(val, (0.5, 0.5, 0.5))
                    cr.set_source_rgb(*color)
                    cr.rectangle(c * self.tile_size, r * self.tile_size, self.tile_size, self.tile_size)
                    cr.fill()
                    cr.set_source_rgb(0, 0, 0)
                    cr.rectangle(c * self.tile_size, r * self.tile_size, self.tile_size, self.tile_size)
                    cr.stroke()

    def _entity_width(self, entity):
        return getattr(entity, "w", getattr(entity, "width", 0.0))

    def _entity_height(self, entity):
        return getattr(entity, "h", getattr(entity, "height", 0.0))

    def _zero_velocity_axis(self, entity, axis):
        velocity = getattr(entity, "velocity", None)
        if velocity is not None and hasattr(velocity, axis):
            setattr(velocity, axis, 0)

    def clamp_entity_to_bounds(self, entity, clamp_bottom=True):
        grounded = False
        entity_width = self._entity_width(entity)
        entity_height = self._entity_height(entity)

        if entity.x < 0:
            entity.x = 0
            self._zero_velocity_axis(entity, "x")
        elif entity.x + entity_width > self.width:
            entity.x = max(0, self.width - entity_width)
            self._zero_velocity_axis(entity, "x")

        if entity.y < 0:
            entity.y = 0
            self._zero_velocity_axis(entity, "y")
        elif clamp_bottom and entity.y + entity_height > self.height:
            entity.y = max(0, self.height - entity_height)
            self._zero_velocity_axis(entity, "y")
            grounded = True

        return grounded

    def resolve_physics(self, entity, clamp_bounds=True, clamp_bottom=True):
        entity_aabb = entity.get_aabb()
        grounded = False

        for collider in self.colliders:
            overlap = entity_aabb.get_overlap(collider)
            if overlap.x != 0 or overlap.y != 0:
                if overlap.y != 0:
                    entity.y += overlap.y
                    self._zero_velocity_axis(entity, "y")
                    if overlap.y < 0:
                        grounded = True
                elif overlap.x != 0:
                    entity.x += overlap.x
                    self._zero_velocity_axis(entity, "x")
                entity_aabb = entity.get_aabb()

        if clamp_bounds:
            grounded = self.clamp_entity_to_bounds(entity, clamp_bottom=clamp_bottom) or grounded

        if hasattr(entity, "is_grounded"):
            entity.is_grounded = grounded

        return grounded

class ForgeQuestManager:
    def __init__(self):
        self.quests = {}
        self.active_quests = set()
        self.completed_quests = set()

    def add_quest(self, quest_id, description, requirements=None):
        self.quests[quest_id] = {
            "description": description,
            "requirements": requirements or {},
            "progress": {k: 0 for k in (requirements or {})}
        }

    def start_quest(self, quest_id):
        if quest_id in self.quests and quest_id not in self.completed_quests:
            self.active_quests.add(quest_id)

    def update_progress(self, quest_id, req_key, amount=1):
        if quest_id in self.active_quests:
            reqs = self.quests[quest_id]["requirements"]
            prog = self.quests[quest_id]["progress"]
            if req_key in reqs:
                prog[req_key] = min(prog[req_key] + amount, reqs[req_key])
                if all(prog[k] >= reqs[k] for k in reqs):
                    self.active_quests.remove(quest_id)
                    self.completed_quests.add(quest_id)
                    return True
        return False

class ForgeLevelGenerator:
    """Generates complex BSP dungeons, mazes, and platformer levels."""
    
    @staticmethod
    def generate_platformer_level(width, height, floor_height=2):
        grid = [[0 for _ in range(width)] for _ in range(height)]
        
        # Create solid floor
        for y in range(height - floor_height, height):
            for x in range(width):
                grid[y][x] = 1
                
        # Add random pits
        for _ in range(width // 15):
            pit_x = random.randint(5, width - 5)
            pit_w = random.randint(2, 4)
            for y in range(height - floor_height, height):
                for x in range(pit_x, pit_x + pit_w):
                    if x < width:
                        grid[y][x] = 0
                        
        # Add platforms
        for _ in range(width // 8):
            plat_x = random.randint(3, width - 5)
            plat_y = random.randint(height - floor_height - 6, max(1, height - floor_height - 3))
            plat_w = random.randint(3, 6)
            for x in range(plat_x, plat_x + plat_w):
                if x < width:
                    grid[plat_y][x] = 1
                    
        # Add pipes/obstacles
        for _ in range(width // 20):
            pipe_x = random.randint(5, width - 5)
            pipe_h = random.randint(1, 3)
            for y in range(height - floor_height - pipe_h, height - floor_height):
                if grid[height - floor_height][pipe_x] == 1:
                    grid[y][pipe_x] = 2
                    
        return grid, []
        
    @staticmethod
    def generate_bsp_dungeon(width, height, min_room_size=4, max_rooms=30):
        grid = [[1 for _ in range(width)] for _ in range(height)]
        rooms = []
        
        class Leaf:
            def __init__(self, x, y, w, h):
                self.x = x; self.y = y; self.w = w; self.h = h
                self.left = None; self.right = None
                self.room = None
                
            def split(self):
                if self.left or self.right: return False
                split_h = random.random() > 0.5
                if self.w > self.h and self.w / self.h >= 1.25: split_h = False
                elif self.h > self.w and self.h / self.w >= 1.25: split_h = True
                
                max_val = (self.h if split_h else self.w) - min_room_size
                if max_val <= min_room_size: return False
                
                split_pos = random.randint(min_room_size, max_val)
                if split_h:
                    self.left = Leaf(self.x, self.y, self.w, split_pos)
                    self.right = Leaf(self.x, self.y + split_pos, self.w, self.h - split_pos)
                else:
                    self.left = Leaf(self.x, self.y, split_pos, self.h)
                    self.right = Leaf(self.x + split_pos, self.y, self.w - split_pos, self.h)
                return True
                
            def create_rooms(self):
                if self.left or self.right:
                    if self.left: self.left.create_rooms()
                    if self.right: self.right.create_rooms()
                    if self.left and self.right:
                        self.create_hall(self.left.get_room(), self.right.get_room())
                else:
                    room_w_max = max(min_room_size, self.w - 1)
                    room_w = random.randint(min_room_size, room_w_max)
                    
                    room_h_max = max(min_room_size, self.h - 1)
                    room_h = random.randint(min_room_size, room_h_max)
                    
                    room_x_max = max(1, self.w - room_w - 1)
                    room_x = random.randint(1, room_x_max)
                    
                    room_y_max = max(1, self.h - room_h - 1)
                    room_y = random.randint(1, room_y_max)
                    
                    self.room = (self.x + room_x, self.y + room_y, room_w, room_h)
                    rooms.append(self.room)
                    for y in range(self.room[1], self.room[1] + self.room[3]):
                        for x in range(self.room[0], self.room[0] + self.room[2]):
                            grid[y][x] = 0
                            
            def get_room(self):
                if self.room: return self.room
                l_room = self.left.get_room() if self.left else None
                r_room = self.right.get_room() if self.right else None
                if not l_room and not r_room: return None
                elif not r_room: return l_room
                elif not l_room: return r_room
                elif random.random() > 0.5: return l_room
                else: return r_room
                
            def create_hall(self, l_room, r_room):
                if not l_room or not r_room: return
                x1 = random.randint(l_room[0], max(l_room[0], l_room[0] + l_room[2] - 1))
                y1 = random.randint(l_room[1], max(l_room[1], l_room[1] + l_room[3] - 1))
                x2 = random.randint(r_room[0], max(r_room[0], r_room[0] + r_room[2] - 1))
                y2 = random.randint(r_room[1], max(r_room[1], r_room[1] + r_room[3] - 1))
                
                w = x2 - x1; h = y2 - y1
                if w < 0:
                    w = -w; x1 = x2
                if h < 0:
                    h = -h; y1 = y2
                    
                if random.random() > 0.5:
                    for x in range(x1, x1 + w + 1): grid[y1][x] = 0
                    for y in range(y1, y1 + h + 1): grid[y][x2] = 0
                else:
                    for y in range(y1, y1 + h + 1): grid[y][x1] = 0
                    for x in range(x1, x1 + w + 1): grid[y2][x] = 0

        root = Leaf(0, 0, width, height)
        leaves = [root]
        did_split = True
        while did_split and len(leaves) < max_rooms:
            did_split = False
            for leaf in leaves:
                if not leaf.left and not leaf.right:
                    if leaf.w > 10 or leaf.h > 10 or random.random() > 0.25:
                        if leaf.split():
                            leaves.append(leaf.left)
                            leaves.append(leaf.right)
                            did_split = True
        root.create_rooms()
        
        # Post-process to add doors (2) at chokepoints
        for y in range(1, height - 1):
            for x in range(1, width - 1):
                if grid[y][x] == 0:
                    if grid[y-1][x] == 1 and grid[y+1][x] == 1 and grid[y][x-1] == 0 and grid[y][x+1] == 0:
                        if random.random() < 0.3: grid[y][x] = 2
                    elif grid[y][x-1] == 1 and grid[y][x+1] == 1 and grid[y-1][x] == 0 and grid[y+1][x] == 0:
                        if random.random() < 0.3: grid[y][x] = 2
                            
        # Post-process to generate spawn points for player, enemies, and items
        spawns = []
        for i, room in enumerate(rooms):
            cx = room[0] + room[2] / 2.0
            cy = room[1] + room[3] / 2.0
            if i == 0:
                spawns.append({"type": "player", "x": cx, "y": cy})
            else:
                if random.random() < 0.5:
                    spawns.append({"type": "enemy", "x": cx + random.uniform(-0.5, 0.5), "y": cy + random.uniform(-0.5, 0.5)})
                if random.random() < 0.4:
                    item_type = random.choice(["ammo", "health", "weapon"])
                    spawns.append({"type": item_type, "x": cx + random.uniform(-1, 1), "y": cy + random.uniform(-1, 1)})

        return grid, rooms, spawns

class ForgeRaycaster:
    @staticmethod
    def render(cr, map_grid, px, py, dir_x, dir_y, plane_x, plane_y, screen_width, screen_height, textures=None, sprites=None):
        import cairo
        import math
        
        clean_textures = {}
        if textures:
            if isinstance(textures, dict):
                for k, v in textures.items():
                    if v is not None:
                        clean_textures[str(k)] = v
            elif isinstance(textures, (list, tuple)):
                for i, v in enumerate(textures):
                    if v is not None:
                        clean_textures[str(i+1)] = v
            else:
                if textures is not None:
                    clean_textures["1"] = textures
        
        # Draw Ceiling and Floor
        cr.set_source_rgb(0.2, 0.2, 0.2)
        cr.rectangle(0, screen_height / 2, screen_width, screen_height / 2)
        cr.fill()
        cr.set_source_rgb(0.3, 0.4, 0.6)
        cr.rectangle(0, 0, screen_width, screen_height / 2)
        cr.fill()

        z_buffer = [0] * int(screen_width)

        # WALL CASTING
        for x in range(int(screen_width)):
            camera_x = 2 * x / float(screen_width) - 1
            ray_dir_x = dir_x + plane_x * camera_x
            ray_dir_y = dir_y + plane_y * camera_x

            map_x = int(px)
            map_y = int(py)

            delta_dist_x = abs(1 / ray_dir_x) if ray_dir_x != 0 else 1e30
            delta_dist_y = abs(1 / ray_dir_y) if ray_dir_y != 0 else 1e30

            hit = 0
            side = 0

            if ray_dir_x < 0:
                step_x = -1
                side_dist_x = (px - map_x) * delta_dist_x
            else:
                step_x = 1
                side_dist_x = (map_x + 1.0 - px) * delta_dist_x

            if ray_dir_y < 0:
                step_y = -1
                side_dist_y = (py - map_y) * delta_dist_y
            else:
                step_y = 1
                side_dist_y = (map_y + 1.0 - py) * delta_dist_y

            # DDA
            for _ in range(50):
                if side_dist_x < side_dist_y:
                    side_dist_x += delta_dist_x
                    map_x += step_x
                    side = 0
                else:
                    side_dist_y += delta_dist_y
                    map_y += step_y
                    side = 1
                if map_y < 0 or map_y >= len(map_grid) or map_x < 0 or map_x >= len(map_grid[0]):
                    break
                if map_grid[map_y][map_x] > 0:
                    hit = map_grid[map_y][map_x]
                    break

            if hit > 0:
                if side == 0:
                    perp_wall_dist = (map_x - px + (1 - step_x) / 2) / ray_dir_x
                else:
                    perp_wall_dist = (map_y - py + (1 - step_y) / 2) / ray_dir_y

                if perp_wall_dist <= 0:
                    perp_wall_dist = 0.01

                line_height = int(screen_height / perp_wall_dist)
                if line_height <= 0: line_height = 1
                
                draw_start = -line_height / 2 + screen_height / 2
                draw_end = line_height / 2 + screen_height / 2
                
                z_buffer[x] = perp_wall_dist

                surface = clean_textures.get(str(hit))

                colors = {1: (0.4, 0.4, 0.4), 2: (0.6, 0.2, 0.2), 3: (0.2, 0.6, 0.2)}
                color = colors.get(hit, (0.5, 0.5, 0.5))
                if side == 1:
                    color = (color[0] * 0.7, color[1] * 0.7, color[2] * 0.7)
                cr.set_source_rgb(*color)
                cr.rectangle(x, max(0, draw_start), 1, draw_end - draw_start)
                cr.fill()

                if surface:
                    tex_w = surface.get_width()
                    tex_h = surface.get_height()
                    
                    if side == 0: wall_x = py + perp_wall_dist * ray_dir_y
                    else:         wall_x = px + perp_wall_dist * ray_dir_x
                    wall_x -= math.floor(wall_x)

                    tex_x = int(wall_x * float(tex_w))
                    if side == 0 and ray_dir_x > 0: tex_x = tex_w - tex_x - 1
                    if side == 1 and ray_dir_y < 0: tex_x = tex_w - tex_x - 1

                    cr.save()
                    cr.rectangle(x, max(0, draw_start), 1, draw_end - draw_start)
                    cr.clip()
                    
                    pattern = cairo.SurfacePattern(surface)
                    pattern.set_filter(cairo.Filter.NEAREST)
                    pattern.set_extend(cairo.Extend.REPEAT) 
                    
                    matrix = cairo.Matrix()
                    scale_y = tex_h / float(line_height)
                    matrix.scale(1.0, scale_y)
                    matrix.translate(-x, -draw_start)
                    matrix.translate(tex_x, 0)
                    pattern.set_matrix(matrix)
                    
                    cr.set_source(pattern)
                    if side == 1:
                        cr.paint_with_alpha(0.7)
                    else:
                        cr.paint()
                    cr.restore()

        # SPRITE BILLBOARDING
        if sprites and clean_textures:
            for s in sprites:
                s.distance = ((px - s.x)**2 + (py - s.y)**2)
            sprites.sort(key=lambda x: x.distance, reverse=True)
            
            for sprite in sprites:
                sprite_x = sprite.x - px
                sprite_y = sprite.y - py
                
                inv_det = 1.0 / (plane_x * dir_y - dir_x * plane_y)
                transform_x = inv_det * (dir_y * sprite_x - dir_x * sprite_y)
                transform_y = inv_det * (-plane_y * sprite_x + plane_x * sprite_y)
                
                if transform_y <= 0: continue
                
                sprite_screen_x = int((screen_width / 2) * (1 + transform_x / transform_y))
                v_move_screen = int(getattr(sprite, 'v_move', 0) / transform_y)
                
                sprite_height = abs(int(screen_height / transform_y))
                if sprite_height <= 0: sprite_height = 1
                
                sprite_width = abs(int(screen_height / transform_y))
                if sprite_width <= 0: sprite_width = 1
                
                draw_start_y = -sprite_height / 2 + screen_height / 2 + v_move_screen
                draw_end_y = sprite_height / 2 + screen_height / 2 + v_move_screen
                draw_start_x = -sprite_width / 2 + sprite_screen_x
                draw_end_x = sprite_width / 2 + sprite_screen_x
                
                clip_start_x = int(max(0, draw_start_x))
                clip_end_x = int(min(screen_width - 1, draw_end_x))
                
                tex_id = str(getattr(sprite, 'texture_id', ''))
                surface = clean_textures.get(tex_id)
                if not surface: continue
                
                tex_w = surface.get_width()
                tex_h = surface.get_height()
                
                for stripe in range(clip_start_x, clip_end_x):
                    tex_x = int(256 * (stripe - (-sprite_width / 2 + sprite_screen_x)) * tex_w / sprite_width) / 256
                    
                    if transform_y < z_buffer[stripe]:
                        cr.save()
                        cr.rectangle(stripe, max(0, draw_start_y), 1, draw_end_y - draw_start_y)
                        cr.clip()
                        
                        pattern = cairo.SurfacePattern(surface)
                        pattern.set_filter(cairo.Filter.NEAREST)
                        pattern.set_extend(cairo.Extend.PAD)
                        
                        matrix = cairo.Matrix()
                        scale_y = tex_h / float(sprite_height)
                        matrix.scale(1.0, scale_y)
                        matrix.translate(-stripe, -draw_start_y)
                        matrix.translate(tex_x, 0)
                        pattern.set_matrix(matrix)
                        
                        cr.set_source(pattern)
                        cr.paint()
                        cr.restore()
#!/usr/bin/env python3
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
        return getattr(entity, "w", getattr(entity, "width", 0))

    def _entity_height(self, entity):
        return getattr(entity, "h", getattr(entity, "height", 0))

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

class ForgeRaycaster:
    @staticmethod
    def render(cr, map_grid, px, py, dir_x, dir_y, plane_x, plane_y, screen_width, screen_height, colors=None):
        if not colors:
            colors = {1: (0.4, 0.4, 0.4), 2: (0.6, 0.2, 0.2), 3: (0.2, 0.6, 0.2)}

        cr.set_source_rgb(0.2, 0.2, 0.2)
        cr.rectangle(0, screen_height / 2, screen_width, screen_height / 2)
        cr.fill()
        cr.set_source_rgb(0.3, 0.4, 0.6)
        cr.rectangle(0, 0, screen_width, screen_height / 2)
        cr.fill()

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

                draw_start = -line_height / 2 + screen_height / 2
                draw_end = line_height / 2 + screen_height / 2

                color = colors.get(hit, (0.5, 0.5, 0.5))
                if side == 1:
                    color = (color[0] * 0.7, color[1] * 0.7, color[2] * 0.7)

                cr.set_source_rgb(*color)
                cr.rectangle(x, max(0, draw_start), 1, draw_end - draw_start)
                cr.fill()

#!/usr/bin/env python3
import math
import gi

gi.require_version('Gtk', '4.0')
gi.require_version('PangoCairo', '1.0')
from gi.repository import Gtk, Pango, PangoCairo

from forge_game_math import ForgeVector2, ForgeAABB
from forge_game_textures import ForgeTextureManager

class ForgeEntity:
    def __init__(self, x=0, y=0, w=32, h=32, color=(1,0,0), image_path=None, emoji=None):
        self.x = float(x)
        self.y = float(y)
        self.w = float(w)
        self.h = float(h)
        self.active = True
        self.velocity = ForgeVector2(0, 0)
        self.color = color
        self.emoji = emoji
        self.image_surface = ForgeTextureManager.get_cairo_surface(image_path) if image_path else None

    def update(self, dt):
        if not self.active: return
        self.x += self.velocity.x * dt
        self.y += self.velocity.y * dt

    def draw(self, cr):
        if not self.active: return
        
        if self.image_surface:
            cr.save()
            cr.translate(self.x, self.y)
            cr.scale(self.w / self.image_surface.get_width(), self.h / self.image_surface.get_height())
            cr.set_source_surface(self.image_surface, 0, 0)
            cr.paint()
            cr.restore()
        elif self.emoji:
            cr.set_source_rgb(0, 0, 0)
            layout = PangoCairo.create_layout(cr)
            desc = Pango.FontDescription(f"Sans {int(min(self.w, self.h) * 0.8)}")
            layout.set_font_description(desc)
            layout.set_text(self.emoji, -1)
            cr.move_to(self.x + (self.w * 0.1), self.y + (self.h * 0.1))
            PangoCairo.show_layout(cr, layout)
        else:
            cr.set_source_rgb(*self.color)
            cr.rectangle(self.x, self.y, self.w, self.h)
            cr.fill()
            cr.set_source_rgb(0, 0, 0)
            cr.set_line_width(1)
            cr.rectangle(self.x, self.y, self.w, self.h)
            cr.stroke()

    def get_aabb(self):
        return ForgeAABB(self.x, self.y, self.w, self.h)

class ForgeSprite(ForgeEntity):
    def __init__(self, x=0, y=0, w=32, h=32, color=(1,0,0), image_path=None, emoji=None):
        super().__init__(x, y, w, h, color, image_path, emoji)

class ForgeAnimatedSprite(ForgeSprite):
    def __init__(self, x=0, y=0, w=32, h=32, frames=None, fps=5):
        super().__init__(x, y, w, h)
        self.frames = frames or []
        self.anim_fps = fps
        self.anim_timer = 0.0
        self.current_frame = 0

    def update(self, dt):
        super().update(dt)
        if self.frames and self.anim_fps > 0:
            self.anim_timer += dt
            if self.anim_timer >= 1.0 / self.anim_fps:
                self.anim_timer = 0
                self.current_frame = (self.current_frame + 1) % len(self.frames)
                # Ensure compatibility with 3D raycaster
                self.texture_id = self.frames[self.current_frame]

class ForgeItem(ForgeEntity):
    def __init__(self, x=0, y=0, w=0.5, h=0.5, item_type="ammo", amount=10, image_path=None, emoji="📦"):
        super().__init__(x, y, w, h, color=(0,1,0), image_path=image_path, emoji=emoji)
        self.item_type = item_type
        self.amount = amount

    def on_pickup(self, player):
        self.active = False
        
class ForgeActor(ForgeEntity):
    def __init__(self, x=0, y=0, w=32, h=32, health=100, faction="neutral", color=(1,0,0), image_path=None, emoji=None):
        super().__init__(x, y, w, h, color, image_path, emoji)
        self.health = health
        self.max_health = health
        self.faction = faction
        self.speed = 100.0

    def take_damage(self, amount):
        if not self.active: return
        self.health -= amount
        if self.health <= 0:
            self.health = 0
            self.active = False
            self.on_death()

    def on_death(self):
        pass

class ForgePlatformerActor(ForgeActor):
    def __init__(self, x=0, y=0, w=32, h=32, health=100, faction="player", color=(1,0,0), image_path=None, emoji=None):
        super().__init__(x, y, w, h, health, faction, color, image_path, emoji)
        self.gravity = 980.0
        self.jump_force = -400.0
        self.is_grounded = False

    def update(self, dt):
        if not self.active: return
        self.velocity.y += self.gravity * dt
        super().update(dt)

    def jump(self):
        if self.is_grounded:
            self.velocity.y = self.jump_force
            self.is_grounded = False

class ForgeNPC(ForgeActor):
    def __init__(self, x=0, y=0, w=32, h=32, health=100, faction="enemy", color=(1,0,0), image_path=None, emoji=None):
        super().__init__(x, y, w, h, health, faction, color, image_path, emoji)
        self.state = "idle"
        self.target = None
        self.attack_range = 50.0

    def update(self, dt):
        if not self.active: return
        
        if self.target and self.target.active:
            dx = self.target.x - self.x
            dy = self.target.y - self.y
            dist = math.sqrt(dx*dx + dy*dy)
            
            if dist > 0:
                if dist > self.attack_range:
                    self.state = "chase"
                    self.velocity.x = (dx/dist) * self.speed
                    self.velocity.y = (dy/dist) * self.speed
                else:
                    self.state = "attack"
                    self.velocity.x = 0
                    self.velocity.y = 0
                    self.perform_attack(dt)
            else:
                self.velocity.x = 0
                self.velocity.y = 0
        else:
            self.state = "idle"
            self.velocity.x = 0
            self.velocity.y = 0

        super().update(dt)

    def perform_attack(self, dt):
        pass

class ForgeProjectile(ForgeEntity):
    def __init__(self, x, y, vx, vy, damage=10, lifetime=2.0, owner_faction="player"):
        super().__init__(x, y, 8, 8)
        self.velocity = ForgeVector2(vx, vy)
        self.damage = damage
        self.lifetime = lifetime
        self.owner_faction = owner_faction

    def update(self, dt):
        if not self.active: return
        super().update(dt)
        self.lifetime -= dt
        if self.lifetime <= 0:
            self.active = False

    def draw(self, cr):
        if not self.active: return
        cr.set_source_rgb(1, 1, 0)
        cr.arc(self.x + self.w/2, self.y + self.h/2, self.w/2, 0, 2*math.pi)
        cr.fill()

class ForgeTrigger(ForgeAABB):
    def __init__(self, x, y, width, height, on_enter_func, one_shot=True):
        super().__init__(x, y, width, height)
        self.on_enter_func = on_enter_func
        self.one_shot = one_shot
        self.triggered = False

    def check(self, entity):
        if self.triggered and self.one_shot:
            return False
            
        if self.intersects(entity.get_aabb()):
            self.on_enter_func(entity)
            self.triggered = True
            return True
        return False

class ForgeCardItem:
    def __init__(self, suit, value, x=0, y=0, width=60, height=90, face_up=True):
        self.suit = suit
        self.value = str(value)
        self.x = float(x)
        self.y = float(y)
        self.width = float(width)
        self.height = float(height)
        self.face_up = face_up

    def draw(self, cr):
        import cairo
        cr.set_line_width(1)
        cr.rectangle(self.x, self.y, self.width, self.height)
        if not self.face_up:
            cr.set_source_rgb(0.2, 0.3, 0.6)
            cr.fill_preserve()
            cr.set_source_rgb(1, 1, 1)
            cr.stroke()
            
            cr.set_source_rgb(0.1, 0.2, 0.5)
            cr.rectangle(self.x + 5, self.y + 5, self.width - 10, self.height - 10)
            cr.stroke()
        else:
            cr.set_source_rgb(1, 1, 1)
            cr.fill_preserve()
            cr.set_source_rgb(0.2, 0.2, 0.2)
            cr.stroke()
            
            is_red = self.suit in ['hearts', 'diamonds']
            if is_red:
                cr.set_source_rgb(0.8, 0.1, 0.1)
            else:
                cr.set_source_rgb(0.1, 0.1, 0.1)
            
            cr.select_font_face("Sans", cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
            cr.set_font_size(14)
            
            suit_symbols = {'hearts': '♥', 'diamonds': '♦', 'clubs': '♣', 'spades': '♠'}
            symbol = suit_symbols.get(self.suit, self.suit)
            
            cr.move_to(self.x + 5, self.y + 16)
            cr.show_text(self.value)
            cr.move_to(self.x + 5, self.y + 32)
            cr.show_text(symbol)
            
            cr.set_font_size(24)
            cr.move_to(self.x + self.width/2 - 8, self.y + self.height/2 + 8)
            cr.show_text(symbol)
            
    def get_aabb(self):
        return ForgeAABB(self.x, self.y, self.width, self.height)
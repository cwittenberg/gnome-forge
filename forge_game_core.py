#!/usr/bin/env python3
import os
import threading
import subprocess
import shutil
import urllib.request
import urllib.parse
import gi

gi.require_version('Gtk', '4.0')
from gi.repository import Gtk, GLib, Gdk

class ForgeInput:
    def __init__(self, widget):
        self.widget = widget
        self.pressed_keys = set()
        self.last_key = None
        self.controller = Gtk.EventControllerKey()
        self.controller.connect("key-pressed", self._on_key_pressed)
        self.controller.connect("key-released", self._on_key_released)
        widget.add_controller(self.controller)
        if hasattr(widget, "set_focusable"):
            widget.set_focusable(True)
        GLib.idle_add(self._grab_focus)

    def _grab_focus(self):
        if hasattr(self.widget, "grab_focus"):
            self.widget.grab_focus()
        return False

    def _normalize(self, key):
        if isinstance(key, str):
            key = key.strip().lower()
            aliases = {
                " ": "space",
                "esc": "escape",
                "left": "arrowleft",
                "right": "arrowright",
                "up": "arrowup",
                "down": "arrowdown",
                "return": "enter",
            }
            return aliases.get(key, key)
        name = Gdk.keyval_name(key)
        return name.lower() if name else str(key)

    def _key_names(self, keyval):
        name = self._normalize(keyval)
        names = {name, str(keyval)}
        arrow_aliases = {
            "left": "arrowleft",
            "right": "arrowright",
            "up": "arrowup",
            "down": "arrowdown",
            "return": "enter",
            "kp_enter": "enter",
        }
        if name in arrow_aliases:
            names.add(arrow_aliases[name])
        return names

    def _on_key_pressed(self, controller, keyval, keycode, state):
        names = self._key_names(keyval)
        self.pressed_keys.update(names)
        self.last_key = next(iter(names))
        return False

    def _on_key_released(self, controller, keyval, keycode, state):
        for name in self._key_names(keyval):
            self.pressed_keys.discard(name)
        return False

    def is_pressed(self, key):
        return self._normalize(key) in self.pressed_keys

    def is_down(self, key):
        return self.is_pressed(key)

    def any_pressed(self, *keys):
        return any(self.is_pressed(key) for key in keys)

    def clear(self):
        self.pressed_keys.clear()
        self.last_key = None

class ForgeMouse:
    def __init__(self, widget):
        self.widget = widget
        self.x = 0.0
        self.y = 0.0
        self.buttons = set()
        self.motion = Gtk.EventControllerMotion()
        self.motion.connect("motion", self._on_motion)
        self.motion.connect("leave", self._on_leave)
        widget.add_controller(self.motion)

        self.click = Gtk.GestureClick()
        self.click.set_button(0)
        self.click.connect("pressed", self._on_pressed)
        self.click.connect("released", self._on_released)
        widget.add_controller(self.click)

    def _on_motion(self, controller, x, y):
        self.x = float(x)
        self.y = float(y)

    def _on_leave(self, controller):
        pass

    def _on_pressed(self, gesture, n_press, x, y):
        self.x = float(x)
        self.y = float(y)
        self.buttons.add(gesture.get_current_button())

    def _on_released(self, gesture, n_press, x, y):
        self.x = float(x)
        self.y = float(y)
        self.buttons.discard(gesture.get_current_button())

    def is_pressed(self, button=1):
        return button in self.buttons

    def position(self):
        return (self.x, self.y)

    def world_position(self, camera):
        if camera:
            return camera.screen_to_world(self.x, self.y)
        return self.position()

    def clear(self):
        self.buttons.clear()

class ForgeCamera:
    def __init__(self, x=0, y=0, width=800, height=600, zoom=1.0):
        if height == 600 and width == 800 and y != 0 and x != 0:
            width, height = x, y
            x, y = 0, 0
        self.x = float(x)
        self.y = float(y)
        self.width = float(width)
        self.height = float(height)
        self.zoom = float(zoom)
        self.bounds = None
        self.target = None

    def set_viewport(self, width, height):
        self.width = float(width)
        self.height = float(height)
        self.clamp_to_bounds()

    def set_bounds(self, x=0, y=0, width=None, height=None):
        self.bounds = (float(x), float(y), float(width), float(height)) if width is not None and height is not None else None
        self.clamp_to_bounds()

    def set_bounds_from_tilemap(self, tilemap):
        self.set_bounds(0, 0, tilemap.cols * tilemap.tile_size, tilemap.rows * tilemap.tile_size)

    def follow(self, target, world_width=None, world_height=None, lerp=1.0, deadzone=None):
        self.target = target
        if world_width is not None and world_height is not None:
            self.set_bounds(0, 0, world_width, world_height)
        tx, ty, tw, th = self._target_rect(target)
        desired_x = tx + tw / 2 - (self.width / self.zoom) / 2
        desired_y = ty + th / 2 - (self.height / self.zoom) / 2
        if deadzone:
            desired_x, desired_y = self._apply_deadzone(tx, ty, tw, th, deadzone, desired_x, desired_y)
        lerp = max(0.0, min(1.0, float(lerp)))
        self.x += (desired_x - self.x) * lerp
        self.y += (desired_y - self.y) * lerp
        self.clamp_to_bounds()

    def update(self, dt=None):
        if self.target is not None:
            self.follow(self.target, lerp=1.0)

    def _target_rect(self, target):
        if hasattr(target, "get_aabb"):
            aabb = target.get_aabb()
            return aabb.x, aabb.y, aabb.width, aabb.height
        if hasattr(target, "x") and hasattr(target, "y"):
            return target.x, target.y, getattr(target, "w", 0), getattr(target, "h", 0)
        if isinstance(target, (tuple, list)):
            x = target[0]
            y = target[1]
            w = target[2] if len(target) > 2 else 0
            h = target[3] if len(target) > 3 else 0
            return x, y, w, h
        return 0, 0, 0, 0

    def _apply_deadzone(self, tx, ty, tw, th, deadzone, desired_x, desired_y):
        dzx, dzy, dzw, dzh = deadzone
        center_x = tx + tw / 2
        center_y = ty + th / 2
        left = self.x + dzx
        right = left + dzw
        top = self.y + dzy
        bottom = top + dzh
        if left <= center_x <= right:
            desired_x = self.x
        if top <= center_y <= bottom:
            desired_y = self.y
        return desired_x, desired_y

    def clamp_to_bounds(self):
        if not self.bounds:
            return
        bx, by, bw, bh = self.bounds
        view_w = self.width / self.zoom
        view_h = self.height / self.zoom
        max_x = bx + max(0, bw - view_w)
        max_y = by + max(0, bh - view_h)
        self.x = min(max(self.x, bx), max_x)
        self.y = min(max(self.y, by), max_y)

    def world_to_screen(self, x, y):
        return ((float(x) - self.x) * self.zoom, (float(y) - self.y) * self.zoom)

    def screen_to_world(self, x, y):
        return (float(x) / self.zoom + self.x, float(y) / self.zoom + self.y)

    def apply(self, cr):
        cr.save()
        cr.scale(self.zoom, self.zoom)
        cr.translate(-self.x, -self.y)

    def restore(self, cr):
        cr.restore()

    def begin(self, cr):
        self.apply(cr)

    def end(self, cr):
        self.restore(cr)

def ForgeDrawingArea(draw_func=None, width=800, height=600, **kwargs):
    kwargs.pop("child", None)
    drawing_area = Gtk.DrawingArea(**kwargs)
    drawing_area.set_size_request(int(width), int(height))
    drawing_area.set_hexpand(True)
    drawing_area.set_vexpand(True)
    if draw_func:
        drawing_area.set_draw_func(draw_func)
    return drawing_area

class ForgeGameLoop:
    def __init__(self, update_func, fps=60):
        self.update_func = update_func
        self.fps = fps
        self.interval_ms = max(1, int(1000 / fps))
        self.last_time = GLib.get_monotonic_time()
        self._source_id = GLib.timeout_add(self.interval_ms, self._tick)

    def _tick(self):
        current_time = GLib.get_monotonic_time()
        dt = (current_time - self.last_time) / 1000000.0
        self.last_time = current_time
        result = self.update_func(dt)
        return True if result is None else bool(result)

    def stop(self):
        if self._source_id:
            GLib.source_remove(self._source_id)
            self._source_id = None

try:
    from OpenGL.GL import GL_VERTEX_SHADER, GL_FRAGMENT_SHADER
    from OpenGL.GL.shaders import compileProgram, compileShader
    HAS_OPENGL = True
except ImportError:
    HAS_OPENGL = False
    GL_VERTEX_SHADER = 35633
    GL_FRAGMENT_SHADER = 35632
    def compileProgram(*args, **kwargs): return 0
    def compileShader(*args, **kwargs): return 0

class ForgeTextureManager:
    _cache = {}
    
    @classmethod
    def get_cache_dir(cls):
        path = os.path.join(GLib.get_user_cache_dir(), "gnome-forge-textures")
        os.makedirs(path, exist_ok=True)
        return path

    @classmethod
    def get_cairo_surface(cls, path_or_url):
        if not path_or_url:
            return None
        if path_or_url in cls._cache:
            return cls._cache[path_or_url]

        local_path = path_or_url

        if path_or_url.startswith("http"):
            safe_name = urllib.parse.quote_plus(path_or_url) + ".png"
            local_path = os.path.join(cls.get_cache_dir(), safe_name)
            
            if not os.path.exists(local_path):
                try:
                    req = urllib.request.Request(path_or_url, headers={'User-Agent': 'Mozilla/5.0'})
                    with urllib.request.urlopen(req) as response, open(local_path, 'wb') as out_file:
                        out_file.write(response.read())
                except Exception as e:
                    print(f"[FORGE-TEXTURE] Download failed: {e}")
                    return None

        if os.path.exists(local_path):
            try:
                import cairo
                surface = cairo.ImageSurface.create_from_png(local_path)
                cls._cache[path_or_url] = surface
                return surface
            except Exception as e:
                print(f"[FORGE-TEXTURE] Cairo Load failed: {e}")
                
        return None

class ForgeAudio:
    @staticmethod
    def play_sound(filepath):
        if not os.path.exists(filepath): return
        def _play():
            try:
                cmd = ['paplay', filepath] if shutil.which('paplay') else ['aplay', filepath]
                subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            except Exception:
                pass
        threading.Thread(target=_play, daemon=True).start()

class ForgeShaders:
    SIMPLE_2D_VERT = """
    #version 330 core
    layout(location = 0) in vec2 position;
    layout(location = 1) in vec2 texcoord;
    out vec2 v_texcoord;
    void main() {
        gl_Position = vec4(position, 0.0, 1.0);
        v_texcoord = texcoord;
    }
    """
    
    SIMPLE_2D_FRAG = """
    #version 330 core
    in vec2 v_texcoord;
    uniform sampler2D tex;
    out vec4 fragColor;
    void main() {
        fragColor = texture(tex, v_texcoord);
    }
    """
    
    PROCEDURAL_SKY_FRAG = """
    #version 330 core
    uniform float u_time;
    uniform vec2 u_resolution;
    out vec4 fragColor;
    
    float random(vec2 st) {
        return fract(sin(dot(st.xy, vec2(12.9898,78.233))) * 43758.5453123);
    }
    
    float noise(vec2 st) {
        vec2 i = floor(st);
        vec2 f = fract(st);
        float a = random(i);
        float b = random(i + vec2(1.0, 0.0));
        float c = random(i + vec2(0.0, 1.0));
        float d = random(i + vec2(1.0, 1.0));
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(a, b, u.x) + (c - a)* u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
    }
    
    float fbm(vec2 st) {
        float value = 0.0;
        float amplitude = 0.5;
        for (int i = 0; i < 5; i++) {
            value += amplitude * noise(st);
            st *= 2.0;
            amplitude *= 0.5;
        }
        return value;
    }
    
    void main() {
        vec2 uv = gl_FragCoord.xy / u_resolution.xy;
        vec2 cloud_uv = uv * 3.0 + vec2(u_time * 0.05, 0.0);
        
        float n = fbm(cloud_uv);
        vec3 skyColor = mix(vec3(0.5, 0.7, 1.0), vec3(0.1, 0.4, 0.8), uv.y);
        vec3 cloudColor = vec3(1.0, 1.0, 1.0);
        
        float cloudCover = smoothstep(0.4, 0.8, n);
        vec3 finalColor = mix(skyColor, cloudColor, cloudCover);
        
        fragColor = vec4(finalColor, 1.0);
    }
    """

def ForgeCompileShader(vertex_src, fragment_src):
    if not HAS_OPENGL:
        print("[FORGE-GL] PyOpenGL is missing. Shader compilation aborted.")
        return 0
    try:
        shader = compileProgram(
            compileShader(vertex_src, GL_VERTEX_SHADER),
            compileShader(fragment_src, GL_FRAGMENT_SHADER)
        )
        return shader
    except Exception as e:
        print(f"[FORGE-GL] Shader Compilation Error: {e}")
        return 0

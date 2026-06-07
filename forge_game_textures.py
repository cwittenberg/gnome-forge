#!/usr/bin/env python3
import os
import threading
import subprocess
import shutil
import urllib.request
import urllib.parse
import gi

gi.require_version('Gtk', '4.0')
from gi.repository import GLib

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
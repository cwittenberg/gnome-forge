#!/usr/bin/env python3
import gi
import os
import json
import sqlite3
import threading
import time
import math
import urllib.request
import urllib.parse
import re

gi.require_version('Gtk', '4.0')
gi.require_version('Adw', '1')

try:
    gi.require_version('WebKit', '6.0')
    from gi.repository import WebKit
except (ValueError, ImportError):
    try:
        gi.require_version('WebKit2', '4.1')
        from gi.repository import WebKit2 as WebKit
    except (ValueError, ImportError):
        WebKit = None

from gi.repository import Gtk, Gdk, GdkPixbuf, Adw, Pango, Gio, GLib

try:
    import cairo
except ImportError:
    pass

# --- TYPOGRAPHY & DISPLAY ---

class ForgeMarkdown(Gtk.Box):
    def __init__(self, markdown_text="", **kwargs):
        kwargs.pop("child", None)
        super().__init__(orientation=Gtk.Orientation.VERTICAL, spacing=6, **kwargs)
        self.label = Gtk.Label(wrap=True, justify=Gtk.Justification.LEFT, halign=Gtk.Align.START)
        self.label.set_selectable(True)
        self.append(self.label)
        if markdown_text:
            self.set_markdown(markdown_text)

    def set_markdown(self, text):
        if not text:
            self.label.set_markup("")
            return

        # Basic HTML escaping to prevent Pango crashes
        text = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

        # Headers
        text = re.sub(r'^###\s+(.*)$', r'<span size="large" weight="bold">\1</span>', text, flags=re.MULTILINE)
        text = re.sub(r'^##\s+(.*)$', r'<span size="x-large" weight="bold">\1</span>', text, flags=re.MULTILINE)
        text = re.sub(r'^#\s+(.*)$', r'<span size="xx-large" weight="bold">\1</span>', text, flags=re.MULTILINE)

        # Bold and Italic
        text = re.sub(r'\*\*(.*?)\*\*', r'<b>\1</b>', text)
        text = re.sub(r'\*(.*?)\*', r'<i>\1</i>', text)
        text = re.sub(r'__(.*?)__', r'<b>\1</b>', text)
        text = re.sub(r'_(.*?)_', r'<i>\1</i>', text)

        # Lists
        text = re.sub(r'^\*\s+(.*)$', r'• \1', text, flags=re.MULTILINE)
        text = re.sub(r'^-\s+(.*)$', r'• \1', text, flags=re.MULTILINE)

        # Code blocks
        text = re.sub(r'```(.*?)```', r'<tt>\1</tt>', text, flags=re.DOTALL)
        text = re.sub(r'`(.*?)`', r'<tt>\1</tt>', text)

        try:
            self.label.set_markup(text)
        except Exception as e:
            print(f"[FORGE-UI] Pango Markup Error: {e}")
            self.label.set_text(text)  # Fallback to plain text if markup fails

    # Defensive Aliases for LLM Hallucinations
    def set_text(self, text):
        self.set_markdown(text)
        
    def set_markup(self, text):
        self.set_markdown(text)

def ForgeLabel(text="", style_class=None, wrap=True, justify=Gtk.Justification.LEFT, halign=Gtk.Align.START, **kwargs):
    size = kwargs.pop("size", None)
    font_size = kwargs.pop("font_size", None)
    color = kwargs.pop("color", None)
    weight = kwargs.pop("weight", None)
    kwargs.pop("child", None) 
    
    lbl = Gtk.Label(wrap=wrap, justify=justify, halign=halign, **kwargs)
    
    target_size = size or font_size
    if target_size or color or weight:
        span_attrs = []
        if target_size:
            try:
                span_attrs.append(f"size='{int(target_size) * 1024}'")
            except ValueError:
                span_attrs.append(f"size='{target_size}'")
        if color:
            span_attrs.append(f"foreground='{color}'")
        if weight:
            span_attrs.append(f"weight='{weight}'")
            
        attr_str = " ".join(span_attrs)
        escaped_text = GLib.markup_escape_text(str(text))
        lbl.set_markup(f"<span {attr_str}>{escaped_text}</span>")
    else:
        lbl.set_label(str(text))

    if style_class:
        lbl.add_css_class(style_class)
    return lbl

def ForgeIcon(icon_name="applications-engineering-symbolic", pixel_size=24, **kwargs):
    if "size" in kwargs:
        pixel_size = kwargs.pop("size")
    kwargs.pop("child", None)
    return Gtk.Image(icon_name=icon_name, pixel_size=pixel_size, **kwargs)

# --- LAYOUT CONTAINERS ---

class ForgeBox(Gtk.Box):
    def __init__(self, orientation=Gtk.Orientation.VERTICAL, spacing=12, margin=12, child=None, title=None, subtitle=None, **kwargs):
        kwargs.pop("size", None)
        super().__init__(orientation=orientation, spacing=spacing, **kwargs)
        self._forge_header_box = None
        self._forge_title_label = None
        self._forge_subtitle_label = None
        self.set_margin_start(margin)
        self.set_margin_end(margin)
        self.set_margin_top(margin)
        self.set_margin_bottom(margin)
        if title is not None:
            self.set_title(title)
        if subtitle is not None:
            self.set_subtitle(subtitle)
        if child:
            self.append(child)

    def _children(self):
        children = []
        child = self.get_first_child()
        while child:
            children.append(child)
            child = child.get_next_sibling()
        return children

    def __iter__(self):
        return iter(self._children())

    def children(self):
        return self._children()

    def clear(self):
        for child in list(self._children()):
            self.remove(child)

    def _ensure_header(self):
        if self._forge_header_box and self._forge_header_box.get_parent() is self:
            return
        self._forge_header_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
        self._forge_header_box.add_css_class("forge-section-header")
        self._forge_header_box.set_margin_bottom(6)
        Gtk.Box.prepend(self, self._forge_header_box)
        self._forge_title_label = None
        self._forge_subtitle_label = None

    def set_title(self, title):
        self._ensure_header()
        if self._forge_title_label is None or self._forge_title_label.get_parent() is None:
            self._forge_title_label = ForgeLabel(text=title, style_class="title-2")
            Gtk.Box.prepend(self._forge_header_box, self._forge_title_label)
        else:
            self._forge_title_label.set_label(str(title))

    def set_subtitle(self, subtitle):
        self._ensure_header()
        if self._forge_subtitle_label is None or self._forge_subtitle_label.get_parent() is None:
            self._forge_subtitle_label = ForgeLabel(text=subtitle)
            self._forge_subtitle_label.add_css_class("dim-label")
            self._forge_header_box.append(self._forge_subtitle_label)
        else:
            self._forge_subtitle_label.set_label(str(subtitle))


class ForgeCard(Gtk.Box):
    def __init__(self, title=None, subtitle=None, orientation=Gtk.Orientation.VERTICAL, spacing=12, child=None, **kwargs):
        kwargs.pop("size", None)
        super().__init__(orientation=Gtk.Orientation.VERTICAL, spacing=spacing, **kwargs)
        self.add_css_class('card')
        self.set_margin_start(12)
        self.set_margin_end(12)
        self.set_margin_top(12)
        self.set_margin_bottom(12)

        self._forge_header_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
        self._forge_header_box.set_margin_start(12)
        self._forge_header_box.set_margin_end(12)
        self._forge_header_box.set_margin_top(12)
        self._forge_header_box.add_css_class("forge-card-header")
        Gtk.Box.append(self, self._forge_header_box)

        self._forge_title_label = ForgeLabel(text="", style_class='title-2')
        self._forge_subtitle_label = ForgeLabel(text="")
        self._forge_subtitle_label.add_css_class('dim-label')
        self._forge_header_box.append(self._forge_title_label)
        self._forge_header_box.append(self._forge_subtitle_label)

        self._forge_content_box = Gtk.Box(orientation=orientation, spacing=spacing)
        self._forge_content_box.set_margin_start(12)
        self._forge_content_box.set_margin_end(12)
        self._forge_content_box.set_margin_bottom(12)
        Gtk.Box.append(self, self._forge_content_box)

        self.set_title(title or "")
        self.set_subtitle(subtitle or "")
        if child:
            self.append(child)

    def _content_children(self):
        children = []
        child = self._forge_content_box.get_first_child()
        while child:
            children.append(child)
            child = child.get_next_sibling()
        return children

    def __iter__(self):
        return iter(self._content_children())

    def children(self):
        return self._content_children()

    def append(self, child):
        self._forge_content_box.append(child)

    def prepend(self, child):
        self._forge_content_box.prepend(child)

    def remove(self, child):
        if child.get_parent() is self._forge_content_box:
            self._forge_content_box.remove(child)
        else:
            Gtk.Box.remove(self, child)

    def clear(self):
        for child in list(self._content_children()):
            self._forge_content_box.remove(child)

    def set_title(self, title):
        self._forge_title_label.set_label(str(title))
        self._forge_title_label.set_visible(bool(str(title)))

    def set_subtitle(self, subtitle):
        self._forge_subtitle_label.set_label(str(subtitle))
        self._forge_subtitle_label.set_visible(bool(str(subtitle)))

def ForgeRow(title="", subtitle=None, widget=None, **kwargs):
    kwargs.pop("child", None)
    box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12, **kwargs)
    box.set_margin_start(12)
    box.set_margin_end(12)
    box.set_margin_top(6)
    box.set_margin_bottom(6)
    box.set_valign(Gtk.Align.CENTER)
    
    text_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
    lbl = ForgeLabel(text=title, halign=Gtk.Align.START)
    text_box.append(lbl)
    
    if subtitle:
        sub = ForgeLabel(text=subtitle, halign=Gtk.Align.START)
        sub.add_css_class('dim-label')
        text_box.append(sub)
        
    text_box.set_hexpand(True)
    box.append(text_box)
    
    if widget:
        widget.set_valign(Gtk.Align.CENTER)
        box.append(widget)
    return box

def ForgePaned(child1=None, child2=None, orientation=Gtk.Orientation.HORIZONTAL, **kwargs):
    kwargs.pop("child", None)
    paned = Gtk.Paned(orientation=orientation, **kwargs)
    if child1:
        paned.set_start_child(child1)
    if child2:
        paned.set_end_child(child2)
    return paned

def ForgeListBox(selection_mode=Gtk.SelectionMode.SINGLE, **kwargs):
    kwargs.pop("child", None)
    lb = Gtk.ListBox(**kwargs)
    lb.set_selection_mode(selection_mode)
    lb.add_css_class("boxed-list")
    return lb

# --- ACTION CONTROLS & INPUTS ---

def ForgeButton(label=None, icon_name=None, on_click=None, style_class=None, **kwargs):
    kwargs.pop("size", None)
    kwargs.pop("child", None)
    btn = Gtk.Button(**kwargs)
    if label:
        btn.set_label(label)
    if icon_name:
        btn.set_icon_name(icon_name)
    if style_class:
        btn.add_css_class(style_class)
    if on_click:
        btn.connect('clicked', lambda *args: on_click(btn))
    return btn

def ForgeEntry(placeholder="", text="", on_change=None, on_activate=None, **kwargs):
    kwargs.pop("size", None)
    kwargs.pop("child", None)
    entry = Gtk.Entry(placeholder_text=placeholder, text=text, **kwargs)
    if on_change:
        entry.connect('changed', lambda e: on_change(e))
    if on_activate:
        entry.connect('activate', lambda e: on_activate(e))
    return entry

def ForgeSwitch(active=False, on_change=None, **kwargs):
    kwargs.pop("child", None)
    switch = Gtk.Switch(active=active, **kwargs)
    if on_change:
        switch.connect('notify::active', lambda s, p: on_change(s.get_active()))
    return switch

def ForgeSlider(min_val=0, max_val=100, step=1, default=50, on_change=None, **kwargs):
    kwargs.pop("child", None)
    adjustment = Gtk.Adjustment(value=default, lower=min_val, upper=max_val, step_increment=step, page_increment=step*10)
    scale = Gtk.Scale(orientation=Gtk.Orientation.HORIZONTAL, adjustment=adjustment, **kwargs)
    scale.set_hexpand(True)
    if on_change:
        scale.connect('value-changed', lambda s: on_change(s.get_value()))
    return scale

def ForgeSpinButton(min_val=0, max_val=100, step=1, default=0, on_change=None, **kwargs):
    kwargs.pop("child", None)
    adjustment = Gtk.Adjustment(value=default, lower=min_val, upper=max_val, step_increment=step, page_increment=step*10)
    spin = Gtk.SpinButton(adjustment=adjustment, numeric=True, **kwargs)
    if on_change:
        spin.connect('value-changed', lambda s: on_change(s.get_value()))
    return spin

def ForgeDropDown(items=None, default_index=0, on_change=None, **kwargs):
    kwargs.pop("child", None)
    items = items or ["Item 1", "Item 2"]
    sl = Gtk.StringList.new(items)
    drop = Gtk.DropDown(model=sl, selected=default_index, **kwargs)
    if on_change:
        drop.connect('notify::selected', lambda d, p: on_change(d.get_selected(), items[d.get_selected()]))
    return drop

# --- FEEDBACK & PROGRESS ---

def ForgeProgressBar(fraction=0.0, show_text=False, **kwargs):
    kwargs.pop("child", None)
    return Gtk.ProgressBar(fraction=fraction, show_text=show_text, **kwargs)

def ForgeLevelBar(min_val=0, max_val=10, val=5, **kwargs):
    kwargs.pop("child", None)
    return Gtk.LevelBar(min_value=min_val, max_value=max_val, value=val, **kwargs)

def ForgeSpinner(spinning=True, **kwargs):
    kwargs.pop("child", None)
    return Gtk.Spinner(spinning=spinning, **kwargs)

# --- MODERN ADWAITA COMPONENTS ---

def ForgePreferencesGroup(title=None, description=None, **kwargs):
    kwargs.pop("child", None)
    group = Adw.PreferencesGroup(title=title, description=description, **kwargs)
    group.set_margin_start(12)
    group.set_margin_end(12)
    group.set_margin_top(12)
    group.set_margin_bottom(12)
    return group

def ForgeActionRow(title, subtitle=None, icon_name=None, suffix_widget=None, prefix_widget=None, **kwargs):
    kwargs.pop("child", None)
    row = Adw.ActionRow(title=title, subtitle=subtitle, **kwargs)
    if icon_name:
        icon = Gtk.Image(icon_name=icon_name)
        row.add_prefix(icon)
    if prefix_widget:
        row.add_prefix(prefix_widget)
    if suffix_widget:
        row.add_suffix(suffix_widget)
    return row

def ForgeExpanderRow(title, subtitle=None, icon_name=None, **kwargs):
    kwargs.pop("child", None)
    row = Adw.ExpanderRow(title=title, subtitle=subtitle, **kwargs)
    if icon_name:
        icon = Gtk.Image(icon_name=icon_name)
        row.add_prefix(icon)
    return row

def ForgeStatusPage(title, description=None, icon_name="applications-engineering-symbolic", **kwargs):
    kwargs.pop("child", None)
    page = Adw.StatusPage(title=title, description=description, icon_name=icon_name, **kwargs)
    page.set_vexpand(True)
    page.set_hexpand(True)
    return page

# --- ADVANCED VISUALS, MEDIA, & SHADERS ---

class ForgeNetworkImage(Gtk.Picture):
    def __init__(self, url, **kwargs):
        kwargs.pop("child", None)
        super().__init__(**kwargs)
        self.set_content_fit(Gtk.ContentFit.CONTAIN)
        self.load_url(url)
        
    def load_url(self, url):
        if not url: return
        def _fetch():
            try:
                req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
                with urllib.request.urlopen(req) as response:
                    data = response.read()
                GLib.idle_add(self._set_image, data)
            except Exception as e:
                print(f"ForgeNetworkImage Failed: {e}")
        threading.Thread(target=_fetch, daemon=True).start()

    def _set_image(self, data):
        try:
            stream = Gio.MemoryInputStream.new_from_data(data, None)
            pixbuf = GdkPixbuf.Pixbuf.new_from_stream(stream, None)
            texture = Gdk.Texture.new_for_pixbuf(pixbuf)
            self.set_paintable(texture)
        except Exception as e:
            print(f"ForgeNetworkImage Decode Failed: {e}")

    # Defensive Aliases for LLM Hallucinations
    def set_url(self, url):
        self.load_url(url)
        
    def set_file(self, url):
        self.load_url(url)

def ForgeAvatar(text="", size=48, show_initials=True, **kwargs):
    kwargs.pop("child", None)
    return Adw.Avatar(size=size, show_initials=show_initials, text=text, **kwargs)

def ForgeCarousel(widgets, **kwargs):
    kwargs.pop("child", None)
    carousel = Adw.Carousel(**kwargs)
    for w in widgets:
        carousel.append(w)
    return carousel

class ForgeChart(Gtk.DrawingArea):
    def __init__(self, data, labels=None, title=None, color=(0.2, 0.5, 0.9), **kwargs):
        kwargs.pop("child", None)
        super().__init__(**kwargs)
        self.data = data
        self.labels = labels or [str(i) for i in range(len(data))]
        self.title = title
        self.color = color
        self.set_draw_func(self._on_draw)
        self.set_size_request(300, 250)

    def update_data(self, data, labels=None, title=None, color=None):
        self.data = data
        if labels is not None:
            self.labels = labels
        if title is not None:
            self.title = title
        if color is not None:
            self.color = color
        self.queue_draw()

    def _on_draw(self, area, cr, width, height):
        if not self.data: return
        import cairo
        
        margin_left = 40
        margin_bottom = 30
        margin_top = 40 if self.title else 20
        margin_right = 20
        
        chart_width = width - margin_left - margin_right
        chart_height = height - margin_top - margin_bottom
        
        max_val = max(self.data) if max(self.data) > 0 else 1
        
        cr.select_font_face("Sans", cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
        
        if self.title:
            cr.set_source_rgb(0.9, 0.9, 0.9)
            cr.set_font_size(16)
            extents = cr.text_extents(self.title)
            cr.move_to((width - extents.width) / 2, 25)
            cr.show_text(self.title)
        
        cr.set_source_rgb(0.5, 0.5, 0.5)
        cr.set_line_width(1.5)
        cr.move_to(margin_left, margin_top)
        cr.line_to(margin_left, height - margin_bottom)
        cr.line_to(width - margin_right, height - margin_bottom)
        cr.stroke()
        
        bar_width = chart_width / len(self.data)
        
        for i, val in enumerate(self.data):
            bar_h = (val / max_val) * chart_height
            x = margin_left + i * bar_width + (bar_width * 0.1)
            y = height - margin_bottom - bar_h
            w = bar_width * 0.8
            
            cr.set_source_rgb(*self.color)
            cr.rectangle(x, y, w, bar_h)
            cr.fill()
            
            cr.set_source_rgb(0.8, 0.8, 0.8)
            cr.set_font_size(11)
            val_str = str(val)
            extents = cr.text_extents(val_str)
            cr.move_to(x + w/2 - extents.width/2, y - 5)
            cr.show_text(val_str)
            
            if i < len(self.labels):
                cr.set_source_rgb(0.7, 0.7, 0.7)
                cr.set_font_size(12)
                lbl_str = str(self.labels[i])
                extents = cr.text_extents(lbl_str)
                cr.move_to(x + w/2 - extents.width/2, height - margin_bottom + 18)
                cr.show_text(lbl_str)

def ForgeDrawingArea(draw_func, **kwargs):
    kwargs.pop("child", None)
    da = Gtk.DrawingArea(**kwargs)
    da.set_draw_func(draw_func)
    return da

def ForgeGLArea(render_func, **kwargs):
    kwargs.pop("child", None)
    gl = Gtk.GLArea(**kwargs)
    gl.connect("render", render_func)
    return gl

def ForgePicture(file_path=None, **kwargs):
    kwargs.pop("child", None)
    pic = Gtk.Picture(**kwargs)
    if file_path:
        pic.set_filename(file_path)
    return pic

def ForgeVideo(file_path=None, **kwargs):
    kwargs.pop("child", None)
    vid = Gtk.Video(**kwargs)
    if file_path:
        vid.set_filename(file_path)
    return vid

def ForgeWebView(url=None, html=None, **kwargs):
    kwargs.pop("child", None)
    if not WebKit:
        err = ForgeLabel(text="WebKit is not installed on this system. Cannot render Web/D3.js views.")
        err.add_css_class("error")
        return err
    web = WebKit.WebView(**kwargs)
    if html:
        web.load_html(html, None)
    elif url:
        web.load_uri(url)
    web.set_hexpand(True)
    web.set_vexpand(True)
    return web

class ForgeAnimatedBackground(Gtk.Overlay):
    """Provides a smoothly animating gradient background using Cairo. Wraps around a child widget natively."""
    def __init__(self, color1=(0.1, 0.1, 0.3), color2=(0.3, 0.1, 0.2), child=None, **kwargs):
        kwargs.pop("size", None)
        super().__init__(**kwargs)
        
        self.da = Gtk.DrawingArea()
        self.da.set_hexpand(True)
        self.da.set_vexpand(True)
        
        self.set_child(self.da)
        if child:
            self.add_overlay(child)
            
        self.color1 = color1
        self.color2 = color2
        self._time = 0.0
        self.da.set_draw_func(self._on_draw)
        GLib.timeout_add(33, self._animate)

    def _animate(self):
        self._time += 0.05
        self.da.queue_draw()
        return True

    def _on_draw(self, area, cr, width, height):
        r1 = self.color1[0] + math.sin(self._time) * 0.1
        g1 = self.color1[1] + math.cos(self._time * 0.8) * 0.1
        b1 = self.color1[2] + math.sin(self._time * 1.2) * 0.1
        r2 = self.color2[0] + math.cos(self._time * 0.9) * 0.1
        g2 = self.color2[1] + math.sin(self._time * 1.1) * 0.1
        b2 = self.color2[2] + math.cos(self._time * 1.3) * 0.1

        import cairo
        pat = cairo.LinearGradient(0.0, 0.0, width, height)
        pat.add_color_stop_rgb(0, r1, g1, b1)
        pat.add_color_stop_rgb(1, r2, g2, b2)
        cr.rectangle(0, 0, width, height)
        cr.set_source(pat)
        cr.fill()

    def append(self, widget):
        """Helper to act like a standard Box container if appended to."""
        self.add_overlay(widget)

# --- STATE, STORAGE, & ASYNC ---

def ForgeAsyncTask(task_func, callback_func):
    def _thread_wrapper():
        try:
            result = task_func()
            GLib.idle_add(lambda: callback_func(result))
        except Exception as e:
            GLib.idle_add(lambda: callback_func(e))
    threading.Thread(target=_thread_wrapper, daemon=True).start()

class ForgeStorage:
    def __init__(self, db_name="default"):
        self.path = os.path.join(GLib.get_user_data_dir(), "gnome-forge", "storage")
        os.makedirs(self.path, exist_ok=True)
        self.file_path = os.path.join(self.path, f"{db_name}.json")
        self.data = self._load()

    def _load(self):
        if os.path.exists(self.file_path):
            try:
                with open(self.file_path, 'r') as f:
                    return json.load(f)
            except Exception:
                pass
        return {}

    def save(self):
        with open(self.file_path, 'w') as f:
            json.dump(self.data, f)

    def set(self, key, value):
        self.data[key] = value
        self.save()

    def get(self, key, default=None):
        return self.data.get(key, default)

class ForgeDatabase:
    def __init__(self, db_name="default"):
        self.path = os.path.join(GLib.get_user_data_dir(), "gnome-forge", "databases")
        os.makedirs(self.path, exist_ok=True)
        self.db_path = os.path.join(self.path, f"{db_name}.sqlite")
        self.conn = sqlite3.connect(self.db_path)
        self.conn.row_factory = sqlite3.Row

    def execute(self, query, params=()):
        cur = self.conn.cursor()
        cur.execute(query, params)
        self.conn.commit()
        return cur

    def fetchall(self, query, params=()):
        return [dict(row) for row in self.execute(query, params).fetchall()]

# --- SECURE DBUS AI INTEGRATION ---

def ask_ai(system_prompt, user_prompt, callback):
    import uuid
    call_id = str(uuid.uuid4())
    
    def on_signal(connection, sender_name, object_path, interface_name, signal_name, parameters, user_data):
        if signal_name == "AIResponse":
            ret_id, response = parameters.unpack()
            if ret_id == call_id:
                GLib.idle_add(callback, response)
                if user_data[0] is not None:
                    connection.signal_unsubscribe(user_data[0])

    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    
    sub_data = [None]
    sub_id = bus.signal_subscribe(
        "org.gnome.Shell",
        "org.gnome.Shell.Extensions.GnomeForge",
        "AIResponse",
        "/org/gnome/Shell/Extensions/GnomeForge",
        None,
        Gio.DBusSignalFlags.NONE,
        on_signal,
        sub_data
    )
    sub_data[0] = sub_id
    
    proxy = Gio.DBusProxy.new_sync(bus, Gio.DBusProxyFlags.NONE, None,
        "org.gnome.Shell",
        "/org/gnome/Shell/Extensions/GnomeForge",
        "org.gnome.Shell.Extensions.GnomeForge", None)
        
    proxy.call("AskAI", GLib.Variant("(sss)", (call_id, system_prompt, user_prompt)), Gio.DBusCallFlags.NONE, -1, None)

def fetch_web_image(query, callback):
    """
    Asynchronously fetches the most relevant image URL from Wikipedia given a search query.
    """
    def _fetch():
        try:
            safe_query = urllib.parse.quote(query)
            # Fetch the most relevant article title first
            search_url = f"https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch={safe_query}&utf8=&format=json&srlimit=1"
            req1 = urllib.request.Request(search_url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req1) as response1:
                search_data = json.loads(response1.read().decode('utf-8'))
            
            search_results = search_data.get('query', {}).get('search', [])
            if not search_results:
                GLib.idle_add(lambda: callback(""))
                return
            
            title = search_results[0]['title']
            safe_title = urllib.parse.quote(title)
            
            # Fetch the main image for the article
            img_url_req = f"https://en.wikipedia.org/w/api.php?action=query&prop=pageimages&format=json&piprop=original&titles={safe_title}"
            req2 = urllib.request.Request(img_url_req, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req2) as response2:
                img_data = json.loads(response2.read().decode('utf-8'))
            
            pages = img_data.get('query', {}).get('pages', {})
            img_url = ""
            for page_id, page_info in pages.items():
                if 'original' in page_info:
                    img_url = page_info['original']['source']
                    break
            
            GLib.idle_add(lambda: callback(img_url))
        except Exception as e:
            print(f"[FORGE-UI] fetch_web_image error: {e}")
            GLib.idle_add(lambda: callback(""))

    threading.Thread(target=_fetch, daemon=True).start()

def ask_ai_structured(system_prompt, user_prompt, expected_schema, callback):
    """
    Forces the AI to return a response adhering to a specific JSON schema,
    allowing the UI agent to parse structured data instead of flat text.
    """
    schema_str = json.dumps(expected_schema, indent=2)
    json_system_prompt = (
        f"{system_prompt}\n\n"
        "CRITICAL INSTRUCTION: You MUST return your response ENTIRELY as a valid JSON object. "
        "Do not include Markdown formatting like ```json or any conversational text outside the JSON. "
        f"Your JSON MUST strictly adhere to the following schema structure:\n{schema_str}"
    )
    
    def _intercept_callback(response_text):
        cleaned = response_text.strip()
        if cleaned.startswith("```json"):
            cleaned = cleaned[7:]
        elif cleaned.startswith("```"):
            cleaned = cleaned[3:]
        if cleaned.endswith("```"):
            cleaned = cleaned[:-3]
        cleaned = cleaned.strip()
        
        try:
            parsed_json = json.loads(cleaned)
        except Exception as e:
            print(f"[FORGE-UI] Failed to parse structured AI response: {e}\nRaw Output: {response_text}")
            parsed_json = None
            
        GLib.idle_add(callback, parsed_json)
        
    ask_ai(json_system_prompt, user_prompt, _intercept_callback)

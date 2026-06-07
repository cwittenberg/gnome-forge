# gnome-forge@cwittenberg/library/app_harness.py
#!/usr/bin/env python3
import sys
import importlib
import os
import gi
import inspect
import traceback

gi.require_version('Gtk', '4.0')
gi.require_version('Adw', '1')
from gi.repository import Gtk, Adw, Gio, GLib, Pango

def trigger_rework(app_name, prompt):
    def on_call_done(proxy, res, user_data):
        try:
            proxy.call_finish(res)
        except Exception as e:
            print(f"DBus Rework Trigger Failed: {e}", file=sys.stderr)

    try:
        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        proxy = Gio.DBusProxy.new_sync(bus, Gio.DBusProxyFlags.NONE, None,
            "org.gnome.Shell",
            "/org/gnome/Shell/Extensions/GnomeForge",
            "org.gnome.Shell.Extensions.GnomeForge", None)
        
        proxy.call("ReworkApp", GLib.Variant("(ss)", (app_name, prompt)),
                   Gio.DBusCallFlags.NONE, -1, None, on_call_done, None)
    except Exception as e:
        print(f"Failed to setup DBus Proxy: {e}", file=sys.stderr)

class ForgeHarnessWindow(Adw.ApplicationWindow):
    def __init__(self, app_name, app_widget, **kwargs):
        super().__init__(**kwargs)
        self.app_name = app_name
        
        display_title = ''.join([' ' + char if char.isupper() else char for char in app_name]).strip()
        self.set_title(display_title)
        self.set_default_size(700, 500)

        self.box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        self.set_content(self.box)

        self.header = Adw.HeaderBar()
        self.box.append(self.header)

        self.improve_btn = Gtk.MenuButton()
        self.improve_btn.set_icon_name("document-edit-symbolic")
        self.improve_btn.set_tooltip_text("Improve this app with AI")
        
        self.popover = Gtk.Popover()
        vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        vbox.set_margin_start(12)
        vbox.set_margin_end(12)
        vbox.set_margin_top(12)
        vbox.set_margin_bottom(12)
        
        lbl = Gtk.Label(label="How should the AI improve this app?")
        lbl.add_css_class("heading")
        
        self.entry = Gtk.Entry(placeholder_text="e.g. Add a dark mode toggle...")
        self.entry.set_width_chars(35)
        self.entry.connect("activate", self.on_improve_submit)
        
        submit_btn = Gtk.Button(label="Apply Changes ✨")
        submit_btn.add_css_class("suggested-action")
        submit_btn.connect("clicked", lambda _: self.on_improve_submit(self.entry))

        vbox.append(lbl)
        vbox.append(self.entry)
        vbox.append(submit_btn)
        
        self.popover.set_child(vbox)
        self.improve_btn.set_popover(self.popover)
        self.header.pack_end(self.improve_btn)

        app_widget.set_vexpand(True)
        self.box.append(app_widget)

    def on_improve_submit(self, entry):
        prompt = entry.get_text().strip()
        if prompt:
            trigger_rework(self.app_name, prompt)
            self.close()

    def show_error(self, err_msg):
        err_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        err_box.set_margin_start(12)
        err_box.set_margin_end(12)
        err_box.set_margin_top(12)
        err_box.set_margin_bottom(12)
        err_box.set_vexpand(True)
        
        err_lbl = Gtk.Label(label="Runtime Exception Occurred")
        err_lbl.add_css_class("error")
        err_lbl.add_css_class("title-2")
        
        scroll = Gtk.ScrolledWindow()
        scroll.set_vexpand(True)
        
        err_tv = Gtk.TextView(editable=False, wrap_mode=Gtk.WrapMode.WORD_CHAR)
        err_tv.get_buffer().set_text(err_msg)
        err_tv.add_css_class("monospace")
        scroll.set_child(err_tv)

        err_box.append(err_lbl)
        err_box.append(scroll)
        
        child = self.box.get_last_child()
        if child != self.header:
            self.box.remove(child)
            
        self.box.append(err_box)


def global_exception_handler(exctype, value, tb):
    err_msg = "".join(traceback.format_exception(exctype, value, tb))
    print(f"Harness Caught Exception:\n{err_msg}", file=sys.stderr)
    
    app = Gio.Application.get_default()
    if app and app.props.active_window:
        app.props.active_window.show_error(err_msg)

sys.excepthook = global_exception_handler

class ForgeHarnessApp(Adw.Application):
    def __init__(self, app_name, **kwargs):
        super().__init__(application_id=f"com.vibe.{app_name.lower()}", **kwargs)
        self.app_name = app_name

    def do_activate(self):
        win = self.props.active_window
        if not win:
            try:
                sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
                module = importlib.import_module(self.app_name)
                
                # Graceful dynamic class loading if LLM renames AppWidget
                if hasattr(module, "AppWidget"):
                    app_widget = module.AppWidget()
                else:
                    widget_classes = [obj for name, obj in inspect.getmembers(module, inspect.isclass) if issubclass(obj, Gtk.Widget) and obj.__module__ == module.__name__]
                    if widget_classes:
                        app_widget = widget_classes[0]()
                    else:
                        raise Exception("Developer Error: Generated code is missing 'class AppWidget(Gtk.Box):' and no fallback widget was found.")
                        
            except Exception as e:
                err_msg = traceback.format_exc()
                app_widget = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
                lbl = Gtk.Label(label=f"Failed to load compiled logic:\n{e}")
                tv = Gtk.TextView(editable=False)
                tv.get_buffer().set_text(err_msg)
                app_widget.append(lbl)
                app_widget.append(tv)

            win = ForgeHarnessWindow(self.app_name, app_widget, application=self)
        win.present()

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 app_harness.py <AppModuleName>")
        sys.exit(1)
    app = ForgeHarnessApp(sys.argv[1])
    app.run(None)
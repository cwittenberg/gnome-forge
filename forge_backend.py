#!/usr/bin/env python3
# forge_backend.py

import sys
import os
import json
import urllib.request
import time
import subprocess
import signal
import traceback
import gi

gi.require_version('Gio', '2.0')
gi.require_version('GLib', '2.0')
from gi.repository import Gio, GLib

def get_settings():
    try:
        extension_dir = os.path.dirname(os.path.realpath(__file__))
        schema_dir = os.path.join(extension_dir, "schemas")
        compiled_schema = os.path.join(schema_dir, "gschemas.compiled")
        
        if not os.path.exists(compiled_schema):
            print(f"[FORGE WARNING] Compiled schema not found at {compiled_schema}. Attempting fallback.", file=sys.stderr)
            return Gio.Settings.new("org.gnome.shell.extensions.gnome-forge")
            
        schema_source = Gio.SettingsSchemaSource.new_from_directory(
            schema_dir, Gio.SettingsSchemaSource.get_default(), False
        )
        schema = schema_source.lookup("org.gnome.shell.extensions.gnome-forge", False)
        if not schema:
            raise RuntimeError("GSettings schema lookup failed. Ensure it is compiled.")
        return Gio.Settings.new_full(schema, None, None)
    except Exception as e:
        print(f"[FORGE ERROR] Failed to load settings: {e}", file=sys.stderr)
        sys.exit(1)

def call_llm(system_prompt, user_prompt):
    settings = get_settings()
    provider = settings.get_string("provider")
    
    if provider == "ollama":
        url = settings.get_string("ollama-url").rstrip('/') + "/api/chat"
        model = settings.get_string("ollama-model")
        payload = {
            "model": model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt}
            ],
            "stream": False
        }
        headers = {'Content-Type': 'application/json'}
        req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'), headers=headers)
        response = urllib.request.urlopen(req, timeout=180)
        result = json.loads(response.read().decode('utf-8'))
        return result['message']['content']
        
    elif provider == "openai":
        api_key = settings.get_string("openai-api-key")
        model = settings.get_string("openai-model")
        url = "[https://api.openai.com/v1/chat/completions](https://api.openai.com/v1/chat/completions)"
        payload = {
            "model": model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt}
            ]
        }
        headers = {
            'Content-Type': 'application/json',
            'Authorization': f'Bearer {api_key}'
        }
        req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'), headers=headers)
        response = urllib.request.urlopen(req, timeout=180)
        result = json.loads(response.read().decode('utf-8'))
        return result['choices'][0]['message']['content']

    elif provider == "gemini":
        api_key = settings.get_string("gemini-api-key")
        model = settings.get_string("gemini-model")
        url = f"[https://generativelanguage.googleapis.com/v1beta/models/](https://generativelanguage.googleapis.com/v1beta/models/){model}:generateContent?key={api_key}"
        payload = {
            "contents": [
                {"role": "user", "parts": [{"text": f"System: {system_prompt}\n\nUser: {user_prompt}"}]}
            ]
        }
        headers = {'Content-Type': 'application/json'}
        req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'), headers=headers)
        response = urllib.request.urlopen(req, timeout=180)
        result = json.loads(response.read().decode('utf-8'))
        return result['candidates'][0]['content']['parts'][0]['text']
    else:
        raise ValueError(f"Unknown provider: {provider}")

def extract_code(text):
    if "```python" in text:
        parts = text.split("```python")
        if len(parts) > 1:
            return parts[1].split("```")[0].strip()
    elif "```" in text:
        parts = text.split("```")
        if len(parts) > 1:
            return parts[1].strip()
    return text.strip()

class AppRunner:
    def __init__(self, app_path):
        self.app_path = app_path
        self.process = None
        self.monitor = None
        self.loop = GLib.MainLoop()

    def start_app(self):
        if self.process:
            self.process.terminate()
            self.process.wait()
        print(f"[FORGE RUNNER] Executing {self.app_path}...", file=sys.stderr)
        self.process = subprocess.Popen(["python3", self.app_path])

    def on_file_changed(self, monitor, file, other_file, event_type):
        if event_type in (Gio.FileMonitorEvent.CHANGES_DONE_HINT, Gio.FileMonitorEvent.CREATED):
            print(f"[FORGE RUNNER] Code change detected in {self.app_path}. Hot-reloading immediately...", file=sys.stderr)
            self.start_app()

    def run(self):
        self.start_app()
        
        gfile = Gio.File.new_for_path(self.app_path)
        self.monitor = gfile.monitor_file(Gio.FileMonitorFlags.NONE, None)
        self.monitor.connect("changed", self.on_file_changed)
        
        print("[FORGE RUNNER] Watching for file changes. Press Ctrl+C to exit.", file=sys.stderr)
        
        try:
            self.loop.run()
        except KeyboardInterrupt:
            if self.process:
                self.process.terminate()
            self.loop.quit()
            print("\n[FORGE RUNNER] Shutting down.", file=sys.stderr)

def forge_app(user_prompt):
    extension_dir = os.path.dirname(os.path.realpath(__file__))
    library_dir = os.path.join(extension_dir, "library")
    os.makedirs(library_dir, exist_ok=True)
    
    original_code = ""
    app_base_name = ""
    
    if user_prompt.startswith("Rework"):
        parts = user_prompt.split(":", 1)
        if len(parts) == 2:
            filename = parts[0].replace("Rework", "").strip()
            user_prompt = parts[1].strip()
            filepath = os.path.join(library_dir, filename)
            if os.path.exists(filepath):
                with open(filepath, "r") as f:
                    original_code = f.read()
                app_base_name = filename.replace(".py", "") + "_reworked"

    if not app_base_name:
        first_word = user_prompt.split()[0].lower()
        app_base_name = f"{first_word}_{int(time.time())}"
        
    app_base_name = ''.join(e for e in app_base_name if e.isalnum() or e == '_')

    arch_sys = "You are a software architect. Design a self-contained single-file Python GTK4 application (using PyGObject). Respond ONLY with the strict technical requirements, necessary Gtk widgets, and data structure. CRITICAL: Determine if the app needs AI logic or just local algorithms (e.g. math). DO NOT use AI for basic local tasks. Include keybindings and visual feedback for good UX. NEVER lose context during an improvement rework. DO NOT change the existing design or drop things the user did not ask to change. If the user asks for a specific visual aesthetic (like 'Encarta 95'), explicitly architect the use of a Gtk.CssProvider to mimic it exactly; otherwise maintain the Yaru look and feel (Ubuntu style, orange accents). Specify that UI panels must use fluid layouts (hexpand/vexpand) to maximize screen real estate. Ensure the architecture specifies fully functional UI elements with NO mock buttons."
    arch_user = user_prompt

    if original_code:
        arch_user += f"\n\nEXISTING SOURCE CODE TO MODIFY:\n{original_code}"
    
    print("Architecting structural requirements...", file=sys.stderr)
    architecture = call_llm(arch_sys, arch_user)
    
    eng_sys = "You are a senior GTK4 Python engineer. Write the full executable code for the app based strictly on the provided architecture. Output ONLY the complete, fully implemented Python code wrapped in ```python ... ```. Do not omit any logic, placeholders, or dummy data. Generating mock buttons with unimplemented functionality is unacceptable. You must iteratively generate a fully functional working app in one go based on the prompt. Ensure local operations (like arithmetic) are done in pure Python. Only use ask_ai for complex reasoning or when search fields demand external API integration. DO NOT make everything Markdown; use ForgeMarkdown for long text, but ForgeLabel/ForgeEntry for short answers. Add keyboard event listeners for desktop UX. Ensure non-game apps are fully fluid using set_hexpand(True) and set_vexpand(True). If a specific theme is requested, implement it rigorously using a Gtk.CssProvider with custom CSS; otherwise maintain Yaru using appropriate CSS. Log AI prompts and results via print() for debug visibility. DO NOT alter existing logic or design when doing a rework unless requested."
    print("Engineering logic & UI...", file=sys.stderr)
    code_response = call_llm(eng_sys, f"Architecture & Directives:\n{architecture}\n\nTask: Implement the application.")
    raw_code = extract_code(code_response)
    
    test_sys = "You are a strict QA tester. Review the provided Python GTK4 code. Fix any missing imports (e.g., gi.require_version('Gtk', '4.0'), import gi), syntax errors, or UI loops. Ensure the application can run standalone. Check that it doesn't unnecessarily route basic local logic to AI. You must functionally test EVERYTHING is working before returning the code. Ensure absolutely NO mock buttons with unimplemented functionality exist. Ensure keyboard bindings exist if applicable. Verify ForgeMarkdown is only used for advanced texts, not everything. Verify the app uses dynamic resizing (hexpand/vexpand) and doesn't rely on fixed sizing for non-game apps. Verify custom themes are implemented via CSS if requested, or the Yaru look and feel is maintained. Ensure it didn't drop existing features if this was a rework. Output ONLY the fully corrected, runnable python code wrapped in ```python ... ```."
    print("Testing against GNOME requirements...", file=sys.stderr)
    final_response = call_llm(test_sys, raw_code)
    final_code = extract_code(final_response)
    
    app_path = os.path.join(library_dir, f"{app_base_name}.py")
    
    # --- NEW COMPILATION AND DRY RUN LOOP ---
    max_attempts = 3
    attempt = 1
    success = False

    while attempt <= max_attempts and not success:
        print(f"Building safe instantiation (Attempt {attempt}/{max_attempts})...", file=sys.stderr)
        
        with open(app_path, "w") as f:
            f.write(final_code)

        # 1. Syntax Check
        compile_proc = subprocess.run(['python3', '-m', 'py_compile', app_path], capture_output=True, text=True)
        if compile_proc.returncode != 0:
            print(f"[FORGE ERROR] Syntax compilation failed:\n{compile_proc.stderr}", file=sys.stderr)
            repair_sys = f"Fix syntax error:\n{compile_proc.stderr}\nOutput ONLY fully corrected python code. No explanations."
            final_code = extract_code(call_llm(repair_sys, final_code))
            attempt += 1
            continue

        # 2. GTK Instantiation Dry Run
        dry_run_script = f"""
import sys
import traceback
import gi
gi.require_version('Gtk', '4.0')
from gi.repository import Gtk

sys.path.insert(0, '{library_dir}')

try:
    import {app_base_name}
    if hasattr({app_base_name}, 'AppWidget'):
        widget = {app_base_name}.AppWidget()
        if not isinstance(widget, Gtk.Box):
            raise Exception("Developer Error: AppWidget MUST inherit from Gtk.Box")
    else:
        raise Exception("Developer Error: Generated code is explicitly missing 'class AppWidget(Gtk.Box):'")
except Exception as e:
    print(traceback.format_exc(), file=sys.stderr)
    sys.exit(1)
sys.exit(0)
"""
        dry_run_proc = subprocess.run(['python3', '-c', dry_run_script], capture_output=True, text=True)
        
        if dry_run_proc.returncode != 0:
            print(f"[FORGE ERROR] GTK instantiation dry-run failed:\n{dry_run_proc.stderr}", file=sys.stderr)
            repair_sys = f"Fix GTK runtime instantiation error:\n{dry_run_proc.stderr}\nIdentify which widget or library call threw this error and fix it. You MUST ensure the class is exactly 'class AppWidget(Gtk.Box):'. Output ONLY fully corrected python code. No explanations."
            final_code = extract_code(call_llm(repair_sys, final_code))
            attempt += 1
            continue

        success = True
        print("[FORGE] QA and Dry-run successful!", file=sys.stderr)

    if not success:
        print(f"[FORGE FATAL] CRITICAL FAILURE: The application failed to compile or instantiate after {max_attempts} repair attempts.", file=sys.stderr)
        sys.exit(1)

    # Wrap passing code with Forge Context
    header = f'"""\nFORGE CONTEXT\nOriginal Prompt: {user_prompt}\n"""\n\n'
    final_code = header + final_code
    
    with open(app_path, "w") as f:
        f.write(final_code)
        
    print(f"App successfully compiled and verified at: {app_path}", file=sys.stderr)
    
    runner = AppRunner(app_path)
    runner.run()

if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[1] == "generate":
        prompt = sys.argv[2]
        forge_app(prompt)
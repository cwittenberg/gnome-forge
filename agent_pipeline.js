// agent_pipeline.js
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { getProviderInstance } from './llm_provider.js';
import { ForgeTools } from './forge_tools.js';

export class AgentPipeline {
    constructor(extensionPath, settings) {
        this._extensionPath = extensionPath;
        this._settings = settings;
    }

    _getActiveProfile() {
        const activeId = this._settings.get_string('active-profile-id');
        const profilesRaw = this._settings.get_string('llm-profiles');
        const profiles = JSON.parse(profilesRaw || '[]');
        return profiles.find(p => p.id === activeId) || profiles[0];
    }

    _readFile(filepath) {
        let file = Gio.File.new_for_path(filepath);
        if (!file.query_exists(null)) return "";
        let [ok, contents] = file.load_contents(null);
        if (ok) return new TextDecoder('utf-8').decode(contents);
        return "";
    }

    _writeFile(filepath, content) {
        let file = Gio.File.new_for_path(filepath);
        file.replace_contents(content, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    }

    _extractPythonMethodBody(source, methodName) {
        const escapedName = methodName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const methodRegex = new RegExp(`^(\\s*)def\\s+${escapedName}\\s*\\(`);
        const lines = (source || "").split('\n');

        for (let i = 0; i < lines.length; i++) {
            const match = lines[i].match(methodRegex);
            if (!match) continue;

            const methodIndent = match[1].length;
            const body = [];

            for (let j = i + 1; j < lines.length; j++) {
                const line = lines[j];
                const trimmed = line.trim();
                const lineIndent = line.search(/\S/);

                if (trimmed && lineIndent <= methodIndent && /^(?:def|class|@|\S)/.test(line.slice(lineIndent))) {
                    break;
                }

                body.push(line);
            }

            return body.join('\n');
        }

        return "";
    }

    _restartButtonTargetResetsState(source) {
        const buttonRegex = /(?:ForgeButton|Gtk\.Button)\s*\(([^)]*(?:restart|try again|play again)[^)]*)\)/gi;
        let match;

        while ((match = buttonRegex.exec(source || "")) !== null) {
            const args = match[1] || "";
            const targetMatch = args.match(/on_click\s*=\s*(?:self\.)?([A-Za-z_]\w*)/);
            if (!targetMatch) continue;

            const targetName = targetMatch[1];
            if (/^(?:restart|restart_game|reset_game|restart_callback)$/.test(targetName)) {
                return true;
            }

            const body = this._extractPythonMethodBody(source, targetName);
            if (/\b(?:self\.)?(?:logic\.)?(?:reset_game|restart_game)\s*\(/.test(body) &&
                /\bstate\s*=\s*["'](?:PLAYING|PLAY|MENU)["']/.test(body)) {
                return true;
            }
        }

        return false;
    }

    _formatRequirementAuditEvidence(userPrompt, appBaseName, libraryDirPath, specText = "") {
        const files = [
            `${appBaseName}.py`,
            `${appBaseName}_logic.py`,
            `${appBaseName}_ui.py`,
        ];
        const combined = files
            .map((name) => this._readFile(GLib.build_filenamev([libraryDirPath, name])))
            .join("\n\n");
        const evidenceLines = combined
            .split('\n')
            .filter((line) => /restart|try again|play again|ImageSurface|SurfacePattern|set_source_surface|ForgeSprite|ForgeTextureManager|CssProvider|add_css_class|set_name|style_class|gameover|overlay|hud|menu/i.test(line))
            .slice(0, 120)
            .join('\n');

        const buttonTargetResets = this._restartButtonTargetResetsState(combined);
        const hasTextureMarker = /\bget_cairo_surface\s*\(|\bForgeSprite\s*\(|image_path\s*=|set_source_surface\s*\(|\bcairo\.ImageSurface\b|\bImageSurface\s*\(|\bSurfacePattern\b/i.test(combined);
        const hasVisualStyleMarker = /\bGtk\.CssProvider\b|\.add_css_class\s*\(\s*["'][^"']*(?:game|arcade|hud|board|score|menu|overlay|background|title|panel|screen)[^"']*["']|\.set_name\s*\(|ForgeAnimatedBackground|LinearGradient|RadialGradient|SurfacePattern/i.test(combined);

        return `Current deterministic audit evidence:
- Restart button target detected as reset-capable: ${buttonTargetResets ? 'yes' : 'no'}
- Texture/sprite/image-surface marker detected: ${hasTextureMarker ? 'yes' : 'no'}
- Visual style marker detected: ${hasVisualStyleMarker ? 'yes' : 'no'}

Accepted restart fixes:
- Prefer a dedicated \`def restart_game(self, *args):\` that calls \`self.logic.reset_game()\`, sets state back to PLAYING/PLAY, hides the game-over overlay, resets HUD-visible state, and calls \`self.grab_focus()\`.
- Wire the visible Restart/Try Again/Play Again button directly with \`on_click=self.restart_game\`.

Accepted texture fixes:
- Use the \`generate_texture\` tool to create PNGs and load them with \`ForgeTextureManager.get_cairo_surface(...)\`, or \`image_path=\`.
- Grid lines, gradients, arcs, and colored rectangles alone do not satisfy the texture audit.

Accepted visual-style fixes:
- Add executable GTK style markers in \`AppWidget.__init__\`: create \`self.css_provider = Gtk.CssProvider()\`, load CSS rules for game UI regions, register it only when \`Gdk.Display.get_default()\` returns a display, and call \`add_css_class\` or \`set_name\` on the game shell, overlay, HUD, menu, and game-over overlay.
- Recommended class names: \`game-shell\`, \`game-overlay\`, \`game-hud\`, \`game-menu\`, \`game-over-screen\`, and \`game-title\`.
- Cairo-only decoration, comments, and \`ForgeLabel(style_class="title")\` are not enough; the generated source must include audit-visible \`Gtk.CssProvider\`, \`add_css_class\`, or \`set_name\` calls.

Relevant current source lines:
${evidenceLines || '(none)'}`;
    }

    async _repairRequirementAudit(llm, rescueSystem, structuredPrompt, appBaseName, targetFilename, libraryDirPath, specText, progressCallback, abortSignal, phaseStart) {
        let auditFailures = this._auditGeneratedApp(structuredPrompt, appBaseName, libraryDirPath, specText);
        const maxAuditRescueAttempts = 3;

        for (let attempt = 1; auditFailures.length > 0 && attempt <= maxAuditRescueAttempts; attempt++) {
            progressCallback(phaseStart, `Requirement audit failed. Dispatching Rescue Agent (${attempt}/${maxAuditRescueAttempts})...`);
            const phaseEnd = Math.min(0.99, phaseStart + 0.04);
            let rescuePrompt = `CRITICAL REQUIREMENT AUDIT FAILURE for ${targetFilename}.

Original user prompt:
${structuredPrompt}

Audit failures:
${auditFailures.map((failure) => `- ${failure}`).join('\n')}

${this._formatRequirementAuditEvidence(structuredPrompt, appBaseName, libraryDirPath, specText)}

Fix the application using apply_patch. You MUST preserve the existing AppWidget entrypoint. Do not satisfy the audit by comments or prose; the required source markers must exist in executable code. After patching, run python3 ${appBaseName}_test.py and python3 -m py_compile ${targetFilename}. Do not call finish_task until the audit failures are genuinely fixed, not merely renamed.`;

            await this._runReActLoop(
                llm,
                rescueSystem,
                rescuePrompt,
                libraryDirPath,
                (p, msg) => progressCallback(Math.min(phaseEnd, phaseStart + (p * (phaseEnd - phaseStart))), msg),
                abortSignal,
                `Requirement_Audit_Rescue_${attempt}`
            );

            auditFailures = this._auditGeneratedApp(structuredPrompt, appBaseName, libraryDirPath, specText);
        }

        return auditFailures;
    }

    _loadAgentsConfig() {
        let filepath = GLib.build_filenamev([this._extensionPath, 'agents.json']);
        let content = this._readFile(filepath);
        if (!content) {
            throw new Error("Could not read agents.json. Make sure the file exists in the extension directory.");
        }
        try {
            return JSON.parse(content);
        } catch (e) {
            throw new Error("Failed to parse agents.json: " + e.message);
        }
    }

    _deployDependencies(libraryDirPath) {
        const filesToCopy = [
            'app_harness.py', 
            'forge_ui.py', 
            'forge_game_math.py', 
            'forge_game_textures.py', 
            'forge_game_core.py', 
            'forge_game_entities.py', 
            'forge_game_level.py'
        ];
        
        for (const filename of filesToCopy) {
            const sourcePath = GLib.build_filenamev([this._extensionPath, filename]);
            const destPath = GLib.build_filenamev([libraryDirPath, filename]);
            
            try {
                const sourceFile = Gio.File.new_for_path(sourcePath);
                const destFile = Gio.File.new_for_path(destPath);
                sourceFile.copy(destFile, Gio.FileCopyFlags.OVERWRITE, null, null);
                if (filename === 'app_harness.py') {
                    let info = destFile.query_info('unix::mode', Gio.FileQueryInfoFlags.NONE, null);
                    let mode = info.get_attribute_uint32('unix::mode');
                    info.set_attribute_uint32('unix::mode', mode | 0o111);
                    destFile.set_attributes_from_info(info, Gio.FileQueryInfoFlags.NONE, null);
                }
            } catch (e) {
                console.warn("[GNOME-FORGE] Could not deploy dependency " + filename + ": " + e.message);
            }
        }
    }

    _runSubprocess(cmdArray) {
        return new Promise((resolve) => {
            try {
                console.log("[GNOME-FORGE] Running subprocess: " + cmdArray.join(' '));
                let proc = Gio.Subprocess.new(cmdArray, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
                proc.communicate_utf8_async(null, null, (obj, res) => {
                    try {
                        const [ok, out, err] = obj.communicate_utf8_finish(res);
                        if (out) console.log("[GNOME-FORGE-STDOUT] " + out.trim());
                        if (err) console.error("[GNOME-FORGE-STDERR] " + err.trim());
                        resolve([ok && proc.get_successful(), out || "", err || ""]);
                    } catch (e) {
                        console.error("[GNOME-FORGE-ERROR] Subprocess communicate failed: " + e.message);
                        resolve([false, '', e.message]);
                    }
                });
            } catch (e) {
                console.error("[GNOME-FORGE-ERROR] Subprocess launch failed: " + e.message);
                resolve([false, '', e.message]);
            }
        });
    }

    _auditInvalidGtkMethodCalls(source) {
        const constructorsByVar = new Map();
        const assignmentRegex = /(?:self\.)?([A-Za-z_]\w*)\s*=\s*((?:Gtk|Adw)\.[A-Za-z_]\w*|Forge[A-Za-z_]\w*)\s*\(/g;
        let assignment;

        while ((assignment = assignmentRegex.exec(source || "")) !== null) {
            constructorsByVar.set(assignment[1], assignment[2]);
        }

        const invalidByConstructor = {
            "Gtk.Box": new Set(["set_title", "set_subtitle", "set_child", "add"]),
            "Gtk.ScrolledWindow": new Set(["append", "add"]),
            "Gtk.FlowBox": new Set(["add", "child_is_selected"]),
            "Gtk.ListBox": new Set(["get_selected"]),
        };
        const failures = [];
        const seen = new Set();

        for (const [varName, constructor] of constructorsByVar.entries()) {
            const invalidMethods = invalidByConstructor[constructor];
            if (!invalidMethods) continue;

            const escapedName = varName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const callRegex = new RegExp(`(?:self\\.)?${escapedName}\\.([A-Za-z_]\\w*)\\s*\\(`, "g");
            let call;

            while ((call = callRegex.exec(source || "")) !== null) {
                const method = call[1];
                if (!invalidMethods.has(method)) continue;

                const key = `${constructor}.${method}.${varName}`;
                if (seen.has(key)) continue;
                seen.add(key);
                failures.push(`Invalid GTK method call: ${constructor} variable '${varName}' calls ${method}(), which is not valid for that widget type.`);
            }
        }

        return failures;
    }

    _auditGeneratedApp(userPrompt, appBaseName, libraryDirPath, specText = "") {
        const prompt = (userPrompt || "").toLowerCase();
        const specLower = (specText || "").toLowerCase();
        const requirementText = `${prompt}\n${specLower}`;
        const requestedAi = /\b(ai|artificial intelligence|llm|semantic)\b/.test(prompt);
        const requestedSearch = /\b(search|find|query|discover)\b/.test(prompt);
        const requestedImages = /\b(image|images|picture|pictures|photo|photos|media)\b/.test(prompt);
        const forbidsPlaceholders = /\b(no placeholders?|no mockups?|not placeholders?|not mockups?|real|actual)\b/.test(prompt);
        const isGame = /\b(game|arcade|platformer|top-?down|fps|card game|snake|nibbles|minesweeper|mario|pong|tetris|breakout)\b/.test(requirementText) ||
            /(?:platform_game|topdown_game|fps_game|card_game)/i.test(specText || "");

        const files = [
            `${appBaseName}.py`,
            `${appBaseName}_logic.py`,
            `${appBaseName}_ui.py`,
        ];
        const combined = files
            .map((name) => this._readFile(GLib.build_filenamev([libraryDirPath, name])))
            .join("\n\n");
        const lower = combined.toLowerCase();
        const failures = [];

        if (requestedAi && requestedSearch && !/\bask_ai(?:_structured)?\s*\(/.test(combined)) {
            failures.push("The user requested AI-powered search, but the generated app does not call ask_ai or ask_ai_structured.");
        }

        if (requestedImages && !/\bfetch_web_image\s*\(|set_from_file\s*\(|set_from_pixbuf\s*\(|set_from_paintable\s*\(/.test(combined)) {
            failures.push("The user requested article images, but the generated app has no real image fetch/load path.");
        }

        if ((requestedAi || forbidsPlaceholders) && /\b(simulates?|dummy|mock(?:up)?|proof-of-concept|hardcoded|fallback)\b|placeholder\s+(?:for|implementation|data|content|image|ui)/.test(lower)) {
            failures.push("The generated source contains simulation/mock/placeholder language despite explicit fidelity requirements.");
        }

        if (requestedImages && forbidsPlaceholders && /image-missing|missing image|fallback to icon|set_from_icon_name/.test(lower)) {
            failures.push("The image implementation is fallback-only instead of providing actual article images.");
        }

        if (/\bpass\b/.test(lower)) {
            failures.push("The generated source still contains app-specific pass statements; production app/game code must implement every declared method.");
        }

        failures.push(...this._auditInvalidGtkMethodCalls(combined));

        if (isGame) {
            const hasGameOverState = /\bgame[_ ]?over\b|GAMEOVER|game_over/i.test(combined);
            const hasOverlay = /\bGtk\.Overlay\b|\.add_overlay\s*\(/.test(combined);
            const hasRestartMethod = /\bdef\s+(?:restart|reset)_game\s*\(|\bdef\s+restart\s*\(|\bdef\s+reset\s*\(/.test(combined);
            const hasRestartControl = /(?:ForgeButton|Gtk\.Button)\s*\([^)]*(?:restart|try again|play again)|\.set_label\s*\(\s*["'][^"']*(?:restart|try again|play again)/i.test(combined);
            const hasRestartWiring = /on_click\s*=\s*(?:self\.)?(?:restart|restart_game|reset_game|restart_callback)|connect\s*\(\s*["']clicked["'][^)]*(?:restart|reset)/i.test(combined) ||
                this._restartButtonTargetResetsState(combined);
            const hasTexturePipeline = /\bget_cairo_surface\s*\(|\bForgeSprite\s*\(|image_path\s*=|set_source_surface\s*\(|\bcairo\.ImageSurface\b|\bImageSurface\s*\(|\bSurfacePattern\b/i.test(combined);
            const hasCustomVisualStyle = /\bGtk\.CssProvider\b|\.add_css_class\s*\(\s*["'][^"']*(?:game|arcade|hud|board|score|menu|overlay|background|title|panel|screen)[^"']*["']|\.set_name\s*\(|ForgeAnimatedBackground|LinearGradient|RadialGradient|SurfacePattern/i.test(combined);

            if (!hasGameOverState || !hasOverlay) {
                failures.push("Game output must include a visible game-over/menu overlay or screen state, not only a score label update.");
            }

            if (!hasRestartMethod || !hasRestartControl || !hasRestartWiring) {
                failures.push("Game output must include a visible restart/play-again control wired to reset the game state.");
            }

            if (!hasCustomVisualStyle) {
                failures.push("Game output must include an intentional visual template/background/HUD style, not bare default GTK plus a flat canvas.");
            }

            if (!hasTexturePipeline) {
                failures.push("Game output must use sprites, loaded textures, or generated Cairo image-surface textures for the board/entities/background.");
            }
        }

        return failures;
    }

    async _generateApiReflection(libraryDirPath) {
        const pyScript = `import sys
import inspect
sys.path.insert(0, '${libraryDirPath}')

try:
    import forge_ui
    import forge_game_math
    import forge_game_textures
    import forge_game_core
    import forge_game_entities
    import forge_game_level
    import gi
    gi.require_version('Gtk', '4.0')
    from gi.repository import Gtk

    output = "DYNAMIC API REFLECTION:\\n"
    
    modules = [
        (forge_ui, 'forge_ui'), 
        (forge_game_math, 'forge_game_math'), 
        (forge_game_textures, 'forge_game_textures'),
        (forge_game_core, 'forge_game_core'),
        (forge_game_entities, 'forge_game_entities'),
        (forge_game_level, 'forge_game_level')
    ]
    
    for module, mod_name in modules:
        output += f"\\n--- {mod_name} ---\\n"
        for name, obj in inspect.getmembers(module):
            if inspect.isclass(obj) and name.startswith('Forge'):
                try:
                    sig = str(inspect.signature(obj.__init__)).replace('(self, ', '(').replace('(self)', '()')
                    output += "- " + name + sig + ": "
                except Exception:
                    output += "- " + name + ": "
                
                method_strings = []
                for m_name, m_obj in inspect.getmembers(obj):
                    if not m_name.startswith('_') and inspect.isroutine(m_obj):
                        try:
                            m_sig = str(inspect.signature(m_obj)).replace('(self, ', '(').replace('(self)', '()')
                            method_strings.append(m_name + m_sig)
                        except Exception:
                            method_strings.append(m_name)
                
                output += "Valid Methods -> " + ", ".join(method_strings) + "\\n"
            elif inspect.isfunction(obj) and (name.startswith('Forge') or name.startswith('fetch_') or name.startswith('ask_')):
                sig = inspect.signature(obj)
                output += "- " + name + str(sig) + "\\n"

    output += """
GTK4 & FORGE ANTI-HALLUCINATION RULES:
- GTK Focus Loss: If you remove a Main Menu to show the Game, the app loses focus! You MUST call self.grab_focus() on the game container immediately after removing the menu so ForgeInput continues to capture keys.
- Drawing Area Collapse: ForgeDrawingArea will shrink to 0x0 if not explicitly sized. You MUST call drawing_area.set_size_request(800, 600) to ensure it is visible.
- ForgeLevelGenerator: MUST BE USED for generating 30+ room levels/BSPs. E.g. grid, rooms, spawns = ForgeLevelGenerator.generate_bsp_dungeon(64, 64). Use the 'spawns' array (contains dicts with 'type', 'x', 'y') to reliably place the player, enemies, weapons, and ammo in empty room spaces.
- 3D Physics & Interaction: To prevent walking through walls, the Player MUST have width (e.g. 0.4) and height (0.4) and you MUST use ForgeTileMap(grid, tile_size=1).resolve_physics(player). For doors (grid value 2), check the grid cell in front of the player, set to 0 to open, and call tilemap.rebuild_colliders().
- 3D Pickups & Animations: Implement weapons, ammo, and health pickups by spawning ForgeItem instances from the 'spawns' data. Animate sprites by cycling their texture_id (e.g., using ForgeAnimatedSprite) in the update() loop.
- Texture Generation: You MUST use the 'generate_texture' native tool to create .png files (e.g., 'assets/brick.png') and load them via 'ForgeTextureManager.get_cairo_surface(os.path.join(os.path.dirname(__file__), "assets/brick.png"))' (ensure you import os). Do NOT hardcode colors/shapes in Python.
- ForgeRaycaster: For 3D FPS games, use ForgeRaycaster.render(cr, map_data, px, py, dir_x, dir_y, plane_x, plane_y, width, height, textures=tex_dict, sprites=sprite_array). MUST pass a populated textures dictionary (mapping int ID to cairo.ImageSurface) and a list of entities with x, y, and texture_id attributes.
- ForgeInput: Initialize with self.input = ForgeInput(self) inside AppWidget. Use self.input.is_pressed("w") to check keys.
- ForgeGameLoop: Constructor is (update_func, fps=60). The update_func MUST accept a 'dt' (delta time) argument. MUST call self.drawing_area.queue_draw() inside your update_func.
- Game Visual Style: Game AppWidget classes MUST include executable GTK style markers, not only Cairo decoration. Create self.css_provider = Gtk.CssProvider(), load CSS for game-shell/game-hud/game-menu/game-over-screen regions, register it only when Gdk.Display.get_default() returns a display, and call add_css_class or set_name on those real widgets.
- AppWidget Scoping: All CSS styling (Gtk.CssProvider), Keyboard Controllers (ForgeInput), and Mouse Tracking (ForgeMouse) MUST be applied directly to the AppWidget class. CRITICAL: AppWidget MUST have a parameterless constructor: def __init__(self):
"""
    print(output)
except Exception as e:
    print("CRITICAL FORGE_UI API DEFINITIONS (Fallback):\\nError: " + str(e))
`;
        let [ok, out, err] = await this._runSubprocess(['python3', '-c', pyScript]);
        return ok ? out.trim() : out.trim() || err.trim();
    }

    async _runReActLoop(llm, systemPrompt, initialMessage, workspacePath, progressCallback, abortSignal, agentName) {
        let messages = [{ role: 'user', content: initialMessage }];
        let maxSteps = 30;
        let toolsInstance = new ForgeTools(workspacePath, llm);
        let schemas = toolsInstance.getToolSchemas();

        console.warn(`\n========== [DEBUG GNOME-FORGE] PIPELINE INIT: ${agentName} ==========`);
        console.warn(`[SYSTEM PROMPT]\n${systemPrompt}\n`);

        for (let i = 0; i < maxSteps; i++) {
            if (abortSignal && abortSignal.cancelled) throw new Error("Cancelled by user");
            progressCallback(0.2 + (i * 0.03), "[" + agentName + "] Analyzing & Executing Tool (Iter " + (i+1) + ")...");

            console.warn(`\n--- [DEBUG GNOME-FORGE] ${agentName} TURN ${i+1} INPUT ---`);
            console.warn(messages[messages.length - 1].content);

            let response = await llm.chat(systemPrompt, messages, schemas);
            let assistantLog = response.content || "";

            console.warn(`\n--- [DEBUG GNOME-FORGE] ${agentName} TURN ${i+1} RAW OUTPUT ---`);
            console.warn(`Content: ${assistantLog}`);
            if (response.toolCalls) {
                console.warn(`Tool Calls: ${JSON.stringify(response.toolCalls, null, 2)}`);
            }

            if (!response.toolCalls || response.toolCalls.length === 0) {
                messages.push({ role: 'assistant', content: assistantLog });
                messages.push({ 
                    role: 'user', 
                    content: "SYSTEM FATAL: No native tool call detected. You MUST execute an action using a tool in every turn. Do not just output text." 
                });
                continue;
            }

            let toolCall = response.toolCalls[0];
            let tool = toolCall.name;
            let args = toolCall.args || {};
            
            console.log("[GNOME-FORGE-AGENT] " + agentName + " executing Tool: " + tool);

            if (tool === 'finish_task') {
                return args.final_output || "Agent " + agentName + " finished successfully.";
            }

            let result = await toolsInstance.executeTool(tool, args);

            assistantLog += `\n[Invoked Native Tool: ${tool} with args: ${JSON.stringify(args)}]`;
            messages.push({ role: 'assistant', content: assistantLog.trim() });
            
            messages.push({ 
                role: 'user', 
                content: `TOOL RESULT:\n${result}\n\nAnalyze this output. If your patch or bash command failed, you must correct it immediately. Use read_file or list_files if you lack context. If your goal is met and everything is functioning correctly, you MUST call 'finish_task' to conclude the loop.` 
            });
        }

        throw new Error("Agent [" + agentName + "] exceeded maximum ReAct loops without finishing.");
    }

    async execute(userPrompt, notifyCallback, progressCallback, successCallback, abortSignal) {
        console.log("[GNOME-FORGE] Booting Sequential & Diff Pipeline");
        const profile = this._getActiveProfile();
        if (!profile) {
            throw new Error("No LLM profiles match configuration keys. Open settings panel.");
        }

        const agentsConfig = this._loadAgentsConfig();
        const llm = getProviderInstance(profile);
        const libraryDirPath = GLib.build_filenamev([this._extensionPath, 'library']);
        GLib.mkdir_with_parents(libraryDirPath, 0o755);
        
        this._deployDependencies(libraryDirPath);

        let originalCode = '';
        let appBaseName = '';
        let structuredPrompt = userPrompt;
        let isRework = false;

        if (abortSignal && abortSignal.cancelled) throw new Error("Cancelled by user");
        progressCallback(0.05, "Reflecting on GTK API constraints...");
        
        const FORGE_API_DOCS = await this._generateApiReflection(libraryDirPath);

        if (userPrompt.startsWith('Rework')) {
            let parts = userPrompt.split(':');
            if (parts.length >= 2) {
                appBaseName = parts[0].replace('Rework', '').trim();
                structuredPrompt = parts.slice(1).join(':').trim();
                let filepath = GLib.build_filenamev([libraryDirPath, appBaseName + '.py']);
                originalCode = this._readFile(filepath);
                
                if (originalCode) {
                    isRework = true;
                    try {
                        let bakpath = GLib.build_filenamev([libraryDirPath, appBaseName + '.py.bak']);
                        this._writeFile(bakpath, originalCode);
                    } catch (e) {
                        console.warn("[GNOME-FORGE] Could not create backup for " + appBaseName + ": " + e.message);
                    }
                }
            }
        }

        if (!appBaseName) {
            appBaseName = structuredPrompt.split(' ')[0].replace(/[^a-zA-Z]/g, '') + "App_" + Date.now();
        }
        const targetFilename = appBaseName + ".py";

        const agentBaseSystem = agentsConfig.base_system
            .replace('{FORGE_API_DOCS}', FORGE_API_DOCS);

        const getSystemPrompt = (roleKey) => {
            return agentsConfig[roleKey]
                .replace('{base_system}', agentBaseSystem)
                .replace(/\{targetFilename\}/g, targetFilename)
                .replace(/\{appBaseName\}/g, appBaseName)
                .replace(/\{originalPrompt\}/g, structuredPrompt);
        };

        if (abortSignal && abortSignal.cancelled) throw new Error("Cancelled by user");

        let specContent = '';
        let expansionText = '';

        if (!isRework) {
            progressCallback(0.1, "Planner Agent expanding requirements into a full app spec...");
            let plannerSystem = getSystemPrompt('planner_agent');
            let plannerPrompt = `The user requested: '${structuredPrompt}'.\nExpand this into a detailed technical and UX specification in ${appBaseName}_spec.txt. CRITICAL: Put a SUCCESS CRITERIA section near the top of the spec before implementation details. These criteria define what DONE means and must be testable by QA and visible to UI/design/code agents before they write code. Provide clear categorizations (UTILITY, DASHBOARD, PLATFORM_GAME, TOPDOWN_GAME, FPS_GAME, or CARD_GAME) and adhere to their constraints. Define the strict interface classes and methods so UI and Logic components can be developed in parallel without overlapping. Preserve explicit requirements as acceptance tests; never rewrite AI/search/images/no-placeholders into keyword search, dummy data, fallback icons, or proof-of-concept behavior.`;
            
            await this._runReActLoop(llm, plannerSystem, plannerPrompt, libraryDirPath, progressCallback, abortSignal, 'Planner_Agent');

            specContent = this._readFile(GLib.build_filenamev([libraryDirPath, `${appBaseName}_spec.txt`]));
            expansionText = specContent ? `\n\nDETAILED SPECIFICATION TO FOLLOW:\n${specContent}` : `\n\nUSER PROMPT:\n${structuredPrompt}`;

            const isGame = /PLATFORM_GAME|TOPDOWN_GAME|FPS_GAME|CARD_GAME/.test(specContent);
            const deterministicGameAuditContract = `\n\nDETERMINISTIC GAME AUDIT CONTRACT:
- Implement a dedicated \`restart_game(self, *args)\` method in AppWidget that calls the logic reset method, returns the game to PLAYING/PLAY, hides the game-over overlay, resets visible HUD state where needed, and calls \`self.grab_focus()\`.
- Wire the visible Game Over button directly as \`ForgeButton(label="Restart"\` or \`"Try Again"\`, \`on_click=self.restart_game\`). A restart-labeled button wired only to an unrelated callback is likely to fail audit.
- Add an executable GTK visual style scaffold in AppWidget: instantiate \`Gtk.CssProvider\`, load CSS rules for the game shell/HUD/menu/game-over overlay, register the provider only when \`Gdk.Display.get_default()\` returns a display, and call \`add_css_class\` or \`set_name\` on those regions using audit-visible names such as \`game-shell\`, \`game-overlay\`, \`game-hud\`, \`game-menu\`, and \`game-over-screen\`. Cairo-only sky/cloud/HUD rectangles do not satisfy the visual-style audit.
- Use a real texture/sprite/image-surface code path for board/entities/background. You MUST use the generate_texture tool to generate real .png asset files, and load them via ForgeTextureManager.get_cairo_surface. Do NOT hardcode procedural shapes in Python.
- Colored rectangles, arcs, grid lines, and comments saying "sprite" are not enough; generate a PNG asset during the tool execution phase.`;

            let uiAgentSystem, logicAgentSystem, uiPrompt, logicPrompt;

            if (isGame) {
                uiAgentSystem = getSystemPrompt('game_ux_agent');
                logicAgentSystem = getSystemPrompt('gameplay_agent');
                uiPrompt = `Design the complete 2D/3D game rendering interface based on this specification: ${expansionText}${deterministicGameAuditContract}\nOutput your draft to ${appBaseName}_ui.py. First read the SUCCESS CRITERIA section and treat it as the checklist for done. Import required classes from forge_game_core, forge_game_entities, forge_game_math, forge_game_level, forge_game_textures. Use ForgeDrawingArea for rendering. You MUST capture mouse input via ForgeMouse and keyboard input via ForgeInput. Ensure self.drawing_area.set_size_request(800, 600) is called. You MUST include a Main Menu and Game Over screen overlay (Gtk.Overlay) to start/stop the game, including a visible Restart/Try Again button wired to the reset/restart method. You MUST build a themed visual shell with a real Gtk.CssProvider plus CSS classes or names on the game shell, overlay, HUD/score areas, menu, and game-over overlay; the generated source must visibly include Gtk.CssProvider and add_css_class/set_name calls for names like game-shell, game-hud, game-menu, and game-over-screen. You MUST use textured rendering for the board/entities/background via ForgeTextureManager and images generated by the generate_texture tool. Sound is optional/deferred for now and must not block completion. Follow the API contract provided in the specification.`;
                logicPrompt = `Design the complete 2D/3D gameplay mechanics, physics, and ForgeGameLoop logic based on this specification: ${expansionText}\nOutput your draft to ${appBaseName}_logic.py. First read the SUCCESS CRITERIA section and treat it as the checklist for done. Import required classes from forge_game_core, forge_game_entities, forge_game_math, forge_game_level, forge_game_textures. Include enemies, doors, and decorations as entities. Read mouse/keyboard inputs passed from the UI. You MUST use ForgeLevelGenerator for extensive multi-room generation. You MUST implement a state machine (MENU, PLAY, GAMEOVER) plus reset_game/restart_game semantics that restore score, entities, timers, and direction/input state. You SHOULD expose event flags or callbacks for scoring/collection, start/restart, collision, and game over for UI effects, but sound is optional/deferred for now. Follow the API contract provided in the specification.`;
            } else {
                uiAgentSystem = getSystemPrompt('ui_agent');
                logicAgentSystem = getSystemPrompt('logic_agent');
                uiPrompt = `Design the complete, fully-wired GTK4 UI interface based on this specification: ${expansionText}\nOutput your draft to ${appBaseName}_ui.py. Read the specification to determine if this is a UTILITY or DASHBOARD and layout components appropriately. Follow the API contract provided in the specification.`;
                logicPrompt = `Design the complete backend data structures, dynamic fetchers, and calculation logic based on this specification: ${expansionText}\nOutput your draft to ${appBaseName}_logic.py. Implement real AI calls with ask_ai or ask_ai_structured whenever the specification asks for AI, semantic search, generated articles, dynamic discovery, or dashboard intelligence. Implement image retrieval with fetch_web_image whenever the specification asks for remote or article images. Do not label keyword matching, hardcoded entries, dummy data, or fallback icons as fulfilling AI/image requirements. Follow the API contract provided in the specification.`;
            }

            progressCallback(0.2, "Executing Logic generation sequentially...");
            
            await this._runReActLoop(llm, logicAgentSystem, logicPrompt, libraryDirPath, (p, msg) => progressCallback(0.2 + (p * 0.2), "[Logic] " + msg), abortSignal, isGame ? 'Gameplay_Agent' : 'Logic_Agent');

            if (abortSignal && abortSignal.cancelled) throw new Error("Cancelled by user");
            
            progressCallback(0.4, "Executing UI generation sequentially...");
            let sequentialUiPrompt = uiPrompt + `\n\nCRITICAL: The logic engineer has just finished writing ${appBaseName}_logic.py. Use read_file to read it FIRST, then implement the UI to seamlessly connect to its classes/methods.`;
            await this._runReActLoop(llm, uiAgentSystem, sequentialUiPrompt, libraryDirPath, (p, msg) => progressCallback(0.4 + (p * 0.2), "[UI] " + msg), abortSignal, isGame ? 'Game_UX_Agent' : 'UI_Agent');

            if (abortSignal && abortSignal.cancelled) throw new Error("Cancelled by user");
            progressCallback(0.6, "Merge Agent integrating outputs...");

            let mergeSystem = getSystemPrompt('merge_agent');
            let mergePrompt = `Start the merging process for ${targetFilename} based on the original specification: '${expansionText}'. ${isGame ? deterministicGameAuditContract : ''}\nYou MUST ensure that the final code is a FULLY functional app/game (no placeholders) and fulfills the SUCCESS CRITERIA plus all stylistic, graphical, texture, restart, overlay, and input requirements. For games, explicitly verify a visible restart/play-again control wired to reset state, non-flat textured rendering, and an intentional styled HUD/background/template. Preserve or add the executable GTK style scaffold in the final merged file: Gtk.CssProvider plus add_css_class/set_name calls for game-shell, game-overlay, game-hud, game-menu, and game-over-screen regions. Sound is optional/deferred for now and must not block completion. Verify that 'class AppWidget(Gtk.Box):' is the entrypoint. Cleanly import the generated companion modules as needed; ${appBaseName}_logic.py and ${appBaseName}_ui.py are runtime artifacts and will remain on disk.`;
            
            await this._runReActLoop(llm, mergeSystem, mergePrompt, libraryDirPath, progressCallback, abortSignal, 'Merge_Agent');

            if (isGame) {
                progressCallback(0.68, "Running deterministic requirement audit before QA...");
                const rescueSystem = getSystemPrompt('rescue_agent');
                const preQaAuditFailures = await this._repairRequirementAudit(
                    llm,
                    rescueSystem,
                    structuredPrompt,
                    appBaseName,
                    targetFilename,
                    libraryDirPath,
                    specContent || expansionText,
                    progressCallback,
                    abortSignal,
                    0.69
                );

                if (preQaAuditFailures.length > 0) {
                    throw new Error("Pipeline Failed Pre-QA Requirement Audit:\n" + preQaAuditFailures.join("\n"));
                }
            }

        } else {
            progressCallback(0.15, "Coordinator Agent dispatching sequential rework thread...");
            let reworkSystem = getSystemPrompt('rework_agent');
            let reworkPrompt = `IMPROVEMENT REQUEST: ${structuredPrompt}\n\nCURRENT FILE STATE (${targetFilename}):\n\`\`\`python\n${originalCode}\n\`\`\`\n\nModify '${targetFilename}' appropriately using the apply_patch tool. DO NOT write the file from scratch if you can avoid it.`;

            await this._runReActLoop(llm, reworkSystem, reworkPrompt, libraryDirPath, progressCallback, abortSignal, 'Rework_Agent');
            expansionText = `\n\nIMPROVEMENT REQUEST:\n${structuredPrompt}`;
        }

        if (abortSignal && abortSignal.cancelled) throw new Error("Cancelled by user");
        
        progressCallback(0.75, "QA Agent writing & executing automated UI integration tests...");
        let qaSystem = getSystemPrompt('qa_agent');
        let qaPrompt = `The application ${targetFilename} has been merged. Read it and write a comprehensive integration test script to ${appBaseName}_test.py using the write_file tool.

ORIGINAL SPECIFICATION TO VALIDATE AGAINST:
${expansionText}

CRITICAL MANDATES FOR THE TEST SCRIPT:
1. To prevent infinite loops or hanging threads, you MUST use os._exit(0) and os._exit(1) inside your test script rather than sys.exit() or app.quit(). GTK loops swallow sys.exit() and will cause the pipeline to hang and timeout.
2. After writing the file, you MUST use run_bash_command to execute it (python3 ${appBaseName}_test.py).
3. If the script fails, read the traceback, patch the test OR patch ${targetFilename}, and run the bash command again.
4. You MUST read the Original Specification above and write assertions in your test script to verify that BOTH stylistic (e.g., CSS classes) and functional (e.g., ForgeInput bindings, ForgeMouse presence) requirements were actually implemented.
5. For interactive apps, exercise the primary interaction path by calling the search/submit/activate handler directly or emitting/clicking the relevant button after filling a test query. Callback-only AttributeErrors are release-blocking failures.
6. If this is a GAME, the test MUST inspect source and/or widget attributes to fail when any of these are missing: visible restart/play-again control wired to reset state, Game Over/menu overlay, non-flat visual style/CSS/HUD/background, and texture/sprite/image-surface usage for entities or the board. Sound is optional/deferred for now and must not be a failing assertion.
7. You are NOT ALLOWED to call finish_task until the bash command succeeds with Exit Code 0.
8. In GTK4, Gtk.main() and Gtk.main_quit() DO NOT EXIST. Do not use them. Run your tests in a headless manner: initialize the app, connect activate to your test logic, call app.register(), and step the GLib context manually using GLib.MainContext.default().iteration(False) iteratively to prevent the test suite from hanging on app.run(None).`;
        
        await this._runReActLoop(llm, qaSystem, qaPrompt, libraryDirPath, progressCallback, abortSignal, 'QA_Agent');

        let auditFailures = this._auditGeneratedApp(structuredPrompt, appBaseName, libraryDirPath, specContent || expansionText);
        if (auditFailures.length > 0) {
            let rescueSystem = getSystemPrompt('rescue_agent');
            auditFailures = await this._repairRequirementAudit(
                llm,
                rescueSystem,
                structuredPrompt,
                appBaseName,
                targetFilename,
                libraryDirPath,
                specContent || expansionText,
                progressCallback,
                abortSignal,
                0.82
            );

            if (auditFailures.length > 0) {
                throw new Error("Pipeline Failed Requirement Audit:\n" + auditFailures.join("\n"));
            }
        }

        progressCallback(0.85, "Performing final native QA verification pass...");
        let [testOk, testOut, testErr] = await this._runSubprocess(['bash', '-c', `cd "${libraryDirPath}" && python3 ${appBaseName}_test.py`]);

        if (!testOk) {
            progressCallback(0.9, "Native QA Verification failed. Dispatching Rescue Agent...");
            let rescueSystem = getSystemPrompt('rescue_agent');
            let rescuePrompt = `CRITICAL FAILURE during automated QA testing of ${targetFilename}.\n\nTest Output/Traceback:\n${testErr || testOut}\n\nAnalyze the traceback. Fix the code using apply_patch. You MUST use run_bash_command to execute python3 ${appBaseName}_test.py to verify your fix. DO NOT call finish_task until your fix exits cleanly.`;
            
            await this._runReActLoop(llm, rescueSystem, rescuePrompt, libraryDirPath, progressCallback, abortSignal, 'Rescue_Agent');
            
            let [retryOk, retryOut, retryErr] = await this._runSubprocess(['bash', '-c', `cd "${libraryDirPath}" && python3 ${appBaseName}_test.py`]);
            if (!retryOk) {
                throw new Error("Pipeline Failed Final QA Rescue Test:\n" + (retryErr || retryOut));
            }
        }

        progressCallback(0.95, "Auditing instantiation & GTK compliance safety...");
        const dryRunScript = `import sys
import traceback
import gi
gi.require_version('Gtk', '4.0')
from gi.repository import Gtk

sys.path.insert(0, '${libraryDirPath}')

try:
    import ${appBaseName}
    if hasattr(${appBaseName}, 'AppWidget'):
        widget = ${appBaseName}.AppWidget()
        if not isinstance(widget, Gtk.Box):
            raise Exception('AppWidget MUST inherit from Gtk.Box')
    else:
        raise Exception('Missing class AppWidget(Gtk.Box):')
except Exception as e:
    print(traceback.format_exc(), file=sys.stderr)
    sys.exit(1)
sys.exit(0)`;

        let [importOk, importOut, importErr] = await this._runSubprocess(['python3', '-c', dryRunScript]);

        if (!importOk) {
            progressCallback(0.97, "Instantiation failed. Dispatching Rescue Agent...");
            let rescueSystem = getSystemPrompt('rescue_agent');
            let rescuePrompt = `CRITICAL FAILURE during GTK test of ${targetFilename}:\n${importErr}\nFix this immediately via apply_patch. Use run_bash_command to test the dry-run script.`;
            
            await this._runReActLoop(llm, rescueSystem, rescuePrompt, libraryDirPath, progressCallback, abortSignal, 'Rescue_Agent');
            
            let [retryOk, retryOut, retryErr] = await this._runSubprocess(['python3', '-c', dryRunScript]);
            if (!retryOk) {
                throw new Error("Pipeline Failed Final GTK Rescue Test:\n" + retryErr);
            }
        }

        let finalAuditFailures = this._auditGeneratedApp(structuredPrompt, appBaseName, libraryDirPath, specContent || expansionText);
        if (finalAuditFailures.length > 0) {
            let rescueSystem = getSystemPrompt('rescue_agent');
            finalAuditFailures = await this._repairRequirementAudit(
                llm,
                rescueSystem,
                structuredPrompt,
                appBaseName,
                targetFilename,
                libraryDirPath,
                specContent || expansionText,
                progressCallback,
                abortSignal,
                0.98
            );

            if (finalAuditFailures.length > 0) {
                throw new Error("Pipeline Failed Final Requirement Audit:\n" + finalAuditFailures.join("\n"));
            }
        }

        try {
            let specArtifact = Gio.File.new_for_path(GLib.build_filenamev([libraryDirPath, appBaseName + "_spec.txt"]));
            let testArtifact = Gio.File.new_for_path(GLib.build_filenamev([libraryDirPath, appBaseName + "_test.py"]));
            if (specArtifact.query_exists(null)) specArtifact.delete(null);
            if (testArtifact.query_exists(null)) testArtifact.delete(null);
        } catch (e) {
            console.warn("[GNOME-FORGE] Minor cleanup issue: " + e.message);
        }

        console.log("[GNOME-FORGE] Pipeline finished saving " + targetFilename);
        if (abortSignal && abortSignal.cancelled) throw new Error("Cancelled by user");
        progressCallback(1.0, "Wiring finished. Execution ready!");
        
        successCallback(appBaseName);
    }
}
// gnome-forge@cwittenberg/agent_pipeline.js
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { getProviderInstance } from './llm_provider.js';

export class AgentPipeline {
    constructor(extensionPath, settings) {
        this._extensionPath = extensionPath;
        this._settings = settings;
        this._lastGenerationTruncated = false;
    }

    _getActiveProfile() {
        const activeId = this._settings.get_string('active-profile-id');
        const profilesRaw = this._settings.get_string('llm-profiles');
        const profiles = JSON.parse(profilesRaw || '[]');
        return profiles.find(p => p.id === activeId) || profiles[0];
    }

    _extractCode(text) {
        let extracted = text;
        this._lastGenerationTruncated = false;

        if (text.includes('```python')) {
            let parts = text.split('```python');
            if (parts.length > 1) {
                let codePart = parts[1];
                if (!codePart.includes('```')) {
                    console.warn("[GNOME-FORGE-WARNING] Python code block was not closed! Token limit truncation has occurred.");
                    this._lastGenerationTruncated = true;
                    extracted = codePart.trim();
                } else {
                    extracted = codePart.split('```')[0].trim();
                }
            }
        } else if (text.includes('```')) {
            let parts = text.split('```');
            if (parts.length > 1) {
                if (parts.length === 2 && !text.endsWith('```')) {
                     this._lastGenerationTruncated = true;
                }
                extracted = parts[1].trim();
            }
        } else {
            extracted = text.trim();
        }
        
        const lastLines = extracted.slice(-100);
        if (lastLines.match(/["'][^"']*$/)) {
            console.error("[GNOME-FORGE-CRITICAL] Code extraction detected a truncated generation ending in an unclosed string. The AI hit its output token limit.");
            this._lastGenerationTruncated = true;
        }
        
        return extracted;
    }

    _deployDependencies(libraryDirPath) {
        const filesToCopy = ['app_harness.py', 'forge_ui.py'];
        
        for (const filename of filesToCopy) {
            const sourcePath = GLib.build_filenamev([this._extensionPath, filename]);
            const destPath = GLib.build_filenamev([libraryDirPath, filename]);
            
            const sourceFile = Gio.File.new_for_path(sourcePath);
            const destFile = Gio.File.new_for_path(destPath);
            
            try {
                sourceFile.copy(destFile, Gio.FileCopyFlags.OVERWRITE, null, null);
                if (filename === 'app_harness.py') {
                    let info = destFile.query_info('unix::mode', Gio.FileQueryInfoFlags.NONE, null);
                    let mode = info.get_attribute_uint32('unix::mode');
                    info.set_attribute_uint32('unix::mode', mode | 0o111);
                    destFile.set_attributes_from_info(info, Gio.FileQueryInfoFlags.NONE, null);
                }
            } catch (e) {
                console.warn(`[GNOME-FORGE] Could not deploy dependency ${filename}: ${e.message}`);
            }
        }
    }

    _runSubprocess(cmdArray) {
        return new Promise((resolve) => {
            try {
                console.log(`[GNOME-FORGE] Running subprocess: ${cmdArray.join(' ')}`);
                let proc = Gio.Subprocess.new(cmdArray, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
                proc.communicate_utf8_async(null, null, (obj, res) => {
                    try {
                        const [ok, out, err] = obj.communicate_utf8_finish(res);
                        if (out) console.log(`[GNOME-FORGE-STDOUT] ${out.trim()}`);
                        if (err) console.error(`[GNOME-FORGE-STDERR] ${err.trim()}`);
                        resolve([ok && proc.get_successful(), out, err]);
                    } catch (e) {
                        console.error(`[GNOME-FORGE-ERROR] Subprocess communicate failed: ${e.message}`);
                        resolve([false, '', e.message]);
                    }
                });
            } catch (e) {
                console.error(`[GNOME-FORGE-ERROR] Subprocess launch failed: ${e.message}`);
                resolve([false, '', e.message]);
            }
        });
    }

    async _generateApiReflection(libraryDirPath) {
        let pyScript = `
import sys
import inspect

sys.path.insert(0, '${libraryDirPath}')

try:
    import forge_ui
    import gi
    gi.require_version('Gtk', '4.0')
    from gi.repository import Gtk

    output = "DYNAMIC FORGE_UI API REFLECTION:\\n"
    
    for name, obj in inspect.getmembers(forge_ui):
        if inspect.isclass(obj) and name.startswith('Forge'):
            methods = [m[0] for m in inspect.getmembers(obj) if not m[0].startswith('_')]
            output += f"- {name}: Valid Methods -> {', '.join(methods)}\\n"
        elif inspect.isfunction(obj) and name.startswith('Forge'):
            sig = inspect.signature(obj)
            output += f"- {name}{sig}\\n"

    output += "\\nGTK4 ANTI-HALLUCINATION RULES (CRITICAL):\\n"
    output += "- Gtk.FlowBox: MUST use get_selected_children(), NEVER child_is_selected().\\n"
    output += "- Gtk.FlowBox: MUST use append(), NEVER add().\\n"
    output += "- Gtk.ListBox: MUST use get_selected_row(), NEVER get_selected().\\n"
    output += "- Gtk.Box: MUST use append(), NEVER set_child().\\n"
    output += "- Gtk.ScrolledWindow: MUST use set_child(), NEVER add() or append().\\n"
    output += "- Gtk.EventControllerKey: Connect to 'key-pressed' and return bool (True to stop propagation).\\n"
    
    print(output)
except Exception as e:
    print(f"CRITICAL FORGE_UI API DEFINITIONS (Fallback Mode):\\n- ForgeMarkdown: set_markdown(text)\\n- ForgeNetworkImage: load_url(url)\\n- ask_ai(system_prompt, user_prompt, callback)\\nError: {e}")
`;
        let [ok, out, err] = await this._runSubprocess(['python3', '-c', pyScript]);
        return ok ? out.trim() : out.trim() || err.trim();
    }

    async execute(userPrompt, notifyCallback, progressCallback, successCallback, abortSignal) {
        console.log(`[GNOME-FORGE] Starting Agent Pipeline execution`);
        const profile = this._getActiveProfile();
        if (!profile) {
            throw new Error('No LLM profiles match configuration keys. Open settings panel.');
        }
        
        const llm = getProviderInstance(profile);
        const libraryDirPath = GLib.build_filenamev([this._extensionPath, 'library']);
        GLib.mkdir_with_parents(libraryDirPath, 0o755);
        
        this._deployDependencies(libraryDirPath);
        this._lastGenerationTruncated = false;

        let originalCode = '';
        let appBaseName = '';
        let structuredPrompt = userPrompt;

        if (abortSignal && abortSignal.cancelled) throw new Error("Cancelled by user");
        progressCallback(0.05, 'Reflecting on API & Workspace...');
        
        const FORGE_API_DOCS = await this._generateApiReflection(libraryDirPath);
        console.log(`[GNOME-FORGE] Dynamic API Reflection Generated.`);

        if (userPrompt.startsWith('Rework')) {
            let parts = userPrompt.split(':');
            if (parts.length >= 2) {
                let filename = parts[0].replace('Rework', '').trim();
                structuredPrompt = parts.slice(1).join(':').trim();
                let filepath = GLib.build_filenamev([libraryDirPath, filename + '.py']);
                
                let file = Gio.File.new_for_path(filepath);
                if (file.query_exists(null)) {
                    let [ok, contents] = file.load_contents(null);
                    if (ok) {
                        originalCode = new TextDecoder().decode(contents);
                        try {
                            let bakpath = GLib.build_filenamev([libraryDirPath, filename + '.py.bak']);
                            let bakfile = Gio.File.new_for_path(bakpath);
                            file.copy(bakfile, Gio.FileCopyFlags.OVERWRITE, null, null);
                        } catch (e) {
                            console.warn(`[GNOME-FORGE] Could not create backup for ${filename}: ${e.message}`);
                        }
                    }
                }
                appBaseName = filename;
            }
        }

        // --- STAGE 1: ARCHITECTURE CRITIC ---
        if (abortSignal && abortSignal.cancelled) throw new Error("Cancelled by user");
        progressCallback(0.1, `Critic structuring application components...`);

        let criticSys = `You are a visionary Systems Architect. The user requested an application or improvement. 
CRITICAL MANDATES: 
1. STRICT CONSTRAINT PRESERVATION: Incorporate all specific constraints.
2. COMPONENT DECOUPLING: You MUST enforce a strict separation between UI layout and Data/Logic. Instruct the Engineer to NEVER embed large dictionaries, lists, or hardcoded text datasets. 
3. PREVENT TOKEN TRUNCATION: All complex data, encyclopedias, or bulk content MUST be fetched dynamically using the 'ask_ai' function. Static embedding causes catastrophic token limits and syntax errors.
4. UI/UX: Enforce dynamic layout (set_hexpand, set_vexpand). For keyboards/calculators, mandate Gtk.EventControllerKey.
Output ONLY the expanded, structured technical specification for the engineering agents.`;
        
        let criticUserPrompt = originalCode ? `IMPROVEMENT REQUEST:\n${structuredPrompt}\n\nEXISTING CODE:\n${originalCode}` : structuredPrompt;
        let expandedSpec = await llm.call(criticSys, criticUserPrompt);

        // --- STAGE 2: UI SKELETON ENGINEER ---
        if (abortSignal && abortSignal.cancelled) throw new Error("Cancelled by user");
        progressCallback(0.2, `Building UI skeleton via ${profile.name}...`);
        
        let uiSys = `You are an elite GTK4 UI Engineer. Phase 1: Build the UI skeleton.
1. Create a PascalCase app name. Define EXACTLY \`class AppWidget(Gtk.Box):\`.
2. Build the FULL GTK4 user interface based on the spec. Include all widgets, layouts, and CSS.
3. DO NOT IMPLEMENT COMPLEX LOGIC YET. Wire buttons to empty methods (e.g., \`def on_click(self, btn): pass\`).
4. NEVER embed massive text or datasets.
5. NO markdown text. Output ONLY the raw Python code.
${FORGE_API_DOCS}`;
        
        let uiDraftResponse = await llm.call(uiSys, `SPECIFICATION:\n${expandedSpec}\n\nBASE CODE:\n${originalCode}`);
        let uiDraftCode = this._extractCode(uiDraftResponse);

        // --- STAGE 3: LOGIC IMPLEMENTATION ENGINEER ---
        if (abortSignal && abortSignal.cancelled) throw new Error("Cancelled by user");
        progressCallback(0.35, `Wiring application logic...`);

        let logicSys = `You are an elite GTK4 Logic Engineer. Phase 2: Implement the logic for the provided UI skeleton.
1. Take the provided skeleton code and implement ALL empty methods, event handlers, and data logic.
2. DO NOT embed datasets. Fetch data dynamically using \`ask_ai(system_prompt, user_prompt, callback)\`.
3. Implement keyboard navigation via Gtk.EventControllerKey if applicable.
4. Return the FULL, unabridged, completed Python file. DO NOT USE placeholders like "rest of code unchanged". You must output the entire file from top to bottom.
5. Multiline strings (CSS, prompts) MUST use triple quotes (""").
${FORGE_API_DOCS}`;

        let logicResponse = await llm.call(logicSys, `SPECIFICATION:\n${expandedSpec}\n\nUI SKELETON:\n${uiDraftCode}`);
        let finalCode = this._extractCode(logicResponse);
        
        if (!appBaseName) {
            let nameMatch = finalCode.match(/class\s+([A-Za-z0-9_]+)\(Gtk\.Box\):/);
            appBaseName = nameMatch ? "AppWidget" : `${structuredPrompt.split(' ')[0].replace(/[^a-zA-Z]/g, '')}App`;
            let topNameMatch = finalCode.match(/APP_NAME:\s*([A-Za-z0-9]+)/);
            if (topNameMatch) appBaseName = topNameMatch[1];
        }

        // --- STAGE 4: QA & API AUDITOR ---
        if (abortSignal && abortSignal.cancelled) throw new Error("Cancelled by user");
        progressCallback(0.5, `Auditing against GTK4 API Reflection...`);

        let qaSys = `You are a strict GTK4 API Auditor. Evaluate the code against the reflected API.
1. Does it call hallucinatory methods like \`child_is_selected\` on a FlowBox? FAIL IT and fix it (use \`get_selected_children()\`).
2. Does it use \`.set_child()\` on a Gtk.Box? FAIL IT and use \`.append()\`.
3. Did the AI embed massive hardcoded dictionaries? FAIL IT and replace with \`ask_ai\` logic.
4. Scan for unterminated string literals or broken multiline strings.
${FORGE_API_DOCS}
If perfect and 100% compliant, output exactly "PASS". Otherwise, output the FULL unabridged corrected Python code.`;
        
        let qaResponse = await llm.call(qaSys, `CODE:\n${finalCode}`);
        let cleanedQa = this._extractCode(qaResponse);

        if (!cleanedQa.includes('PASS') && cleanedQa.length > 50) {
            finalCode = cleanedQa;
            if (abortSignal && abortSignal.cancelled) throw new Error("Cancelled by user");
            progressCallback(0.55, `Applying API Auditor corrections...`);
        }

        // --- STAGE 5: COMPILATION & INSTANTIATION CHECK (REPAIR LOOP) ---
        let maxAttempts = 3;
        let attempt = 1;
        let success = false;

        while (attempt <= maxAttempts && !success) {
            if (abortSignal && abortSignal.cancelled) throw new Error("Cancelled by user");
            progressCallback(0.6 + (attempt * 0.1), `Validating safe instantiation (Attempt ${attempt}/${maxAttempts})...`);
            
            let tempTargetFile = GLib.build_filenamev([libraryDirPath, `${appBaseName}.py`]);
            let tempFile = Gio.File.new_for_path(tempTargetFile);
            tempFile.replace_contents(finalCode, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);

            let [compileOk, compileOut, compileErr] = await this._runSubprocess(['python3', '-m', 'py_compile', tempTargetFile]);
            
            if (!compileOk) {
                console.error(`[GNOME-FORGE-ERROR] Syntax compilation failed: ${compileErr}`);
                if (abortSignal && abortSignal.cancelled) throw new Error("Cancelled by user");
                progressCallback(0.75, `Executing autonomous repair for Syntax Error...`);

                let truncationDirective = this._lastGenerationTruncated ? 
                    "\nCRITICAL: Code truncated due to token limits. You MUST delete massive hardcoded data dictionaries. DO NOT just add a quote to the end of the broken file. Rewrite the file completely to be shorter and functional." : "";

                let testSys = `CRITICAL FAILURE DETECTED. You are a Python GTK4 Debugging Agent.
Error Log:
${compileErr}
${truncationDirective}

1. Analyze the syntax error.
2. If fixing an unterminated string, do NOT output just the fixed line. You MUST output the FULL, UNABRIDGED file from imports to the final class method. No partial responses.
3. DO NOT drop existing UI functionality.`;
                let finalCodeResponse = await llm.call(testSys, finalCode);
                finalCode = this._extractCode(finalCodeResponse);
                attempt++;
                continue;
            }

            let dryRunScript = `
import sys
import traceback
import gi
gi.require_version('Gtk', '4.0')
from gi.repository import Gtk

sys.path.insert(0, '${libraryDirPath}')

try:
    import ${appBaseName}
    print("[GNOME-FORGE-DRYRUN] Module loaded successfully.")
    
    if hasattr(${appBaseName}, 'AppWidget'):
        widget = ${appBaseName}.AppWidget()
        if not isinstance(widget, Gtk.Box):
            raise Exception("Developer Error: AppWidget MUST inherit from Gtk.Box, but found " + type(widget).__name__)
        print("[GNOME-FORGE-DRYRUN] AppWidget instantiated successfully.")
    else:
        raise Exception("Developer Error: Generated code is explicitly missing 'class AppWidget(Gtk.Box):'")
        
except Exception as e:
    print(traceback.format_exc(), file=sys.stderr)
    sys.exit(1)
sys.exit(0)
            `;

            let [importOk, importOut, importErr] = await this._runSubprocess(['python3', '-c', dryRunScript]);

            if (!importOk) {
                console.error(`[GNOME-FORGE-ERROR] GTK instantiation dry-run failed: ${importErr}`);
                if (abortSignal && abortSignal.cancelled) throw new Error("Cancelled by user");
                progressCallback(0.75, `Executing autonomous repair for Instantiation Error...`);
                
                let testSys = `CRITICAL FAILURE DETECTED. You are a Python GTK4 Debugging Agent.
Error Log:
${importErr}

${FORGE_API_DOCS}

1. Analyze the trace. Check the API REFLECTION above to ensure you are not hallucinating a method.
2. Output the FULLY CORRECTED, UNABRIDGED Python code wrapped in exactly one \`\`\`python ... \`\`\` block. DO NOT USE PLACEHOLDERS like 'rest of code unchanged'.
3. DO NOT drop functionality.`;
                let finalCodeResponse = await llm.call(testSys, finalCode);
                finalCode = this._extractCode(finalCodeResponse);
                attempt++;
                continue;
            }

            success = true;
            console.log(`[GNOME-FORGE] QA and Validation successful!`);
            if (abortSignal && abortSignal.cancelled) throw new Error("Cancelled by user");
            progressCallback(0.9, `Validation complete. Pipeline Passed!`);
        }

        if (!success) {
            throw new Error(`CRITICAL FAILURE: Application failed validation after ${maxAttempts} repair iterations.`);
        }

        if (abortSignal && abortSignal.cancelled) throw new Error("Cancelled by user");
        progressCallback(0.95, 'Compiling and saving final component...');

        let header = `"""\nGNOME FORGE COMPONENT\nOriginal Prompt: ${structuredPrompt}\n"""\n\n`;
        let ultimateCode = header + finalCode;

        let targetFile = GLib.build_filenamev([libraryDirPath, `${appBaseName}.py`]);
        let file = Gio.File.new_for_path(targetFile);
        
        file.replace_contents(ultimateCode, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        
        console.log(`[GNOME-FORGE] Pipeline finished saving ${appBaseName}.py`);
        if (abortSignal && abortSignal.cancelled) throw new Error("Cancelled by user");
        progressCallback(1.0, 'Wiring finished. Execution ready!');
        
        successCallback(appBaseName);
    }
}
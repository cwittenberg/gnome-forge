// forge_tools.js
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { TextureGenerator } from './texture_generator.js';

export class ForgeTools {
    constructor(workspacePath, llmProvider = null) {
        this.workspacePath = workspacePath;
        this.llm = llmProvider;
        
        this.tools = {
            "write_file": async (args) => {
                let path = GLib.build_filenamev([this.workspacePath, args.file]);
                let file = Gio.File.new_for_path(path);
                
                let content = args.content.replace(/\\"/g, '"').replace(/\\'/g, "'");
                
                file.replace_contents(content, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
                return `SUCCESS: File ${args.file} overwritten completely.`;
            },
            "read_file": async (args) => {
                let path = GLib.build_filenamev([this.workspacePath, args.file]);
                let file = Gio.File.new_for_path(path);
                if (!file.query_exists(null)) return `File ${args.file} is empty or does not exist.`;
                let [ok, contents] = file.load_contents(null);
                return ok ? new TextDecoder('utf-8').decode(contents) : `File ${args.file} is empty or does not exist.`;
            },
            "list_files": async (args) => {
                let path = GLib.build_filenamev([this.workspacePath, args.directory || "."]);
                let dir = Gio.File.new_for_path(path);
                if (!dir.query_exists(null)) return `Directory does not exist.`;
                let enumerator = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
                let files = [];
                let info;
                while ((info = enumerator.next_file(null)) !== null) {
                    files.push(info.get_name());
                }
                return `FILES IN DIRECTORY:\n${files.join('\n')}`;
            },
            "generate_texture": async (args) => {
                if (!this.llm) return "FAILURE: No LLM provider attached to tools.";
                let prompt = `You are an expert texture JSON recipe generator. The user wants: "${args.description}".
Respond ONLY with a raw JSON object (no markdown, no backticks).
The JSON must follow one of these schemas:
1. Pixel Art (Good for 2D sprites, retro FPS, pixel icons):
{
  "type": "pixel_art",
  "width": 64,
  "height": 64,
  "background": "#00000000",
  "palette": { "X": "#FF0000FF", "O": "#000000FF", " ": null },
  "pixels": [
    "  XX  ",
    " XOOX ",
    " XOOX ",
    "  XX  "
  ]
}
2. Gradient (Good for skies, backgrounds):
{
  "type": "gradient",
  "width": 128,
  "height": 128,
  "direction": "vertical",
  "stops": [{"offset": 0, "color": "#87CEEBFF"}, {"offset": 1, "color": "#1E90FFFF"}],
  "noise": 0.05
}
3. Shapes (Good for basic objects, metals, bricks):
{
  "type": "shapes",
  "width": 64,
  "height": 64,
  "background": "#808080FF",
  "noise": 0.1,
  "shapes": [
    {"type": "rect", "x": 0, "y": 0, "w": 32, "h": 32, "color": "#909090FF"},
    {"type": "circle", "cx": 16, "cy": 16, "r": 8, "color": "#404040FF"}
  ]
}`;
                let recipeJson = await this.llm.call(prompt, "Generate JSON recipe for: " + args.description);
                recipeJson = recipeJson.replace(/```json/g, '').replace(/```/g, '').trim();
                
                let path = GLib.build_filenamev([this.workspacePath, args.file]);
                return TextureGenerator.render(recipeJson, path);
            },
            "apply_patch": async (args) => {
                let path = GLib.build_filenamev([this.workspacePath, args.file]);
                let file = Gio.File.new_for_path(path);
                if (!file.query_exists(null)) return `FAILURE: File ${args.file} does not exist.`;
                let [ok, contents] = file.load_contents(null);
                if (!ok) return `FAILURE: Could not read ${args.file}.`;
                let content = new TextDecoder('utf-8').decode(contents);
                
                let oldText = args.old_text.replace(/\\"/g, '"').replace(/\\'/g, "'");
                let newText = args.new_text.replace(/\\"/g, '"').replace(/\\'/g, "'");

                if (content.includes(oldText)) {
                    let newContent = content.replace(oldText, newText);
                    file.replace_contents(newContent, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
                    return `SUCCESS: Exact string match replaced in ${args.file}.`;
                }

                let oldLines = oldText.trim().split('\n').map(l => l.trim());
                let contentLines = content.split('\n');
                
                let matchIndex = -1;
                for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
                    let match = true;
                    for (let j = 0; j < oldLines.length; j++) {
                        if (contentLines[i + j].trim() !== oldLines[j]) {
                            match = false;
                            break;
                        }
                    }
                    if (match) {
                        matchIndex = i;
                        break;
                    }
                }

                if (matchIndex !== -1) {
                    let leadingSpaceMatch = contentLines[matchIndex].match(/^\s*/);
                    let leadingSpace = leadingSpaceMatch ? leadingSpaceMatch[0] : "";
                    let newTextLines = newText.replace(/^\n+|\n+$/g, '').split('\n');
                    
                    let newTextFirstLineSpaceMatch = newTextLines[0].match(/^\s*/);
                    let newTextFirstLineSpace = newTextFirstLineSpaceMatch ? newTextFirstLineSpaceMatch[0] : "";
                    
                    let mappedNewLines = newTextLines.map(line => {
                        if (line.startsWith(newTextFirstLineSpace)) {
                            return leadingSpace + line.substring(newTextFirstLineSpace.length);
                        }
                        return line;
                    });

                    contentLines.splice(matchIndex, oldLines.length, ...mappedNewLines);
                    let newContent = contentLines.join('\n');
                    file.replace_contents(newContent, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
                    return `SUCCESS: Line-by-line semantic diff applied to ${args.file}.`;
                }

                let escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                let fuzzyPattern = oldText.trim().split(/\s+/).map(escapeRegExp).join('\\s+');
                let regex = new RegExp(fuzzyPattern);

                if (regex.test(content)) {
                    let newContent = content.replace(regex, newText.trim());
                    file.replace_contents(newContent, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
                    return `SUCCESS: Fuzzy word-boundary diff applied to ${args.file}. Verify formatting!`;
                }

                let snippetStart = Math.max(0, content.length / 2 - 500);
                let snippet = content.substring(snippetStart, snippetStart + 1000);
                return `FAILURE: The exact string in 'old_text' was not found in ${args.file}. The system utilizes normalized whitespace matching, but the target text still missed. Ensure you capture the exact syntax of the target block (avoid over-escaping quotes or mismatched line breaks).\n\nContextual Snippet from file:\n...\n${snippet}\n...\n\nPlease use read_file to check the exact state or use write_file to replace the entire document cleanly.`;
            },
            "run_bash_command": async (args) => {
                let cmdArray = ['bash', '-c', `cd "${this.workspacePath}" && exec ${args.command}`];
                let proc = Gio.Subprocess.new(cmdArray, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
                
                return new Promise((resolve) => {
                    let isResolved = false;
                    
                    let timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 15, () => {
                        if (!isResolved) {
                            isResolved = true;
                            try {
                                proc.force_exit();
                            } catch (e) {}
                            resolve(`FAILURE: Command timed out after 15 seconds. If this is a test script (_test.py), ensure it properly sequences interactions and explicitly calls GLib.MainLoop().quit() so it doesn't hang. DO NOT fallback to py_compile for test scripts; you must fix the test or the app logic so it exits cleanly!`);
                        }
                        return GLib.SOURCE_REMOVE;
                    });

                    proc.communicate_utf8_async(null, null, (obj, res) => {
                        if (isResolved) return;
                        isResolved = true;
                        GLib.source_remove(timeoutId);
                        
                        try {
                            const [ok, out, err] = obj.communicate_utf8_finish(res);
                            let stdoutStr = out || "(empty)";
                            let stderrStr = err || "(empty)";
                            let exitCode = (ok && proc.get_successful()) ? 0 : 1;
                            resolve(`Exit Code: ${exitCode}\nSTDOUT:\n${stdoutStr}\nSTDERR:\n${stderrStr}\n${exitCode === 0 ? "SUCCESS: Command ran without errors." : "FAILURE: Command encountered errors."}`);
                        } catch (e) {
                            resolve(`FAILURE: Command encountered errors: ${e.message}`);
                        }
                    });
                });
            },
            "finish_task": async (args) => {
                return args.final_output || "Task finished successfully.";
            }
        };
    }

    getToolSchemas() {
        return [
            {
                type: "function",
                function: {
                    name: "write_file",
                    description: "Writes full content to a file. Used for creating new files.",
                    parameters: {
                        type: "object",
                        properties: {
                            file: { type: "string", description: "The filename to write to." },
                            content: { type: "string", description: "The full complete source code or text content." }
                        },
                        required: ["file", "content"]
                    }
                }
            },
            {
                type: "function",
                function: {
                    name: "read_file",
                    description: "Reads the content of a file.",
                    parameters: {
                        type: "object",
                        properties: {
                            file: { type: "string", description: "The filename to read." }
                        },
                        required: ["file"]
                    }
                }
            },
            {
                type: "function",
                function: {
                    name: "list_files",
                    description: "Lists all files in a target directory to gain contextual awareness of the workspace.",
                    parameters: {
                        type: "object",
                        properties: {
                            directory: { type: "string", description: "The directory to list. Defaults to the current workspace root." }
                        },
                        required: []
                    }
                }
            },
            {
                type: "function",
                function: {
                    name: "generate_texture",
                    description: "Generates a PNG texture image based on a semantic description using an LLM JSON recipe and a local JS rendering engine. Use this to create any required game assets instead of hardcoding python arrays.",
                    parameters: {
                        type: "object",
                        properties: {
                            file: { type: "string", description: "The local filename to write the PNG to (e.g. assets/player.png)." },
                            description: { type: "string", "description": "A detailed visual description of the texture (e.g. 'retro 90s FPS wolfenstein guard pixel art sprite')." }
                        },
                        required: ["file", "description"]
                    }
                }
            },
            {
                type: "function",
                function: {
                    name: "apply_patch",
                    description: "Applies a string replacement patch to a file. Mandatory for small edits.",
                    parameters: {
                        type: "object",
                        properties: {
                            file: { type: "string", description: "The filename to edit." },
                            old_text: { type: "string", description: "The exact block of text to replace. Must match perfectly." },
                            new_text: { type: "string", description: "The new text that will replace the old text." }
                        },
                        required: ["file", "old_text", "new_text"]
                    }
                }
            },
            {
                type: "function",
                function: {
                    name: "run_bash_command",
                    description: "Runs a bash command in the workspace. DO NOT USE SED OR AWK TO EDIT FILES. ALWAYS USE apply_patch.",
                    parameters: {
                        type: "object",
                        properties: {
                            command: { type: "string", description: "The bash command string to execute." }
                        },
                        required: ["command"]
                    }
                }
            },
            {
                type: "function",
                function: {
                    name: "finish_task",
                    description: "Concludes the loop once your objective is completely met.",
                    parameters: {
                        type: "object",
                        properties: {
                            final_output: { type: "string", description: "A summary of what was achieved." }
                        },
                        required: ["final_output"]
                    }
                }
            }
        ];
    }

    async executeTool(toolName, args) {
        if (!this.tools[toolName]) {
            return `FAILURE: Unknown tool '${toolName}'.`;
        }
        try {
            return await this.tools[toolName](args);
        } catch (e) {
            return `RUNTIME ERROR executing tool '${toolName}': ${e.message}`;
        }
    }
}
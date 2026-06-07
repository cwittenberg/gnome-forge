// gnome-forge@cwittenberg/prefs.js
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';
import GLib from 'gi://GLib';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const OPEN_FORGE_SHORTCUT = 'open-forge-shortcut';
const DEFAULT_OPEN_FORGE_SHORTCUT = '<Super>y';

export default class ForgePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        this._settings = this.getSettings('org.gnome.shell.extensions.gnome-forge');
        this._isUpdatingUI = false;
        
        this._page = new Adw.PreferencesPage();
        
        // Initialize the Debug Buffer
        this._debugBuffer = new Gtk.TextBuffer();
        this._log('Preferences Window Initialized');

        // Explicitly set groups to null before initial render
        this._shortcutGroup = null;
        this._activeGroup = null;
        this._listGroup = null;
        this._addGroup = null;
        this._debugGroup = null;

        this._renderUI();
        window.add(this._page);
    }

    _log(msg) {
        const time = new Date().toISOString().split('T')[1].split('.')[0];
        const logLine = `[${time}] ${msg}\n`;
        console.warn(`[GNOME-FORGE-DEBUG] ${logLine.trim()}`);
        if (this._debugBuffer) {
            const iter = this._debugBuffer.get_end_iter();
            this._debugBuffer.insert(iter, logLine, -1);
        }
    }

    _showErrorDialog(title, message) {
        const rootWin = this._page.get_root();
        if (Adw.AlertDialog) {
            const dialog = new Adw.AlertDialog({
                heading: title,
                body: message
            });
            dialog.add_response('ok', 'OK');
            dialog.present(rootWin);
        } else if (Adw.MessageDialog) {
            const dialog = new Adw.MessageDialog({
                heading: title,
                body: message
            });
            dialog.add_response('ok', 'OK');
            dialog.present(rootWin);
        }
    }

    _getProfiles() {
        const raw = this._settings.get_string('llm-profiles');
        return JSON.parse(raw || '[]');
    }

    _saveProfiles(profiles, sourceAction) {
        this._log(`Saving profiles from [${sourceAction}]. Total profiles: ${profiles.length}`);
        this._settings.set_string('llm-profiles', JSON.stringify(profiles));
    }

    _getOpenShortcut() {
        const shortcuts = this._settings.get_strv(OPEN_FORGE_SHORTCUT);
        return shortcuts.length > 0 ? shortcuts[0] : '';
    }

    _shortcutLabelText() {
        const shortcut = this._getOpenShortcut();
        if (!shortcut) return 'Disabled';

        try {
            const [ok, keyval, modifiers] = Gtk.accelerator_parse(shortcut);
            if (ok) {
                return Gtk.accelerator_get_label(keyval, modifiers) || shortcut;
            }
        } catch (e) {
        }
        return shortcut;
    }

    _isModifierKey(keyval) {
        return [
            Gdk.KEY_Control_L,
            Gdk.KEY_Control_R,
            Gdk.KEY_Shift_L,
            Gdk.KEY_Shift_R,
            Gdk.KEY_Alt_L,
            Gdk.KEY_Alt_R,
            Gdk.KEY_Meta_L,
            Gdk.KEY_Meta_R,
            Gdk.KEY_Super_L,
            Gdk.KEY_Super_R,
            Gdk.KEY_Hyper_L,
            Gdk.KEY_Hyper_R,
        ].includes(keyval);
    }

    _addShortcutRow() {
        const row = new Adw.ActionRow({
            title: 'Open Forge Prompt',
            subtitle: 'Opens the tray and focuses the vibe field.'
        });

        let capturing = false;
        const shortcutLabel = new Gtk.Label({
            label: this._shortcutLabelText(),
            min_width_chars: 14
        });
        const shortcutButton = new Gtk.Button({
            child: shortcutLabel,
            valign: Gtk.Align.CENTER
        });

        const refreshLabel = () => {
            shortcutLabel.set_label(capturing ? 'Press keys...' : this._shortcutLabelText());
        };

        shortcutButton.connect('clicked', () => {
            capturing = true;
            refreshLabel();
            shortcutButton.grab_focus();
        });

        const keyController = new Gtk.EventControllerKey();
        keyController.connect('key-pressed', (_controller, keyval, _keycode, state) => {
            if (!capturing) return false;

            if (keyval === Gdk.KEY_Escape) {
                capturing = false;
                refreshLabel();
                return true;
            }

            if (keyval === Gdk.KEY_BackSpace || keyval === Gdk.KEY_Delete) {
                this._settings.set_strv(OPEN_FORGE_SHORTCUT, []);
                capturing = false;
                refreshLabel();
                this._log('Open shortcut disabled');
                return true;
            }

            if (this._isModifierKey(keyval)) {
                return true;
            }

            const modifiers = state & Gtk.accelerator_get_default_mod_mask();
            const isFunctionKey = keyval >= Gdk.KEY_F1 && keyval <= Gdk.KEY_F35;
            if (modifiers === 0 && !isFunctionKey) {
                shortcutLabel.set_label('Add a modifier');
                return true;
            }

            if (!Gtk.accelerator_valid(keyval, modifiers)) {
                shortcutLabel.set_label('Invalid shortcut');
                return true;
            }

            const accelerator = Gtk.accelerator_name(keyval, modifiers);
            this._settings.set_strv(OPEN_FORGE_SHORTCUT, [accelerator]);
            capturing = false;
            refreshLabel();
            this._log(`Open shortcut changed to ${accelerator}`);
            return true;
        });
        shortcutButton.add_controller(keyController);

        const resetButton = new Gtk.Button({
            icon_name: 'edit-undo-symbolic',
            tooltip_text: `Reset to ${DEFAULT_OPEN_FORGE_SHORTCUT}`,
            valign: Gtk.Align.CENTER
        });
        resetButton.connect('clicked', () => {
            this._settings.set_strv(OPEN_FORGE_SHORTCUT, [DEFAULT_OPEN_FORGE_SHORTCUT]);
            capturing = false;
            refreshLabel();
            this._log(`Open shortcut reset to ${DEFAULT_OPEN_FORGE_SHORTCUT}`);
        });

        row.add_suffix(shortcutButton);
        row.add_suffix(resetButton);
        this._shortcutGroup.add(row);
    }

    _renderUI() {
        this._isUpdatingUI = true;
        this._log('Rebuilding UI interface...');

        // Cleanly remove existing groups from the page (this avoids corrupting Adw.PreferencesGroup internal list boxes)
        if (this._shortcutGroup) this._page.remove(this._shortcutGroup);
        if (this._activeGroup) this._page.remove(this._activeGroup);
        if (this._listGroup) this._page.remove(this._listGroup);
        if (this._addGroup) this._page.remove(this._addGroup);
        if (this._debugGroup) this._page.remove(this._debugGroup);

        // Re-instantiate fresh groups
        this._shortcutGroup = new Adw.PreferencesGroup({ title: 'Panel Shortcut' });
        this._activeGroup = new Adw.PreferencesGroup({ title: 'Active Engine Routing' });
        this._listGroup = new Adw.PreferencesGroup({ title: 'Configured LLM Profiles' });
        this._addGroup = new Adw.PreferencesGroup();
        this._debugGroup = new Adw.PreferencesGroup({ title: 'Live System Debug Log' });

        this._page.add(this._shortcutGroup);
        this._page.add(this._activeGroup);
        this._page.add(this._listGroup);
        this._page.add(this._addGroup);
        this._page.add(this._debugGroup);

        const profiles = this._getProfiles();
        const activeId = this._settings.get_string('active-profile-id');

        this._log(`Loaded ${profiles.length} profiles from disk. Active ID: ${activeId}`);

        this._addShortcutRow();

        // --- ACTIVE PROFILE DROPDOWN ---
        if (profiles.length > 0) {
            const activeRow = new Adw.ComboRow({
                title: 'Current Active Model',
                model: Gtk.StringList.new(profiles.map(p => p.name))
            });
            
            let targetIdx = profiles.findIndex(p => p.id === activeId);
            if (targetIdx === -1) targetIdx = 0;
            activeRow.selected = targetIdx;
            
            activeRow.connect('notify::selected', () => {
                if (this._isUpdatingUI) return;
                const newActiveId = profiles[activeRow.selected].id;
                this._log(`Active profile changed via dropdown to: ${newActiveId}`);
                this._settings.set_string('active-profile-id', newActiveId);
                
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    this._renderUI(); 
                    return GLib.SOURCE_REMOVE;
                });
            });
            this._activeGroup.add(activeRow);
        } else {
            const emptyLabel = new Gtk.Label({ label: 'No profiles configured. Add one below.', margin_top: 10, margin_bottom: 10 });
            this._activeGroup.add(emptyLabel);
        }

        // --- PROFILE LIST VIEW ---
        profiles.forEach((profile) => {
            const pid = profile.id;
            const exp = new Adw.ExpanderRow({ 
                title: profile.name, 
                subtitle: profile.provider.toUpperCase()
            });
            
            if (pid === activeId) {
                exp.set_subtitle(`⚡ ACTIVE • ${profile.provider.toUpperCase()}`);
            }

            if (profile.provider === 'gemini') {
                let linkRow = new Adw.ActionRow({ title: 'Get a free API Key', subtitle: 'Google AI Studio' });
                let linkBtn = new Gtk.LinkButton({ uri: '[https://aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)', label: 'Open Portal', valign: Gtk.Align.CENTER });
                linkRow.add_suffix(linkBtn);
                exp.add_row(linkRow);
            }

            const nameEntry = new Gtk.Entry({ text: profile.name, valign: Gtk.Align.CENTER });
            nameEntry.connect('changed', () => {
                if (this._isUpdatingUI) return;
                let current = this._getProfiles();
                let p = current.find(x => x.id === pid);
                if (p) {
                    p.name = nameEntry.get_text();
                    this._saveProfiles(current, `NAME_CHANGE_${pid}`);
                }
            });
            let row1 = new Adw.ActionRow({ title: 'Profile Name' });
            row1.add_suffix(nameEntry);
            exp.add_row(row1);

            if (profile.provider === 'ollama') {
                const urlEntry = new Gtk.Entry({ text: profile.url || '', valign: Gtk.Align.CENTER });
                urlEntry.connect('changed', () => {
                    if (this._isUpdatingUI) return;
                    let current = this._getProfiles();
                    let p = current.find(x => x.id === pid);
                    if (p) {
                        p.url = urlEntry.get_text();
                        this._saveProfiles(current, `URL_CHANGE_${pid}`);
                    }
                });
                let row2 = new Adw.ActionRow({ title: 'Endpoint URL' });
                row2.add_suffix(urlEntry);
                exp.add_row(row2);
            }

            if (profile.provider !== 'ollama') {
                const keyEntry = new Gtk.Entry({ text: profile.apiKey || '', visibility: false, valign: Gtk.Align.CENTER });
                keyEntry.connect('changed', () => {
                    if (this._isUpdatingUI) return;
                    let current = this._getProfiles();
                    let p = current.find(x => x.id === pid);
                    if (p) {
                        p.apiKey = keyEntry.get_text();
                        this._saveProfiles(current, `KEY_CHANGE_${pid}`);
                    }
                });
                let rowKey = new Adw.ActionRow({ title: 'Secret Token / API Key' });
                rowKey.add_suffix(keyEntry);
                exp.add_row(rowKey);
            }

            let modelRow = new Adw.ActionRow({ title: 'Model Target' });
            const modelCombo = new Gtk.ComboBoxText({ has_entry: true, valign: Gtk.Align.CENTER });
            const modelEntry = modelCombo.get_child();
            modelEntry.set_text(profile.model || '');
            
            modelEntry.connect('changed', () => {
                if (this._isUpdatingUI) return;
                let current = this._getProfiles();
                let p = current.find(x => x.id === pid);
                if (p) {
                    p.model = modelEntry.get_text();
                    this._saveProfiles(current, `MODEL_CHANGE_${pid}`);
                }
            });
            
            const fetchBtn = new Gtk.Button({ label: '🔄 Fetch', valign: Gtk.Align.CENTER });
            fetchBtn.connect('clicked', async () => {
                this._log(`FETCH clicked for ${pid}`);
                fetchBtn.set_label('⏳...');
                try {
                    const latestProfile = this._getProfiles().find(x => x.id === pid);
                    const models = await this._fetchModels(latestProfile);
                    modelCombo.remove_all();
                    models.forEach(m => modelCombo.append_text(m));
                    fetchBtn.set_label('✅ Updated');
                    this._log(`Fetch SUCCESS for ${pid}: Retrieved ${models.length} models`);
                } catch (e) {
                    this._log(`Fetch Error: ${e.message}`);
                    fetchBtn.set_label('❌ Error');
                    this._showErrorDialog('Model Fetch Failed', e.message);
                }
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
                    fetchBtn.set_label('🔄 Fetch');
                    return GLib.SOURCE_REMOVE;
                });
            });

            let modelBox = new Gtk.Box({ spacing: 6 });
            modelBox.append(modelCombo);
            modelBox.append(fetchBtn);
            modelRow.add_suffix(modelBox);
            exp.add_row(modelRow);

            let actionRow = new Adw.ActionRow();
            
            const testBtn = new Gtk.Button({ label: '✅ Test Connection', valign: Gtk.Align.CENTER });
            testBtn.add_css_class('suggested-action');
            testBtn.connect('clicked', async () => {
                this._log(`TEST CONNECTION clicked for ${pid}`);
                testBtn.set_label('⏳ Testing...');
                try {
                    const latestProfile = this._getProfiles().find(x => x.id === pid);
                    await this._testConnection(latestProfile);
                    this._log(`Test SUCCESS for ${pid}`);
                    testBtn.set_label('✅ Success!');
                } catch (e) {
                    this._log(`Test FAILED for ${pid}: ${e.message}`);
                    testBtn.set_label(`❌ Failed`);
                    this._showErrorDialog('Connection Test Failed', e.message);
                }
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 4000, () => {
                    testBtn.set_label('✅ Test Connection');
                    return GLib.SOURCE_REMOVE;
                });
            });

            const deleteBtn = new Gtk.Button({ label: '🗑️ Delete', valign: Gtk.Align.CENTER });
            deleteBtn.add_css_class('destructive-action');
            deleteBtn.connect('clicked', () => {
                this._log(`DELETE BUTTON CLICKED directly for pid: ${pid}`);
                if (this._isUpdatingUI) {
                    this._log(`Delete ignored - UI is currently locked.`);
                    return;
                }
                
                const current = this._getProfiles();
                const updated = current.filter(p => p.id !== pid);
                this._log(`Filtering arrays. Old len: ${current.length}, New len: ${updated.length}`);
                
                this._saveProfiles(updated, `DELETE_ACTION_${pid}`);
                
                const curActive = this._settings.get_string('active-profile-id');
                if (curActive === pid && updated.length > 0) {
                    this._log(`Active profile deleted. Setting active to ${updated[0].id}`);
                    this._settings.set_string('active-profile-id', updated[0].id);
                } else if (updated.length === 0) {
                    this._log(`All profiles gone. Nullifying active ID.`);
                    this._settings.set_string('active-profile-id', '');
                }
                
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    this._renderUI();
                    return GLib.SOURCE_REMOVE;
                });
            });

            let btnBox = new Gtk.Box({ spacing: 6 });
            btnBox.append(testBtn);
            btnBox.append(deleteBtn);
            actionRow.add_suffix(btnBox);
            exp.add_row(actionRow);

            this._listGroup.add(exp);
        });

        // --- ADD NEW PROFILE UI ---
        const addRow = new Adw.ActionRow({ title: 'Create Custom Integration Mapping' });
        const typeCombo = new Gtk.ComboBoxText({ valign: Gtk.Align.CENTER });
        typeCombo.append('gemini', 'Google Gemini');
        typeCombo.append('openai', 'OpenAI Platform');
        typeCombo.append('ollama', 'Ollama Engine');
        typeCombo.set_active(0);

        const addBtn = new Gtk.Button({ label: '➕ Append Profile', valign: Gtk.Align.CENTER });
        addBtn.add_css_class('suggested-action');
        addBtn.connect('clicked', () => {
            this._log('ADD BUTTON CLICKED');
            if (this._isUpdatingUI) {
                this._log(`Add ignored - UI is currently locked.`);
                return;
            }
            
            const current = this._getProfiles();
            const providerType = typeCombo.get_active_id();
            const newId = `profile_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
            
            this._log(`Constructing new profile: ${newId} (${providerType})`);
            
            current.push({
                id: newId,
                name: `New ${providerType.toUpperCase()}`,
                provider: providerType,
                url: providerType === 'ollama' ? 'http://localhost:11434' : '',
                model: providerType === 'ollama' ? 'llama3' : (providerType === 'openai' ? 'gpt-4o' : 'gemini-3.1-flash-lite'),
                apiKey: ''
            });
            this._saveProfiles(current, 'ADD_ACTION');
            
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._renderUI();
                return GLib.SOURCE_REMOVE;
            });
        });

        addRow.add_suffix(typeCombo);
        addRow.add_suffix(addBtn);
        this._addGroup.add(addRow);

        // --- DEBUG CONSOLE RENDER ---
        const debugView = new Gtk.TextView({
            buffer: this._debugBuffer,
            editable: false,
            wrap_mode: Gtk.WrapMode.WORD_CHAR,
            pixels_above_lines: 4,
            pixels_below_lines: 4,
            left_margin: 8,
            right_margin: 8,
            monospace: true
        });
        const scrolled = new Gtk.ScrolledWindow({
            min_content_height: 200,
            child: debugView
        });
        
        let clearBtn = new Gtk.Button({ label: 'Clear Logs', margin_top: 10, halign: Gtk.Align.END });
        clearBtn.connect('clicked', () => {
            this._debugBuffer.set_text('', -1);
            this._log('Log cleared');
        });
        
        let debugBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 5 });
        debugBox.append(scrolled);
        debugBox.append(clearBtn);
        
        this._debugGroup.add(debugBox);

        this._isUpdatingUI = false;
        this._log('UI interface rebuilt successfully.');
    }

    async _executeCurl(cmd) {
        // Redact secrets in UI logs to avoid leaking API keys on screen
        const safeCmdLog = cmd.map(arg => {
            if (arg.includes('Bearer ') || arg.includes('key=')) return '[REDACTED_SECRET]';
            return arg;
        }).join(' ');
        
        this._log(`Executing Subprocess: ${safeCmdLog}`);
        
        const proc = Gio.Subprocess.new(cmd, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        return new Promise((resolve, reject) => {
            proc.communicate_utf8_async(null, null, (obj, res) => {
                const [ok, stdout, stderr] = obj.communicate_utf8_finish(res);
                if (!ok || proc.get_successful() === false) {
                    this._log(`Curl failed: ${stderr}`);
                    reject(new Error(stderr || 'Subprocess execution failed.'));
                } else {
                    resolve(stdout);
                }
            });
        });
    }

    async _fetchModels(profile) {
        let cmd = ['curl', '-s'];
        
        if (profile.provider === 'ollama') {
            const baseUrl = profile.url ? profile.url.replace(/\/$/, '') : 'http://localhost:11434';
            cmd.push(`${baseUrl}/api/tags`);
            const stdout = await this._executeCurl(cmd);
            const data = JSON.parse(stdout);
            return data.models.map(m => m.name);
        } 
        else if (profile.provider === 'openai') {
            cmd.push('-H', `Authorization: Bearer ${profile.apiKey}`);
            cmd.push('[https://api.openai.com/v1/models](https://api.openai.com/v1/models)');
            const stdout = await this._executeCurl(cmd);
            const data = JSON.parse(stdout);
            return data.data.map(m => m.id);
        } 
        else if (profile.provider === 'gemini') {
            cmd.push(`https://generativelanguage.googleapis.com/v1beta/models?key=${profile.apiKey}`);
            const stdout = await this._executeCurl(cmd);
            const data = JSON.parse(stdout);
            return data.models.map(m => m.name.replace('models/', ''));
        }
        return [];
    }

    async _testConnection(profile) {
        let cmd = ['curl', '-s', '-X', 'POST'];
        let payload = {};
        let endpoint = '';

        if (profile.provider === 'ollama') {
            const baseUrl = profile.url ? profile.url.replace(/\/$/, '') : 'http://localhost:11434';
            endpoint = `${baseUrl}/api/chat`;
            cmd.push(endpoint);
            cmd.push('-H', 'Content-Type: application/json');
            payload = {
                model: profile.model,
                messages: [{ role: 'user', content: 'hello' }],
                stream: false
            };
        } 
        else if (profile.provider === 'openai') {
            endpoint = '[https://api.openai.com/v1/chat/completions](https://api.openai.com/v1/chat/completions)';
            cmd.push(endpoint);
            cmd.push('-H', `Authorization: Bearer ${profile.apiKey}`);
            cmd.push('-H', 'Content-Type: application/json');
            payload = {
                model: profile.model,
                messages: [{ role: 'user', content: 'hello' }]
            };
        } 
        else if (profile.provider === 'gemini') {
            endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${profile.model}:generateContent?key=${profile.apiKey}`;
            cmd.push(endpoint);
            cmd.push('-H', 'Content-Type: application/json');
            payload = {
                contents: [{ role: 'user', parts: [{ text: 'hello' }] }]
            };
        }

        cmd.push('-d', JSON.stringify(payload));
        
        this._log(`Test Connection -> Provider: ${profile.provider}, Model: ${profile.model}`);
        this._log(`Payload Prepared: ${JSON.stringify(payload)}`);

        const stdout = await this._executeCurl(cmd);
        
        let response;
        try {
            response = JSON.parse(stdout);
        } catch (e) {
            this._log(`Failed to parse JSON response. Raw output: ${stdout}`);
            throw new Error('Invalid JSON response from server');
        }

        this._log(`Raw Response Data: ${JSON.stringify(response).substring(0, 150)}...`);
        
        if (response.error) {
            throw new Error(response.error.message || 'API Error returned in response');
        }
        if (profile.provider === 'openai' && !response.choices) throw new Error('Invalid OpenAI response structure');
        if (profile.provider === 'gemini' && !response.candidates) throw new Error('Invalid Gemini response structure');
        
        return true;
    }
}

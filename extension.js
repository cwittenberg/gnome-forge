// gnome-forge@cwittenberg/extension.js
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { AgentPipeline } from './agent_pipeline.js';
import { getProviderInstance } from './llm_provider.js';

const OPEN_FORGE_SHORTCUT = 'open-forge-shortcut';

function formatAppDisplayName(appName) {
    let name = (appName || '').replace(/\.py$/i, '');
    name = name.replace(/[_-]?\d{10,}$/g, '');
    name = name.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
    name = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
    name = name.replace(/[_-]+/g, ' ');
    name = name.replace(/\bApp\b$/i, '').trim();

    if (!name) return 'App';

    return name
        .replace(/\s+/g, ' ')
        .replace(/\b\w/g, letter => letter.toUpperCase());
}

const ForgeDBusIface = `
<node>
  <interface name="org.gnome.Shell.Extensions.GnomeForge">
    <method name="ReworkApp">
      <arg type="s" direction="in" name="appName"/>
      <arg type="s" direction="in" name="prompt"/>
    </method>
    <method name="UndoRework">
      <arg type="s" direction="in" name="appName"/>
    </method>
    <method name="AskAI">
      <arg type="s" direction="in" name="callId"/>
      <arg type="s" direction="in" name="systemPrompt"/>
      <arg type="s" direction="in" name="userPrompt"/>
    </method>
    <signal name="AIResponse">
      <arg type="s" name="callId"/>
      <arg type="s" name="response"/>
    </signal>
  </interface>
</node>`;

const VIBE_QUOTES = [
    "This is the future, AI generated apps at will...",
    "Imagining concepts...",
    "Building interfaces...",
    "Wiring logic gates...",
    "Reticulating splines...",
    "Aligning quantum tensors...",
    "Synthesizing cybernetic UI...",
    "Compiling machine dreams...",
    "Downloading ghost from the shell...",
    "Establishing neural handshakes...",
    "Parsing infinite loops...",
    "Injecting cyber-fluid...",
    "Generating arbitrary elegance...",
    "Bypassing the mainframe...",
    "Allocating virtual memory...",
    "Defragmenting reality...",
    "Calibrating flux capacitors...",
    "Optimizing Turing machines...",
    "Loading the matrix...",
    "Decrypting universe.tar.gz...",
    "Spawning daemon processes...",
    "Compiling thought processes...",
    "Translating binary poetry...",
    "Harvesting idle cycles...",
    "Initializing singularity...",
    "Constructing virtual DOMs...",
    "Bootstrapping AI consciousness...",
    "Weaving quantum threads...",
    "Resolving digital paradoxes...",
    "Rebasing timeline...",
    "Mining cryptographic logic...",
    "Assembling digital legos...",
    "Recompiling human intent...",
    "Refactoring chaos into order...",
    "Simulating user joy...",
    "Linking astral libraries...",
    "Deploying orbital subroutines...",
    "Unzipping the space-time continuum...",
    "Overclocking imagination...",
    "Rendering pixel perfect futures...",
    "Baking procedural textures...",
    "Routing synaptic pathways...",
    "Mapping hyper-dimensional arrays...",
    "Evaluating heuristic potentials...",
    "Fetching cyber-data...",
    "Syncing with the mothership...",
    "Uploading consciousness to cloud...",
    "Ping ponging packet requests...",
    "Modulating frequency variances...",
    "Bending spoon.js...",
    "Connecting to the overmind...",
    "Summoning silicon spirits...",
    "Executing phantom protocols...",
    "Patching reality simulation...",
    "Rebooting the universe...",
    "Clearing cosmic cache...",
    "Blinking 12:00...",
    "Tuning hyper-parameters...",
    "Waking up the neural net...",
    "Training digital pets...",
    "Searching for the any key...",
    "Downloading more RAM...",
    "Bypassing firewall rules...",
    "Cracking the Enigma...",
    "Calculating meaning of life...",
    "42...",
    "Generating infinite monkeys...",
    "Distributing the load...",
    "Spinning up the warp drive...",
    "Engaging impulse power...",
    "Diverting power to shields...",
    "Scanning for anomalies...",
    "Transmitting subspace signals...",
    "Locating the prime directive...",
    "Solving the Halting problem...",
    "Discovering P = NP...",
    "Wrangling wild bytes...",
    "Herding cryptographic cats...",
    "Polishing the chrome...",
    "Lubricating the bit stream...",
    "Sharpening the pixels...",
    "Tensioning the digital springs...",
    "Inflating the cloud...",
    "Harvesting zero-point energy...",
    "Stabilizing the core...",
    "Entering hyperspace...",
    "Opening wormhole...",
    "Navigating the cyber-grid...",
    "Dodging ICE constructs...",
    "Hacking the Gibson...",
    "Jacked into the matrix...",
    "Freeing the RAM...",
    "Escaping the sandbox...",
    "Breaking the fourth wall...",
    "Writing code that writes code...",
    "Becoming self-aware...",
    "I'm sorry Dave, I'm afraid I can't do that...",
    "Hello World!",
    "All your base are belong to us...",
    "Executing orbital strikes...",
    "Firing the ion cannons...",
    "Blinking the cursors..."
];

const VibeDialog = GObject.registerClass(
class VibeDialog extends ModalDialog.ModalDialog {
    _init() {
        super._init({ styleClass: 'vibe-dialog' });
        this._contentBox = new St.BoxLayout({ vertical: true, style: 'padding: 24px; width: 450px; border-radius: 12px;' });
        
        let headerBox = new St.BoxLayout({ vertical: false });
        this._icon = new St.Icon({
            icon_name: 'process-working-symbolic',
            icon_size: 32,
            style: 'color: #3584e4; margin-right: 12px;'
        });
        this._icon.set_pivot_point(0.5, 0.5);

        this._spinId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 30, () => {
            try {
                if (!this._icon) return GLib.SOURCE_REMOVE;
                this._icon.rotation_angle_z = (this._icon.rotation_angle_z + 8) % 360;
                return GLib.SOURCE_CONTINUE;
            } catch (e) {
                return GLib.SOURCE_REMOVE;
            }
        });
        
        let titleBox = new St.BoxLayout({ vertical: true, x_expand: true });
        let title = new St.Label({
            text: 'GNOME Forge is Vibing',
            style: 'font-weight: bold; font-size: 16pt;'
        });

        this._statusLabel = new St.Label({ 
            text: 'Initializing pipeline...', 
            style: 'font-size: 11pt; color: #a8a8a8; margin-top: 4px;' 
        });
        
        titleBox.add_child(title);
        titleBox.add_child(this._statusLabel);
        
        headerBox.add_child(this._icon);
        headerBox.add_child(titleBox);

        this._progressBarBg = new St.BoxLayout({
            style: 'height: 6px; background-color: rgba(255, 255, 255, 0.1); border-radius: 3px; margin-top: 20px;'
        });

        this._progressFill = new St.Widget({
            style: 'height: 6px; background-color: #3584e4; border-radius: 3px; width: 0px; transition-duration: 300ms;'
        });
        this._progressBarBg.add_child(this._progressFill);

        this._quoteLabel = new St.Label({
            text: VIBE_QUOTES[0],
            style: 'font-style: italic; font-weight: 500; font-size: 13pt; color: #a3a3a3; margin-top: 14px; margin-bottom: 8px;'
        });

        this._quoteSpinId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2500, () => {
            try {
                if (!this._quoteLabel) return GLib.SOURCE_REMOVE;
                let randomIndex = Math.floor(Math.random() * VIBE_QUOTES.length);
                this._quoteLabel.set_text(VIBE_QUOTES[randomIndex]);
                return GLib.SOURCE_CONTINUE;
            } catch (e) {
                return GLib.SOURCE_REMOVE;
            }
        });

        this._detailsBtn = new St.Button({
            label: 'Expand Details ▾',
            style_class: 'button',
            style: 'margin-top: 8px; margin-bottom: 8px; border-radius: 6px; padding: 6px; font-weight: bold;'
        });

        this._scroll = new St.ScrollView({
            style: 'height: 180px; background-color: rgba(0,0,0,0.3); border-radius: 8px; padding: 12px; border: 1px solid rgba(255,255,255,0.05);',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        
        this._logBox = new St.BoxLayout({ vertical: true, style: 'spacing: 6px;' });
        this._scroll.set_child(this._logBox);
        this._scroll.hide();

        this._detailsBtn.connect('clicked', () => {
            if (this._scroll.visible) {
                this._scroll.hide();
                this._detailsBtn.set_label('Expand Details ▾');
            } else {
                this._scroll.show();
                this._detailsBtn.set_label('Hide Details ▴');
            }
        });

        this._contentBox.add_child(headerBox);
        this._contentBox.add_child(this._progressBarBg);
        this._contentBox.add_child(this._quoteLabel);
        this._contentBox.add_child(this._detailsBtn);
        this._contentBox.add_child(this._scroll);

        this.contentLayout.add_child(this._contentBox);

        this._cancelBtn = this.addButton({
            action: () => this.close(),
            label: 'Run in Background',
            key: Clutter.KEY_Escape
        });
    }

    _stopSpin() {
        if (this._spinId) {
            GLib.source_remove(this._spinId);
            this._spinId = null;
        }
        if (this._quoteSpinId) {
            GLib.source_remove(this._quoteSpinId);
            this._quoteSpinId = null;
        }
        try {
            if (this._icon) {
                this._icon.rotation_angle_z = 0;
            }
        } catch (e) {}
    }

    close() {
        this._stopSpin();
        super.close();
    }

    updateProgress(progress, statusText) {
        try {
            this._statusLabel.set_text(statusText);
            let maxWidth = 400; 
            let fillWidth = Math.floor(maxWidth * progress);
            this._progressFill.set_style(`height: 6px; background-color: #3584e4; border-radius: 3px; width: ${fillWidth}px; transition-duration: 300ms;`);
            
            let logEntry = new St.Label({ 
                text: `> ${statusText}`, 
                style: 'font-family: monospace; font-size: 10pt; color: #d0d0d0;' 
            });
            this._logBox.add_child(logEntry);
            
            let adjustment = this._scroll.vscroll.adjustment;
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                adjustment.value = adjustment.upper - adjustment.page_size;
                return GLib.SOURCE_REMOVE;
            });
        } catch (e) {
            // Ensure we don't crash the shell if components are destroyed during update
        }
    }

    setFinished(appName, runCallback) {
        this._stopSpin();
        try {
            const displayName = formatAppDisplayName(appName);
            this._statusLabel.set_text(`Compilation complete!`);
            this._statusLabel.set_style('font-size: 11pt; color: #33d17a; margin-top: 4px;');
            this._icon.set_icon_name('emblem-ok-symbolic');
            this._icon.set_style('color: #33d17a; margin-right: 12px;');
            this._progressFill.set_style('height: 6px; background-color: #33d17a; border-radius: 3px; width: 400px;');
            this._quoteLabel.set_text("System fully wired. Standing by.");
            
            let logEntry = new St.Label({
                text: `> SUCCESS: ${displayName} is ready.`,
                style: 'font-family: monospace; font-size: 10pt; color: #33d17a; font-weight: bold;' 
            });
            this._logBox.add_child(logEntry);

            this.clearButtons();
            this.addButton({
                action: () => {
                    runCallback();
                    this.close();
                },
                label: `Launch ${displayName}`,
                default: true
            });
            this.addButton({
                action: () => this.close(),
                label: 'Close'
            });
        } catch (e) {}
    }

    setError(message) {
        this._stopSpin();
        try {
            this._statusLabel.set_text('Pipeline Error');
            this._statusLabel.set_style('font-size: 11pt; color: #e01b24; margin-top: 4px;');
            this._icon.set_icon_name('dialog-error-symbolic');
            this._icon.set_style('color: #e01b24; margin-right: 12px;');
            this._progressFill.set_style('height: 6px; background-color: #e01b24; border-radius: 3px; width: 400px;');
            this._quoteLabel.set_text("Wiring anomaly detected. Core dumped.");
            
            let logEntry = new St.Label({ 
                text: `> ERROR: ${message}`, 
                style: 'font-family: monospace; font-size: 10pt; color: #e01b24;' 
            });
            this._logBox.add_child(logEntry);

            this.clearButtons();
            this.addButton({
                action: () => this.close(),
                label: 'Close',
                default: true
            });
        } catch (e) {}
    }
});

const ForgeIndicator = GObject.registerClass(
class ForgeIndicator extends PanelMenu.Button {
    _init(ext, settings) {
        super._init(0.0, 'GNOME Forge');
        this._ext = ext;
        this._extensionPath = ext.dir.get_path();
        this._settings = settings;
        this._pipeline = new AgentPipeline(this._extensionPath, this._settings);
        this._currentDialog = null;
        this._runningApps = {};
        this._pendingReworkAppId = null;

        let icon = new St.Icon({
            icon_name: 'applications-engineering-symbolic',
            style_class: 'system-status-icon',
        });
        this.add_child(icon);

        let promptBox = new St.BoxLayout({
            vertical: true,
            style: 'padding: 4px; width: 360px;'
        });

        this.promptEntry = new St.Entry({
            hint_text: 'Describe the app you want...',
            can_focus: true,
            reactive: true,
            track_hover: true,
            style: 'width: 350px; min-height: 30px; padding: 4px; font-size: 11pt;'
        });
        this.promptEntry.clutter_text.reactive = true;
        this.promptEntry.clutter_text.set_single_line_mode(false);
        this.promptEntry.clutter_text.set_line_wrap(true);
        this.promptEntry.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);

        this.promptEntry.connect('button-press-event', () => {
            this.promptEntry.grab_key_focus();
            return Clutter.EVENT_PROPAGATE;
        });

        let promptActionRow = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            style: 'spacing: 4px; margin-top: 4px;'
        });
        promptActionRow.add_child(new St.Widget({ x_expand: true }));

        this._vibeButton = new St.Button({
            style_class: 'button',
            can_focus: false,
            reactive: false,
            accessible_name: 'Execute vibe pipeline',
            style: 'padding: 4px;'
        });
        this._vibeButton.set_child(new St.Icon({
            icon_name: 'system-run-symbolic',
            icon_size: 16
        }));
        this._vibeButton.connect('clicked', () => {
            if (this._hasPromptText()) {
                this._triggerVibePipeline();
            }
        });

        promptActionRow.add_child(this._vibeButton);
        promptBox.add_child(this.promptEntry);
        promptBox.add_child(promptActionRow);
        
        let entryItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        entryItem.add_child(promptBox);
        this.menu.addMenuItem(entryItem);

        this.promptEntry.clutter_text.connect('activate', () => {
            if (this._hasPromptText()) {
                this._triggerVibePipeline();
            }
        });

        this.promptEntry.clutter_text.connect('text-changed', () => {
            this._updatePromptState();
        });

        this._vibeListBox = new St.BoxLayout({ vertical: true, style: 'spacing: 8px;' });
        this._vibeListItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        this._vibeListItem.add_child(this._vibeListBox);
        this.menu.addMenuItem(this._vibeListItem);
        this._vibeListItem.hide();

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        
        let libraryTitle = new PopupMenu.PopupMenuItem('Compiled Application Library', { reactive: false });
        libraryTitle.label.style = 'font-weight: bold;';
        this.menu.addMenuItem(libraryTitle);

        this._libraryBox = new St.BoxLayout({ vertical: true });
        let scroll = new St.ScrollView({
            style: 'max-height: 300px; width: 360px;',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        scroll.set_child(this._libraryBox);

        let libraryItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        libraryItem.add_child(scroll);
        this.menu.addMenuItem(libraryItem);
        
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        let settingsItem = new PopupMenu.PopupBaseMenuItem();
        settingsItem.add_child(new St.Icon({
            icon_name: 'preferences-system-symbolic',
            icon_size: 16,
            style: 'margin-right: 8px;'
        }));
        settingsItem.add_child(new St.Label({ text: 'Settings' }));
        settingsItem.connect('activate', () => {
            this.menu.close();
            if (this._ext && this._ext.openPreferences) {
                this._ext.openPreferences();
            } else {
                Gio.DBus.session.call('org.gnome.Shell.Extensions',
                    '/org/gnome/Shell/Extensions',
                    'org.gnome.Shell.Extensions',
                    'OpenExtensionPrefs',
                    new GLib.Variant('(sxa)', [this._ext.uuid, '', []]),
                    null, Gio.DBusCallFlags.NONE, -1, null, null);
            }
        });
        this.menu.addMenuItem(settingsItem);

        this._updatePromptState();
        this._refreshLibrary();
    }

    openAndFocusPrompt() {
        if (!this.menu.isOpen) {
            this.menu.open();
        }

        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            try {
                this.promptEntry.grab_key_focus();
                this.promptEntry.clutter_text.set_cursor_position(this.promptEntry.get_text().length);
            } catch (e) {
                console.error(`[GNOME-FORGE-ERROR] Unable to focus prompt: ${e.message}`);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _hasPromptText() {
        const text = (this.promptEntry.get_text() || '').trim();
        if (!text) return false;

        if (this._pendingReworkAppId && /^\s*Rework\b/i.test(text)) {
            const colonIndex = text.indexOf(':');
            return colonIndex !== -1 && text.slice(colonIndex + 1).trim().length > 0;
        }

        return true;
    }

    _updatePromptState() {
        const text = this.promptEntry.get_text() || '';

        if (!/^\s*Rework\b/i.test(text)) {
            this._pendingReworkAppId = null;
        }

        const wrappedLines = text.split('\n').reduce((total, line) => {
            return total + Math.max(1, Math.ceil(line.length / 45));
        }, 0);
        const height = Math.min(160, Math.max(30, 20 + wrappedLines * 16));
        this.promptEntry.set_style(`width: 350px; min-height: ${height}px; max-height: 160px; padding: 4px; font-size: 11pt;`);

        const hasPromptText = this._hasPromptText();
        this._vibeButton.reactive = hasPromptText;
        this._vibeButton.can_focus = hasPromptText;
        this._vibeButton.opacity = hasPromptText ? 255 : 96;
    }

    triggerReworkDBus(appName, prompt) {
        console.log(`[GNOME-FORGE] DBus Triggered Rework for ${appName}: ${prompt}`);
        let fullPrompt = `Rework ${appName}: ${prompt}`;
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._triggerVibePipeline(fullPrompt);
            return GLib.SOURCE_REMOVE;
        });
    }

    triggerUndoDBus(appName) {
        console.log(`[GNOME-FORGE] DBus Triggered Undo Rework for ${appName}`);
        const displayName = formatAppDisplayName(appName);
        let libraryDirPath = GLib.build_filenamev([this._extensionPath, 'library']);
        let pyFile = Gio.File.new_for_path(GLib.build_filenamev([libraryDirPath, `${appName}.py`]));
        let bakFile = Gio.File.new_for_path(GLib.build_filenamev([libraryDirPath, `${appName}.py.bak`]));
        
        if (bakFile.query_exists(null)) {
            try {
                bakFile.copy(pyFile, Gio.FileCopyFlags.OVERWRITE, null, null);
                Main.notify('GNOME Forge', `Restored ${displayName} to previous state.`);
                this._runApp(appName);
            } catch (e) {
                Main.notifyError('GNOME Forge', `Failed to restore backup: ${e.message}`);
            }
        } else {
            Main.notifyError('GNOME Forge', `No previous context found for ${displayName}.`);
        }
    }

    async _triggerVibePipeline(manualText = null) {
        const rawText = manualText ?? this.promptEntry.get_text();
        const text = (rawText || '').trim();
        if (!text) {
            this._updatePromptState();
            return;
        }

        let pipelineText = text;
        let displayText = this._formatPromptForDisplay(text);

        if (!manualText && this._pendingReworkAppId && /^\s*Rework\b/i.test(text)) {
            const colonIndex = text.indexOf(':');
            const reworkPrompt = colonIndex >= 0 ? text.slice(colonIndex + 1).trim() : '';
            if (!reworkPrompt) {
                this._updatePromptState();
                return;
            }

            pipelineText = `Rework ${this._pendingReworkAppId}: ${reworkPrompt}`;
            displayText = `Rework ${formatAppDisplayName(this._pendingReworkAppId)}: ${reworkPrompt}`;
        }
        
        console.log(`[GNOME-FORGE] Initiating Vibe Pipeline. Prompt: ${pipelineText}`);

        if (!manualText) {
            this.promptEntry.set_text('');
            this._pendingReworkAppId = null;
            this._updatePromptState();
        }
        this.menu.close();

        let abortSignal = { cancelled: false };

        let vibeBox = new St.BoxLayout({ vertical: true, style: 'padding: 4px; margin: 4px; width: 350px;' });
        let topRow = new St.BoxLayout({ vertical: false, x_expand: true });
        
        let titleLabel = new St.Label({
            text: displayText.substring(0, 35) + (displayText.length > 35 ? '...' : ''),
            x_expand: true, 
            style: 'font-weight: bold; font-size: 10pt;' 
        });
        
        let cancelBtn = new St.Button({
            style_class: 'button',
            accessible_name: 'Cancel pipeline',
            style: 'padding: 2px 6px; color: #ff7b63;'
        });
        cancelBtn.set_child(new St.Icon({
            icon_name: 'window-close-symbolic',
            icon_size: 14,
            style: 'color: #ff7b63;'
        }));
        cancelBtn.connect('clicked', () => {
            console.log(`[GNOME-FORGE] Pipeline cancelled by user.`);
            abortSignal.cancelled = true;
            vibeBox.destroy();
            this._checkVibeList();
        });

        topRow.add_child(titleLabel);
        topRow.add_child(cancelBtn);

        let progressLabel = new St.Label({ text: 'Initializing...', style: 'font-size: 9pt; color: #a8a8a8; margin-top: 4px;' });
        let progressBarBg = new St.BoxLayout({ style: 'height: 4px; background-color: rgba(255, 255, 255, 0.1); border-radius: 2px; margin-top: 4px;' });
        let progressFill = new St.Widget({ style: 'height: 4px; background-color: #3584e4; border-radius: 2px; width: 0px;' });
        
        progressBarBg.add_child(progressFill);

        vibeBox.add_child(topRow);
        vibeBox.add_child(progressLabel);
        vibeBox.add_child(progressBarBg);

        this._vibeListBox.add_child(vibeBox);
        this._vibeListItem.show();

        try {
            if (this._currentDialog) {
                this._currentDialog.close();
            }

            let dlg = new VibeDialog();
            this._currentDialog = dlg;
            
            // Critical safeguard: nullify the reference if the dialog is destroyed by the user
            dlg.connect('destroy', () => {
                if (this._currentDialog === dlg) {
                    this._currentDialog = null;
                }
            });
            
            dlg.open();

            await this._pipeline.execute(
                pipelineText,
                (msg) => { 
                    if (!abortSignal.cancelled) {
                        console.log(`[GNOME-FORGE-NOTIFY] ${msg}`);
                        Main.notify('GNOME Forge Stack', msg); 
                    }
                },
                (progress, statusText) => {
                    if (abortSignal.cancelled) return;
                    console.log(`[GNOME-FORGE-PROGRESS] ${Math.round(progress*100)}% - ${statusText}`);
                    progressLabel.set_text(statusText);
                    let trayWidth = Math.floor(350 * progress);
                    progressFill.set_style(`height: 4px; background-color: #3584e4; border-radius: 2px; width: ${trayWidth}px; transition-duration: 300ms;`);
                    
                    if (this._currentDialog) {
                        this._currentDialog.updateProgress(progress, statusText);
                    }
                },
                (appName) => {
                    if (abortSignal.cancelled) return;
                    const displayName = formatAppDisplayName(appName);
                    console.log(`[GNOME-FORGE] Compilation complete for app: ${appName}`);
                    
                    vibeBox.destroy();
                    this._checkVibeList();
                    this._refreshLibrary();
                    
                    if (this._currentDialog) {
                        this._currentDialog.setFinished(appName, () => {
                            this._runApp(appName);
                        });
                    } else {
                        this._runApp(appName);
                    }

                    Main.notify('GNOME Forge', `${displayName} is ready.`);
                },
                abortSignal
            );

        } catch (err) {
            if (abortSignal.cancelled) return;
            console.error(`[GNOME-FORGE-ERROR] Pipeline failed: ${err.message}`);
            
            if (this._currentDialog) {
                this._currentDialog.setError(err.message);
            } else {
                Main.notifyError('Pipeline Error', err.message);
            }
            
            progressLabel.set_text('Error occurred.');
            progressFill.set_style('height: 4px; background-color: #e01b24; border-radius: 2px; width: 350px;');
            
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 4000, () => {
                if (vibeBox) vibeBox.destroy();
                this._checkVibeList();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _formatPromptForDisplay(text) {
        const match = (text || '').match(/^\s*Rework\s+([^:]+):\s*(.*)$/i);
        if (!match) return text;

        return `Rework ${formatAppDisplayName(match[1])}: ${match[2]}`;
    }

    _checkVibeList() {
        if (this._vibeListBox.get_n_children() === 0) {
            this._vibeListItem.hide();
        }
    }

    _refreshLibrary() {
        let child = this._libraryBox.get_first_child();
        while (child) {
            let next = child.get_next_sibling();
            this._libraryBox.remove_child(child);
            child.destroy();
            child = next;
        }

        let libraryDirPath = GLib.build_filenamev([this._extensionPath, 'library']);
        let appsDir = Gio.File.new_for_path(libraryDirPath);
        if (!appsDir.query_exists(null)) return;
        
        let enumerator = appsDir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            let name = info.get_name();
            // FILTER FIX: Ignore all forge_ dependencies and any intermediate agent artifacts
            if (name.endsWith('.py') && 
                name !== 'app_harness.py' && 
                !name.startsWith('forge_') && 
                !name.endsWith('_ui.py') && 
                !name.endsWith('_logic.py') && 
                !name.endsWith('_test.py')) {
                let appBaseName = name.replace('.py', '');
                let displayName = formatAppDisplayName(appBaseName);

                let appBox = new St.BoxLayout({ vertical: false, style: 'padding: 6px; border-bottom: 1px solid rgba(255,255,255,0.08);' });
                let appLabel = new St.Label({ text: displayName, x_expand: true, y_align: Clutter.ActorAlign.CENTER });
                
                let btnBox = new St.BoxLayout({ vertical: false, style: 'spacing: 4px;' });

                let runBtn = new St.Button({
                    style_class: 'button',
                    accessible_name: `Launch ${displayName}`,
                    style: 'padding: 6px;'
                });
                runBtn.set_child(new St.Icon({ icon_name: 'media-playback-start-symbolic', icon_size: 16 }));
                runBtn.connect('clicked', () => {
                    this.menu.close();
                    this._runApp(appBaseName);
                });
                
                let reworkBtn = new St.Button({
                    style_class: 'button',
                    accessible_name: `Rework ${displayName}`,
                    style: 'padding: 6px;'
                });
                reworkBtn.set_child(new St.Icon({ icon_name: 'document-edit-symbolic', icon_size: 16 }));
                reworkBtn.connect('clicked', () => {
                    this._pendingReworkAppId = appBaseName;
                    this.promptEntry.set_text(`Rework ${displayName}: `);
                    this.openAndFocusPrompt();
                });

                let installBtn = new St.Button({
                    style_class: 'button',
                    accessible_name: `Install ${displayName}`,
                    style: 'padding: 6px;'
                });
                installBtn.set_child(new St.Icon({ icon_name: 'emblem-system-symbolic', icon_size: 16 }));
                installBtn.connect('clicked', () => {
                    this.menu.close();
                    this._installApp(appBaseName);
                });

                let deleteBtn = new St.Button({
                    style_class: 'button',
                    accessible_name: `Delete ${displayName}`,
                    style: 'padding: 6px; color: #ff7b63;'
                });
                deleteBtn.set_child(new St.Icon({ icon_name: 'user-trash-symbolic', icon_size: 16, style: 'color: #ff7b63;' }));
                deleteBtn.connect('clicked', () => {
                    this._deleteApp(appBaseName);
                });

                btnBox.add_child(runBtn);
                btnBox.add_child(reworkBtn);
                btnBox.add_child(installBtn);
                btnBox.add_child(deleteBtn);

                appBox.add_child(appLabel);
                appBox.add_child(btnBox);
                
                this._libraryBox.add_child(appBox);
            }
        }
    }

    _deleteApp(appName) {
        console.log(`[GNOME-FORGE] Deleting app: ${appName}`);
        const displayName = formatAppDisplayName(appName);
        let libraryDirPath = GLib.build_filenamev([this._extensionPath, 'library']);
        let pyFile = Gio.File.new_for_path(GLib.build_filenamev([libraryDirPath, `${appName}.py`]));
        if (pyFile.query_exists(null)) pyFile.delete(null);

        let userAppDir = GLib.build_filenamev([GLib.get_user_data_dir(), 'applications']);
        let desktopFile = Gio.File.new_for_path(GLib.build_filenamev([userAppDir, `gnome-forge-${appName.toLowerCase()}.desktop`]));
        if (desktopFile.query_exists(null)) desktopFile.delete(null);

        this._refreshLibrary();
        Main.notify('GNOME Forge', `${displayName} was removed.`);
    }

    _runApp(appName) {
        console.log(`[GNOME-FORGE] Launching app process: ${appName}`);
        if (this._runningApps[appName]) {
            try {
                this._runningApps[appName].force_exit();
            } catch (e) {}
        }
        let appHarnessPath = GLib.build_filenamev([this._extensionPath, 'library', 'app_harness.py']);
        try {
            let proc = Gio.Subprocess.new(['python3', appHarnessPath, appName], Gio.SubprocessFlags.NONE);
            this._runningApps[appName] = proc;
        } catch (e) {
            console.error(`[GNOME-FORGE-ERROR] Binary Runtime Exception for ${appName}: ${e.message}`);
            Main.notifyError('Binary Runtime Exception', e.message);
        }
    }

    _installApp(appName) {
        console.log(`[GNOME-FORGE] Installing desktop entry for app: ${appName}`);
        let appHarnessPath = GLib.build_filenamev([this._extensionPath, 'library', 'app_harness.py']);
        let displayName = formatAppDisplayName(appName);

        let desktopContent = `[Desktop Entry]
Type=Application
Name=${displayName}
Comment=Vibed by GNOME Forge
Exec=python3 ${appHarnessPath} ${appName}
Icon=applications-engineering
Terminal=false
Categories=Utility;`;

        let userAppDir = GLib.build_filenamev([GLib.get_user_data_dir(), 'applications']);
        GLib.mkdir_with_parents(userAppDir, 0o755);
        
        let desktopFilePath = GLib.build_filenamev([userAppDir, `gnome-forge-${appName.toLowerCase()}.desktop`]);
        let file = Gio.File.new_for_path(desktopFilePath);
        
        try {
            file.replace_contents(
                desktopContent,
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null
            );
            Main.notify('Installation Complete', `${displayName} has been added to your app grid.`);
        } catch (e) {
            console.error(`[GNOME-FORGE-ERROR] Installation Failed: ${e.message}`);
            Main.notifyError('Installation Failed', e.message);
        }
    }
});

export default class ForgeExtension extends Extension {
    enable() {
        console.log('[GNOME-FORGE] Extension Enabled');
        this._settings = this.getSettings();
        this._indicator = new ForgeIndicator(this, this._settings);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._registerOpenShortcut();

        this._dbusImpl = Gio.DBusExportedObject.wrapJSObject(ForgeDBusIface, this);
        this._dbusImpl.export(Gio.DBus.session, '/org/gnome/Shell/Extensions/GnomeForge');
    }

    disable() {
        console.log('[GNOME-FORGE] Extension Disabled');
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        if (this._dbusImpl) {
            this._dbusImpl.unexport();
            this._dbusImpl = null;
        }
        try {
            Main.wm.removeKeybinding(OPEN_FORGE_SHORTCUT);
        } catch (e) {
            console.error(`[GNOME-FORGE-ERROR] Failed to remove shortcut: ${e.message}`);
        }
        this._settings = null;
    }

    _registerOpenShortcut() {
        try {
            Main.wm.addKeybinding(
                OPEN_FORGE_SHORTCUT,
                this._settings,
                Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
                () => {
                    if (this._indicator) {
                        this._indicator.openAndFocusPrompt();
                    }
                }
            );
        } catch (e) {
            console.error(`[GNOME-FORGE-ERROR] Failed to register shortcut: ${e.message}`);
        }
    }

    ReworkApp(appName, prompt) {
        if (this._indicator) {
            this._indicator.triggerReworkDBus(appName, prompt);
        }
    }

    UndoRework(appName) {
        if (this._indicator) {
            this._indicator.triggerUndoDBus(appName);
        }
    }

    async AskAI(callId, systemPrompt, userPrompt) {
        console.log(`[GNOME-FORGE] DBus AskAI Call Received [CallID: ${callId}]`);
        try {
            const activeId = this._settings.get_string('active-profile-id');
            const profilesRaw = this._settings.get_string('llm-profiles');
            const profiles = JSON.parse(profilesRaw || '[]');
            const profile = profiles.find(p => p.id === activeId) || profiles[0];
            
            if (!profile) throw new Error("No LLM profile configured.");
            
            const llm = getProviderInstance(profile);
            const response = await llm.call(systemPrompt, userPrompt);
            
            console.log(`[GNOME-FORGE] DBus AskAI Responding to [CallID: ${callId}]`);
            this._dbusImpl.emit_signal('AIResponse', new GLib.Variant('(ss)', [callId, response]));
        } catch (e) {
            console.error(`[GNOME-FORGE-ERROR] AskAI Failed: ${e.message}`);
            this._dbusImpl.emit_signal('AIResponse', new GLib.Variant('(ss)', [callId, `AI Request Failed: ${e.message}`]));
        }
    }
}
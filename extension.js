import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {BackgroundAppsButton} from './backgroundApps.js';
import {Cell, IconGrid} from './grid.js';
import {PopupController, openDesktopApp} from './popups.js';
import {TileHider, collectTiles} from './tiles.js';

import * as Interfaces from './tray/interfaces.js';
import * as IndicatorStatusIcon from './tray/indicatorStatusIcon.js';
import * as StatusNotifierWatcher from './tray/statusNotifierWatcher.js';
import * as TrayIconsManager from './tray/trayIconsManager.js';
import * as Util from './tray/util.js';
import {Logger} from './tray/logger.js';
import {SettingsManager} from './tray/settingsManager.js';

const FOREIGN_APPINDICATOR = 'appindicatorsupport@rgcjonas.gmail.com';

const GSCONNECT_TYPE = 'GSConnectServiceIndicator';

// Right click on a system icon opens this page of the system settings.
const SETTINGS_WIFI = ['gnome-wifi-panel.desktop', 'Wi-Fi Settings'];
const SETTINGS_POWER = ['gnome-power-panel.desktop', 'Power Settings'];
const SETTINGS_SOUND = ['gnome-sound-panel.desktop', 'Sound Settings'];
const SETTINGS_DISPLAY = ['gnome-display-panel.desktop', 'Display Settings'];
const SETTINGS_PRIVACY = ['gnome-privacy-panel.desktop', 'Privacy Settings'];
const SETTINGS_PAGES = {
    'sys:network': SETTINGS_WIFI,
    'sys:rfkill': ['gnome-network-panel.desktop', 'Network Settings'],
    'sys:bluetooth': ['gnome-bluetooth-panel.desktop', 'Bluetooth Settings'],
    'sys:system': SETTINGS_POWER,
    'sys:powerProfiles': SETTINGS_POWER,
    'sys:volumeOutput': SETTINGS_SOUND,
    'sys:volumeInput': SETTINGS_SOUND,
    'sys:brightness': SETTINGS_DISPLAY,
    'sys:nightLight': SETTINGS_DISPLAY,
    'sys:autoRotate': SETTINGS_DISPLAY,
    'sys:darkMode': ['gnome-background-panel.desktop', 'Appearance Settings'],
    'sys:doNotDisturb': ['gnome-notifications-panel.desktop', 'Notification Settings'],
    'sys:backlight': ['gnome-keyboard-panel.desktop', 'Keyboard Settings'],
    'sys:camera': SETTINGS_PRIVACY,
    'sys:location': SETTINGS_PRIVACY,
    'sys:remoteAccess': SETTINGS_PRIVACY,
    'sys:gsconnect': ['org.gnome.Shell.Extensions.GSConnect.Preferences.desktop', 'Mobile Settings'],
};

// Readable names for the stock indicators (the settings window lists them).
const SYSTEM_LABELS = {
    'sys:network': 'Wi-Fi and network',
    'sys:bluetooth': 'Bluetooth',
    'sys:system': 'Battery and power',
    'sys:powerProfiles': 'Power mode',
    'sys:volumeOutput': 'Volume',
    'sys:volumeInput': 'Microphone in use',
    'sys:brightness': 'Brightness',
    'sys:nightLight': 'Night Light',
    'sys:darkMode': 'Dark Style',
    'sys:doNotDisturb': 'Do Not Disturb',
    'sys:backlight': 'Keyboard backlight',
    'sys:rfkill': 'Airplane mode',
    'sys:autoRotate': 'Auto rotate',
    'sys:camera': 'Camera in use',
    'sys:location': 'Location in use',
    'sys:remoteAccess': 'Screen sharing',
    'sys:thunderbolt': 'Thunderbolt',
    'sys:unsafeMode': 'Unsafe mode',
    'sys:gsconnect': 'GSConnect',
};

const SETUP_TRIES = 80;
const SETUP_GAP_MS = 100;

function sleepMs(ms) {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

/**
 * Merge a freshly dragged order into the remembered one without forgetting
 * icons that are currently absent (a closed tray app keeps its slot).
 */
export function mergeOrder(saved, current) {
    const result = current.slice();
    saved.forEach((id, index) => {
        if (current.includes(id))
            return;
        let at = 0;
        for (let before = index - 1; before >= 0; before--) {
            const position = result.indexOf(saved[before]);
            if (position >= 0) {
                at = position + 1;
                break;
            }
        }
        result.splice(at, 0, id);
    });
    return result;
}

export default class SplitSystemIndicators extends Extension {
    enable() {
        this._destroyed = false;
        this._settings = this.getSettings();
        this._qs = null;
        this._grid = null;
        this._popups = null;
        this._tiles = null;
        this._tileIndex = new Map();
        this._bgApps = null;
        this._systemCells = [];
        this._originalIndicators = [];
        this._orphans = new Set();
        this._orphanSource = 0;
        this._sources = new Set();
        this._hostState = null;
        this._statusNotifierWatcher = null;
        this._watchDog = null;
        this._trayStarted = false;

        this._setup().catch(error =>
            console.error(`[better-system-tray] setup failed: ${error}\n${error.stack ?? ''}`));
    }

    disable() {
        this._destroyed = true;

        for (const source of this._sources)
            GLib.source_remove(source);
        this._sources.clear();

        this._settings?.disconnectObject(this);
        this._orphanSource = 0;
        this._bgApps?.destroy();
        this._bgApps = null;
        this._tiles?.destroy();
        this._tiles = null;
        this._tileIndex.clear();
        this._unwatchMenus();
        this._sweepOrphans();
        this._popups?.destroy();
        this._popups = null;
        this._stopTray();
        this._restoreLayout();

        this._qs = null;
        this._settings = null;
    }

    // -- setup ------------------------------------------------------------

    async _setup() {
        this._disableForeignAppIndicator();
        await this._waitForWatcherNameFree();
        if (this._destroyed)
            return;

        const qs = await this._waitForQuickSettings();
        if (!qs || this._destroyed)
            return;

        this._qs = qs;
        this._popups = new PopupController(qs);
        this._installLayout();
        this._syncPopups();
        this._watchMenus();
        this._tiles = new TileHider();
        this._applyVisibility();
        this._syncBackgroundApps();
        this._startTray();

        this._settings.connectObject('changed', (_s, key) => this._onSettingsChanged(key), this);
    }

    async _waitForQuickSettings() {
        for (let i = 0; i < SETUP_TRIES && !this._destroyed; i++) {
            const qs = Main.panel.statusArea.quickSettings;
            if (qs?._system && qs._powerProfiles !== undefined && qs._network !== undefined)
                return qs;
            await sleepMs(SETUP_GAP_MS);
        }
        return Main.panel.statusArea.quickSettings ?? null;
    }

    _onSettingsChanged(key) {
        if (this._destroyed || !this._grid)
            return;

        if (key === 'known-items')
            return;

        if (key === 'icon-order') {
            const saved = this._savedOrder();
            if (saved.join('\n') !== this._grid.orderedIds().join('\n'))
                this._grid.applyOrder(saved);
            return;
        }

        if (key === 'visibility') {
            this._applyVisibility();
            return;
        }

        this._applyGridConfig();
        this._syncPopups();
        this._syncBackgroundApps();
    }

    _applyGridConfig() {
        this._grid.configure({
            columns: this._settings.get_int('columns'),
            padding: this._settings.get_int('icon-padding'),
            spacing: this._settings.get_int('icon-spacing'),
            fromBottom: this._settings.get_boolean('fill-from-bottom'),
        });
    }

    // -- layout -----------------------------------------------------------

    _installLayout() {
        const qs = this._qs;
        const box = qs._indicators;
        if (!box || this._grid)
            return;

        this._grid = new IconGrid();
        this._grid.onOrderCommitted = ids => this._saveOrder(ids);
        this._applyGridConfig();

        // The host button must not highlight (or open anything) as a whole:
        // every icon is its own button now.
        this._hostState = {
            clickEnabled: qs._clickGesture?.enabled ?? true,
            reactive: qs.reactive,
            canFocus: qs.can_focus,
            trackHover: qs.track_hover,
            hadPanelButton: qs.has_style_class_name('panel-button'),
        };
        qs._clickGesture?.set_enabled(false);
        qs.remove_style_class_name('panel-button');
        qs.add_style_class_name('ssi-host');
        qs.set({reactive: false, can_focus: false, track_hover: false});

        this._originalIndicators = box.get_children().slice();
        for (const indicator of this._originalIndicators)
            this._wrapIndicator(indicator);

        // PanelMenu.ButtonBox lays out only its first child.
        qs.insert_child_at_index(this._grid, 0);
        box.hide();

        this._origAddExternalIndicator = qs.addExternalIndicator;
        qs.addExternalIndicator = (indicator, colSpan = 1) => {
            this._wrapIndicator(indicator);
            this._grid.applyOrder(this._savedOrder());
            const sibling = qs._backgroundApps?.quickSettingsItems?.at(-1) ?? null;
            qs._addItemsBefore(indicator.quickSettingsItems, sibling, colSpan);
            this._syncPopups();
            this._applyVisibility();
        };

        this._grid.applyOrder(this._savedOrder());
    }

    _systemId(indicator) {
        const qs = this._qs;
        let base = null;
        for (const key of Object.keys(qs)) {
            if (key.startsWith('_') && qs[key] === indicator) {
                base = `sys:${key.slice(1)}`;
                break;
            }
        }
        if (!base && this._isGSConnect(indicator))
            base = 'sys:gsconnect';
        base ??= `sys:${indicator.constructor.name}`;

        let id = base;
        let n = 1;
        while (this._grid.cellById(id))
            id = `${base}#${++n}`;
        return id;
    }

    _wrapIndicator(indicator) {
        if (!indicator || this._systemCells.some(cell => cell.body === indicator))
            return null;

        indicator.get_parent()?.remove_child(indicator);
        const id = this._systemId(indicator);
        const cell = new Cell(id, 'system', indicator, indicator, {
            label: SYSTEM_LABELS[id] ?? indicator.quickSettingsItems?.[0]?.title ??
                id.replace(/^sys:/, ''),
            // "Always show" has to hold the indicator and the icons inside it.
            forceTargets: () => [
                indicator,
                ...indicator.get_children().filter(child => child instanceof St.Icon),
            ],
            onActivate: c => this._activateSystem(c),
            onContext: c => this._showContext(c),
        });
        this._systemCells.push(cell);
        this._grid.addCell(cell);

        // Another extension may tear its indicator down while we are running
        // (GNOME disables the extensions loaded after this one first).
        indicator.connectObject('destroy', () => this._indicatorDestroyed(indicator, cell), this);
        return cell;
    }

    _indicatorDestroyed(indicator, cell) {
        this._systemCells = this._systemCells.filter(c => c !== cell);
        this._originalIndicators = this._originalIndicators.filter(i => i !== indicator);
        this._grid?.removeCell(cell);

        // The indicator is still being torn down. Destroying its parent from
        // in here upsets Clutter, so the leftovers are swept a moment later.
        this._orphans.add(cell);
        if (this._orphanSource)
            return;
        const source = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._sources.delete(source);
            this._orphanSource = 0;
            this._sweepOrphans();
            return GLib.SOURCE_REMOVE;
        });
        this._orphanSource = source;
        this._sources.add(source);
    }

    _sweepOrphans() {
        for (const cell of this._orphans) {
            this._popups?.forgetCell(cell);
            cell.destroy();
        }
        this._orphans.clear();
    }

    _restoreLayout() {
        const qs = this._qs;
        if (qs?.addExternalIndicator && this._origAddExternalIndicator) {
            qs.addExternalIndicator = this._origAddExternalIndicator;
            this._origAddExternalIndicator = null;
        }

        if (this._grid && qs) {
            for (const cell of this._systemCells) {
                cell.body.disconnectObject(this);
                cell.disconnectObject(this._grid);
                cell.remove_child(cell.body);
            }
            for (const indicator of this._originalIndicators) {
                if (!indicator.get_parent())
                    qs._indicators.add_child(indicator);
            }
            // Anything added later by other extensions that we still hold.
            for (const cell of this._systemCells) {
                if (!cell.body.get_parent())
                    qs._indicators.add_child(cell.body);
            }
            qs._indicators.show();
            if (this._grid.get_parent() === qs)
                qs.remove_child(this._grid);
        }

        this._grid?.destroy();
        this._grid = null;
        this._systemCells = [];
        this._originalIndicators = [];

        if (qs && this._hostState) {
            qs.remove_style_class_name('ssi-host');
            if (this._hostState.hadPanelButton)
                qs.add_style_class_name('panel-button');
            qs.set({
                reactive: this._hostState.reactive,
                can_focus: this._hostState.canFocus,
                track_hover: this._hostState.trackHover,
            });
            qs._clickGesture?.set_enabled(this._hostState.clickEnabled);
        }
        this._hostState = null;
    }

    // GSConnect used to be saved under the name of its class.
    _savedOrder() {
        return this._settings.get_strv('icon-order')
            .map(id => (id === 'sys:ServiceIndicator' ? 'sys:gsconnect' : id));
    }

    _saveOrder(ids) {
        const saved = this._savedOrder();
        this._settings.set_strv('icon-order', mergeOrder(saved, ids));
    }

    // -- activation -------------------------------------------------------

    _isGSConnect(indicator) {
        const item = indicator?.quickSettingsItems?.[0];
        return !!item && GObject.type_name_from_instance(item) === GSCONNECT_TYPE;
    }

    // [indicator, popup kind, setting] for the icons that get their own popup.
    _dedicatedPopups() {
        const qs = this._qs;
        const gsconnect = this._systemCells.map(cell => cell.body).find(i => this._isGSConnect(i));
        return [
            [qs._network, 'network', 'split-wifi'],
            [qs._bluetooth, 'bluetooth', 'split-bluetooth'],
            [qs._system, 'power', 'split-power'],
            [qs._powerProfiles, 'performance', 'split-performance'],
            [gsconnect, 'gsconnect', 'split-gsconnect'],
        ].filter(([indicator]) => indicator);
    }

    _syncPopups() {
        if (!this._popups || !this._grid)
            return;

        for (const [indicator, kind, key] of this._dedicatedPopups()) {
            const cell = this._systemCells.find(c => c.body === indicator);
            if (cell)
                this._popups.setPopup(kind, cell, this._settings.get_boolean(key));
        }
    }

    // -- clicks while another menu is open --------------------------------

    // An open menu holds a pointer grab: a click on one of our icons only
    // reaches the menu, which closes itself. Listen on every menu of the panel
    // for such a press and treat it as a click on the icon underneath, so one
    // click both closes the open menu and opens the one that was clicked.
    _watchMenus() {
        const manager = Main.panel.menuManager;
        this._menuToken = {};
        this._menuManager = manager;

        const hadAdd = Object.hasOwn(manager, 'addMenu');
        const hadRemove = Object.hasOwn(manager, 'removeMenu');
        const addMenu = manager.addMenu;
        const removeMenu = manager.removeMenu;
        this._restoreManager = () => {
            if (hadAdd)
                manager.addMenu = addMenu;
            else
                delete manager.addMenu;
            if (hadRemove)
                manager.removeMenu = removeMenu;
            else
                delete manager.removeMenu;
        };

        manager.addMenu = (menu, position) => {
            addMenu.call(manager, menu, position);
            this._watchMenu(menu);
        };
        manager.removeMenu = menu => {
            this._unwatchMenu(menu);
            removeMenu.call(manager, menu);
        };

        for (const menu of manager._menus)
            this._watchMenu(menu);
    }

    _unwatchMenus() {
        if (!this._menuManager)
            return;

        for (const menu of this._menuManager._menus)
            this._unwatchMenu(menu);
        this._restoreManager?.();
        this._restoreManager = null;
        this._menuManager = null;
        this._menuToken = null;
    }

    _watchMenu(menu) {
        if (!menu?.actor || !this._menuToken)
            return;

        // Connected after the manager's own handler, which closes the menu first.
        menu.actor.connectObject('captured-event',
            (actor, event) => this._onMenuEvent(actor, event), this._menuToken);
    }

    _unwatchMenu(menu) {
        if (menu?.actor && this._menuToken)
            menu.actor.disconnectObject(this._menuToken);
    }

    _onMenuEvent(menuActor, event) {
        const type = event.type();
        if (type !== Clutter.EventType.BUTTON_PRESS &&
            type !== Clutter.EventType.TOUCH_BEGIN)
            return Clutter.EVENT_PROPAGATE;
        const secondary = type === Clutter.EventType.BUTTON_PRESS &&
            event.get_button() === Clutter.BUTTON_SECONDARY;
        if (type === Clutter.EventType.BUTTON_PRESS && !secondary &&
            event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;

        const target = global.stage.get_event_actor(event);
        if (!this._grid || !target || menuActor.contains(target))
            return Clutter.EVENT_PROPAGATE;

        const cell = this._grid.cellFor(target);
        // The cell's own menu was just closed by this very press: leave it closed.
        if (!cell || cell.justClosed)
            return Clutter.EVENT_PROPAGATE;

        if (secondary)
            cell.showContext(event);
        else
            cell.activate(event);
        return Clutter.EVENT_PROPAGATE;
    }

    // Right click on a system icon: its page in the system settings, and ours.
    _showContext(cell) {
        if (!this._popups)
            return;

        const [desktopId, label] = SETTINGS_PAGES[cell.itemId.replace(/#\d+$/, '')] ??
            ['org.gnome.Settings.desktop', 'Settings'];
        this._popups.showContext(cell, [
            {label: _(label), activate: () => openDesktopApp(desktopId)},
            {label: _('Indicator Settings'), activate: () => this.openPreferences()},
        ]);
    }

    _activateSystem(cell) {
        const dedicated = this._dedicatedPopups().find(([indicator]) => indicator === cell.body);

        if (dedicated && this._popups.hasPopup(dedicated[1]))
            this._popups.toggle(dedicated[1]);
        else
            this._popups.toggleShared(cell);
    }

    // -- visibility -------------------------------------------------------

    _readMap(key) {
        try {
            return this._settings.get_value(key).recursiveUnpack();
        } catch {
            return {};
        }
    }

    // Ids that are not stable between sessions cannot carry a rule.
    _hasStableId(id) {
        return !id.startsWith('pending:') && !id.startsWith('legacy:');
    }

    // Applies the "visibility" rules to the panel icons and the popup tiles.
    _applyVisibility() {
        if (!this._grid)
            return;

        const rules = this._readMap('visibility');
        for (const cell of this._grid.cells) {
            const rule = this._hasStableId(cell.itemId) ? rules[`icon:${cell.itemId}`] : null;
            cell.setRule(rule ?? 'auto');
        }

        if (this._tiles) {
            for (const tile of collectTiles(this._qs, this._systemCells)) {
                if (this._tileIndex.has(tile.id))
                    continue;
                this._tileIndex.set(tile.id, tile);
                tile.actor.connectObject('destroy', () => {
                    this._tileIndex.delete(tile.id);
                }, this);
            }

            // Detached tiles are no longer found by walking the popup, so the
            // index (filled while they were still in place) is what is applied.
            for (const [id, tile] of this._tileIndex) {
                if (rules[id] === 'hide')
                    this._tiles.hide(tile.actor);
                else
                    this._tiles.show(tile.actor);
            }
        }

        this._scheduleCatalog();
    }

    // Remembers every icon and tile seen so far, for the settings window.
    _scheduleCatalog() {
        if (this._catalogSource || this._destroyed)
            return;

        const source = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
            this._sources.delete(source);
            this._catalogSource = 0;
            this._saveCatalog();
            return GLib.SOURCE_REMOVE;
        });
        this._catalogSource = source;
        this._sources.add(source);
    }

    _saveCatalog() {
        if (!this._settings || !this._grid)
            return;

        const known = this._readMap('known-items');
        let changed = false;
        const note = (key, label) => {
            if (!label || known[key])
                return;
            known[key] = label;
            changed = true;
        };

        for (const cell of this._grid.cells) {
            if (this._hasStableId(cell.itemId))
                note(`icon:${cell.itemId}`, cell.label);
        }
        for (const [id, tile] of this._tileIndex)
            note(id, tile.label);

        if (changed)
            this._settings.set_value('known-items', new GLib.Variant('a{ss}', known));
    }

    _syncBackgroundApps() {
        const wanted = this._settings.get_boolean('background-apps-button');
        if (wanted && !this._bgApps) {
            const button = new BackgroundAppsButton(this._qs);
            if (button.enable())
                this._bgApps = button;
            else
                button.destroy();
        } else if (!wanted && this._bgApps) {
            this._bgApps.destroy();
            this._bgApps = null;
        }
    }

    // -- taking over from the stock AppIndicator extension ----------------

    _disableForeignAppIndicator() {
        try {
            Main.extensionManager?.disableExtension(FOREIGN_APPINDICATOR);
        } catch (e) {
            console.warn(`[better-system-tray] could not disable ${FOREIGN_APPINDICATOR}: ${e}`);
        }

        try {
            const shell = new Gio.Settings({schema_id: 'org.gnome.shell'});
            const enabled = shell.get_strv('enabled-extensions')
                .filter(uuid => uuid !== FOREIGN_APPINDICATOR);
            shell.set_strv('enabled-extensions', enabled);
            const disabled = shell.get_strv('disabled-extensions');
            if (!disabled.includes(FOREIGN_APPINDICATOR))
                shell.set_strv('disabled-extensions', [...disabled, FOREIGN_APPINDICATOR]);
        } catch (e) {
            console.warn(`[better-system-tray] could not persist tray takeover: ${e}`);
        }
    }

    _hasBusName(name) {
        return new Promise(resolve => {
            Gio.DBus.session.call(
                'org.freedesktop.DBus',
                '/org/freedesktop/DBus',
                'org.freedesktop.DBus',
                'NameHasOwner',
                new GLib.Variant('(s)', [name]),
                null,
                Gio.DBusCallFlags.NONE,
                1000,
                null,
                (conn, res) => {
                    try {
                        const [has] = conn.call_finish(res).deep_unpack();
                        resolve(!!has);
                    } catch {
                        resolve(false);
                    }
                });
        });
    }

    async _waitForWatcherNameFree() {
        for (let i = 0; i < 30 && !this._destroyed; i++) {
            const owned = await this._hasBusName(StatusNotifierWatcher.WATCHER_BUS_NAME);
            if (!owned)
                return;
            await sleepMs(100);
        }
    }

    // -- tray -------------------------------------------------------------

    _startTray() {
        Logger.init(this);
        Interfaces.initialize(this);
        SettingsManager.initialize(this);
        Util.tryCleanupOldIndicators();
        IndicatorStatusIcon.setIconHost(this);

        this._watchDog = new Util.NameWatcher(StatusNotifierWatcher.WATCHER_BUS_NAME);
        this._watchDog.nameAcquired = false;
        this._statusNotifierWatcher = new StatusNotifierWatcher.StatusNotifierWatcher(
            this, this._watchDog);
        TrayIconsManager.TrayIconsManager.initialize();
        this._trayStarted = true;
    }

    _stopTray() {
        if (!this._trayStarted)
            return;
        this._trayStarted = false;

        IndicatorStatusIcon.setIconHost(null);
        const attempt = fn => {
            try {
                fn();
            } catch (e) {
                console.warn(`[better-system-tray] tray shutdown: ${e}`);
            }
        };

        attempt(() => TrayIconsManager.TrayIconsManager.destroy());
        if (this._statusNotifierWatcher) {
            attempt(() => this._statusNotifierWatcher.destroy());
            this._statusNotifierWatcher = null;
        }
        if (this._watchDog) {
            attempt(() => this._watchDog.destroy());
            this._watchDog = null;
        }
        attempt(() => SettingsManager.destroy());
        attempt(() => Interfaces.destroy());
        attempt(() => Logger.destroy());
    }

    _trayId(statusIcon) {
        const sni = statusIcon._indicator;
        const base = sni
            ? `tray:${sni.id || statusIcon.uniqueId}`
            : `legacy:${statusIcon.uniqueId}`;

        let id = base;
        let n = 1;
        while (this._grid.cellById(id))
            id = `${base}#${++n}`;
        return id;
    }

    // The SNI `Id` (the stable name of the app) arrives a moment after the icon
    // object exists, so the cell is renamed as soon as it is known.
    _resolveTrayId(statusIcon, cell) {
        const sni = statusIcon._indicator;
        if (!sni || sni.id) {
            cell.itemId = this._trayId(statusIcon);
            cell.label = this._trayLabel(statusIcon);
            this._applyVisibility();
            return;
        }

        cell.itemId = `pending:${statusIcon.uniqueId}`;
        let tries = 0;
        const source = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            if (!this._grid || !statusIcon._ssiCell) {
                this._sources.delete(source);
                return GLib.SOURCE_REMOVE;
            }
            if (!sni.id && ++tries < 40)
                return GLib.SOURCE_CONTINUE;

            cell.itemId = this._trayId(statusIcon);
            cell.label = this._trayLabel(statusIcon);
            this._grid.applyOrder(this._savedOrder());
            this._applyVisibility();
            this._sources.delete(source);
            return GLib.SOURCE_REMOVE;
        });
        this._sources.add(source);
    }

    _trayLabel(statusIcon) {
        const sni = statusIcon._indicator;
        if (!sni)
            return _('Legacy tray icon');
        return sni._appInfo?.get_display_name?.() || sni.title || sni.id || _('Tray icon');
    }

    // Called by the vendored tray code for every new icon.
    addIcon(statusIcon) {
        if (!statusIcon || !this._grid || statusIcon._ssiCell)
            return;

        const statusKey = `appindicator-${statusIcon.uniqueId}`;
        const current = Main.panel.statusArea[statusKey];
        if (current && current !== statusIcon)
            current.destroy();
        Main.panel.statusArea[statusKey] = statusIcon;

        if (statusIcon.menu)
            Main.panel._onMenuSet(statusIcon);

        const isSni = !!statusIcon._indicator;
        const container = statusIcon.container;
        container.get_parent()?.remove_child(container);

        // The cell owns hover, padding and clicks; the button inside is only a carrier.
        statusIcon.remove_style_class_name('panel-button');
        statusIcon.add_style_class_name('ssi-tray-button');
        statusIcon.set({x_expand: true, y_expand: true});
        container.set({x_expand: true, y_expand: true});

        const cell = new Cell('pending', 'tray', container, statusIcon, {
            label: this._trayLabel(statusIcon),
            forceTargets: () => [statusIcon, container],
            draggable: isSni,
            interceptPress: isSni,
            onActivate: (_cell, event) => {
                if (event)
                    statusIcon.vfunc_button_press_event(event);
                else
                    statusIcon.menu?.toggle();
            },
        });
        statusIcon._ssiCell = cell;
        this._resolveTrayId(statusIcon, cell);

        this._anchorTrayMenu(statusIcon, cell);
        statusIcon.connectObject('menu-set', () => this._anchorTrayMenu(statusIcon, cell), this);

        this._grid.addCell(cell);
        this._grid.applyOrder(this._savedOrder());
        this._applyVisibility();

        statusIcon.connectObject('destroy', () => {
            if (Main.panel.statusArea[statusKey] === statusIcon)
                delete Main.panel.statusArea[statusKey];
            statusIcon._ssiCell = null;
            if (this._grid)
                this._grid.removeCell(cell);
            cell.destroy();
        }, this);
    }

    // Tray menus point at whichever screen edge their icon is closest to.
    _anchorTrayMenu(statusIcon, cell) {
        const menu = statusIcon.menu;
        if (!menu?._boxPointer || menu._ssiAnchored)
            return;

        const open = menu.open.bind(menu);
        menu._ssiAnchored = true;
        menu.open = animate => {
            if (this._popups)
                this._popups.openMenu(menu, cell, animate, open);
            else
                open(animate);
        };
        menu.connectObject('open-state-changed', (_menu, isOpen) => cell.setOpen(isOpen), cell);
    }
}

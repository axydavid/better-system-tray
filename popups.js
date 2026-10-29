// Independent popups for Wi-Fi, Bluetooth, power (battery and power mode),
// the power mode icon and GSConnect.
//
// GNOME opens one shared Quick Settings menu for every indicator. Here each
// indicator gets a small menu of its own, anchored to its own icon. Menus are
// always filled *before* they are opened: PopupMenu.open() silently does
// nothing for an empty menu, which is why filling on 'open-state-changed'
// never worked.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {CpuTemperature} from './temperature.js';

const PROFILES = [
    ['performance', 'Performance', 'power-profile-performance-symbolic'],
    ['balanced', 'Balanced', 'power-profile-balanced-symbolic'],
    ['power-saver', 'Power Saver', 'power-profile-power-saver-symbolic'],
];

// UPower device states
const STATE_CHARGING = 1;
const STATE_DISCHARGING = 2;
const STATE_EMPTY = 3;
const STATE_FULL = 4;

/** The bar (panel/dock) an icon lives on; falls back to the icon itself. */
function barFor(actor) {
    return Main.panel?.contains(actor) ? Main.panel : actor;
}

/**
 * Which side of its popup the arrow sits on. A vertical dock opens popups
 * sideways, a horizontal one up or down, towards the middle of the screen.
 */
export function arrowSideFor(actor) {
    const bar = barFor(actor);
    const monitor = Main.layoutManager.findMonitorForActor(bar) ??
        Main.layoutManager.primaryMonitor;
    const [x, y] = bar.get_transformed_position();
    const [w, h] = bar.get_transformed_size();

    if (h > w)
        return x + w / 2 < monitor.x + monitor.width / 2 ? St.Side.LEFT : St.Side.RIGHT;
    return y + h / 2 < monitor.y + monitor.height / 2 ? St.Side.TOP : St.Side.BOTTOM;
}

/**
 * An invisible actor popups are positioned against. The icons are small and sit
 * inside the dock, so anchoring to one directly would put the popup on top of
 * its neighbours. The anchor spans the whole dock across the arrow axis and the
 * clicked icon along it: the popup lands beside the dock, level with the icon.
 */
class MenuAnchor {
    constructor() {
        this.actor = new St.Widget({name: 'ssi-menu-anchor', reactive: false, opacity: 0});
        Main.uiGroup.add_child(this.actor);
    }

    place(cell, side) {
        const bar = barFor(cell);
        const [barX, barY] = bar.get_transformed_position();
        const [barW, barH] = bar.get_transformed_size();
        const [x, y] = cell.get_transformed_position();
        const [w, h] = cell.get_transformed_size();

        const alongAxis = side === St.Side.LEFT || side === St.Side.RIGHT;
        this.actor.set_position(alongAxis ? barX : x, alongAxis ? y : barY);
        this.actor.set_size(alongAxis ? barW : w, alongAxis ? h : barH);
        return this.actor;
    }

    destroy() {
        this.actor.destroy();
    }
}

export function openDesktopApp(desktopId) {
    const app = Shell.AppSystem.get_default().lookup_app(desktopId);
    if (!app)
        return;
    Main.overview.hide();
    app.activate();
}

// Where the temperature leads: whichever system monitor is installed.
const SYSTEM_MONITORS = [
    'net.nokyan.Resources.desktop',
    'io.missioncenter.MissionCenter.desktop',
    'org.gnome.SystemMonitor.desktop',
    'gnome-system-monitor.desktop',
];

function findSystemMonitor() {
    const apps = Shell.AppSystem.get_default();
    return SYSTEM_MONITORS.find(id => apps.lookup_app(id)) ?? null;
}

function formatDuration(seconds) {
    const minutes = Math.round(seconds / 60);
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return `${h}:${String(m).padStart(2, '0')}`;
}

/**
 * A popup menu that fills and positions itself inside open(). The shell's menu
 * manager also calls open() directly (when the pointer slides from one panel
 * button to the next), so this cannot live in the click handler.
 */
class SplitMenu extends PopupMenu.PopupMenu {
    constructor(popup, cell) {
        super(cell, 0.5, arrowSideFor(cell));
        this._popup = popup;
    }

    open(animate) {
        if (this.isOpen)
            return;

        const {controller, cell} = this._popup;
        controller.closeShared();
        if (!this._popup.prepare())
            return;
        controller.openMenu(this, cell, animate, a => super.open(a));
    }
}

class Popup {
    constructor(controller, kind, cell, fill) {
        this.controller = controller;
        this.kind = kind;
        this.cell = cell;
        this._fill = fill;
        this._borrowed = [];
        this._cleanups = [];
        this._releaseSource = 0;

        this.menu = new SplitMenu(this, cell);
        this.menu.actor.add_style_class_name('panel-menu ssi-menu');
        this.menu.box.add_style_class_name('ssi-menu-box');
        Main.uiGroup.add_child(this.menu.actor);
        this.menu.actor.hide();
        Main.panel.menuManager.addMenu(this.menu);

        this.menu.connect('open-state-changed', (_menu, open) => this._onOpenState(open));
        // 'menu-closed' fires once the fade-out has finished. Borrowed menu
        // sections go home only then, so the list does not vanish mid-animation.
        this.menu.connect('menu-closed', () => this._queueRelease());
    }

    // With no animation 'menu-closed' is emitted from inside close(), before
    // the menu has flagged itself closed, so look again once that is done.
    _queueRelease() {
        if (this._releaseSource)
            return;
        this._releaseSource = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._releaseSource = 0;
            if (!this.menu.isOpen)
                this._release();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Rebuild the content. Returns false when there is nothing to show. */
    prepare() {
        this._release();
        this.menu.removeAll();
        this._fill(this);
        return !this.menu.isEmpty();
    }

    _onOpenState(open) {
        this.cell.setOpen(open);
    }

    onClose(callback) {
        this._cleanups.push(callback);
    }

    /** Calls `callback` every `seconds` for as long as this popup stays open. */
    every(seconds, callback) {
        let source = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            if (!this.menu.isOpen) {
                source = 0;
                return GLib.SOURCE_REMOVE;
            }
            callback();
            return GLib.SOURCE_CONTINUE;
        });
        this.onClose(() => {
            if (source)
                GLib.source_remove(source);
            source = 0;
        });
    }

    holds(actor) {
        return this._borrowed.some(entry => entry.actor === actor);
    }

    /**
     * Show an existing menu section (Quick Settings owns it) inside this menu.
     * It is handed back untouched when the menu closes.
     */
    borrow(section) {
        const actor = section?.actor;
        if (!actor)
            return;

        // Still fading out in another popup? Take it back from there first.
        this.controller.reclaim(actor, this);
        const home = actor.get_parent();
        if (!home)
            return;

        const entry = {
            section,
            actor,
            home,
            index: home.get_children().indexOf(actor),
            parent: section._parent,
        };
        home.remove_child(actor);
        this.menu.box.add_child(actor);
        // Items close the *top* menu when activated; make that this menu.
        section._setParent?.(this.menu);
        actor.connectObject('destroy', () => {
            this._borrowed = this._borrowed.filter(e => e !== entry);
        }, this);
        this._borrowed.push(entry);
    }

    _release() {
        for (const callback of this._cleanups.splice(0)) {
            try {
                callback();
            } catch (e) {
                console.warn(`[better-system-tray] popup cleanup failed: ${e}`);
            }
        }

        // Undo in reverse: each saved index is where the item sat after
        // earlier siblings had already been taken, so putting them back in
        // borrow order would reverse the owner's menu (GSConnect's settings
        // row flipped top/bottom on every open).
        for (const entry of this._borrowed.splice(0).reverse()) {
            entry.actor.disconnectObject(this);
            try {
                if (entry.actor.get_parent() === this.menu.box)
                    this.menu.box.remove_child(entry.actor);
                entry.home.insert_child_at_index(entry.actor, entry.index);
                entry.section._setParent?.(entry.parent);
            } catch (e) {
                console.warn(`[better-system-tray] could not return menu section: ${e}`);
            }
        }
    }

    destroy() {
        if (this._releaseSource)
            GLib.source_remove(this._releaseSource);
        this._releaseSource = 0;
        this._release();
        try {
            Main.panel.menuManager.removeMenu(this.menu);
        } catch {
        }
        this.menu.destroy();
    }
}

export class PopupController {
    constructor(qs) {
        this._qs = qs;
        this._popups = new Map();
        this._anchor = new MenuAnchor();
        this._sharedCell = null;
        this._sharedSignal = null;
        this._temperature = new CpuTemperature();
        this._context = null;
        this._contextSource = 0;
    }

    /**
     * Open `menu` pointing at `cell`. `opener` is the function that really opens
     * it (wrapped menus pass their original `open`).
     */
    openMenu(menu, cell, animate, opener = a => menu.open(a)) {
        const side = arrowSideFor(cell);
        menu._boxPointer.updateArrowSide(side);

        const original = menu.sourceActor;
        menu.sourceActor = this._anchor.place(cell, side);
        try {
            opener(animate);
        } finally {
            menu.sourceActor = original;
        }
    }

    /** Open (or close) the dedicated popup of `kind` ('network' | 'power' | 'performance'). */
    toggle(kind) {
        this._popups.get(kind)?.menu.toggle();
    }

    /**
     * Turn the dedicated popup of `kind` on or off for `cell`. Popups exist
     * from the start (not on first click) so the shell's menu manager can
     * also slide from one open popup to the next on hover.
     */
    setPopup(kind, cell, enabled) {
        const existing = this._popups.get(kind);
        if (existing && (!enabled || existing.cell !== cell)) {
            existing.destroy();
            this._popups.delete(kind);
        }
        if (!enabled || this._popups.has(kind))
            return;

        const fill = {
            network: p => this._fillNetwork(p),
            power: p => this._fillPower(p),
            performance: p => this._fillPerformance(p),
            gsconnect: p => this._fillToggleMenu(p),
            bluetooth: p => this._fillBluetooth(p),
        }[kind];
        this._popups.set(kind, new Popup(this, kind, cell, fill));
    }

    /** Drop the popups that belonged to an icon that went away. */
    forgetCell(cell) {
        for (const [kind, popup] of [...this._popups]) {
            if (popup.cell !== cell)
                continue;
            popup.destroy();
            this._popups.delete(kind);
        }
    }

    hasPopup(kind) {
        return this._popups.has(kind);
    }

    /**
     * A small right-click menu on an icon. `entries` is a list of
     * {label, activate}. It is thrown away once it has closed.
     */
    showContext(cell, entries) {
        this._dropContext();
        this.closeAll();

        const popup = new Popup(this, 'context', cell, p => {
            for (const {label, activate} of entries)
                p.menu.addAction(label, () => activate());
        });
        popup.menu.connect('menu-closed', () => this._queueDropContext(popup));
        this._context = popup;
        popup.menu.open(BoxPointer.PopupAnimation.FULL);
    }

    _queueDropContext(popup) {
        if (this._contextSource)
            return;
        this._contextSource = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._contextSource = 0;
            if (this._context === popup && !popup.menu.isOpen)
                this._dropContext();
            return GLib.SOURCE_REMOVE;
        });
    }

    _dropContext() {
        if (this._contextSource)
            GLib.source_remove(this._contextSource);
        this._contextSource = 0;
        this._context?.destroy();
        this._context = null;
    }

    /** Make another popup return `actor` (a borrowed section) to its owner. */
    reclaim(actor, except) {
        for (const popup of this._popups.values()) {
            if (popup !== except && popup.holds(actor))
                popup._release();
        }
    }

    /** The shared Quick Settings menu, pointing at the icon that was clicked. */
    toggleShared(cell) {
        const menu = this._qs.menu;
        if (menu.isOpen) {
            menu.close(BoxPointer.PopupAnimation.FULL);
            return;
        }

        for (const popup of this._popups.values())
            popup.menu.close(BoxPointer.PopupAnimation.NONE);

        this._clearShared();
        this._sharedCell = cell;
        cell.setOpen(true);
        this._sharedSignal = menu.connect('open-state-changed', (_m, open) => {
            if (!open)
                this._clearShared();
        });
        this.openMenu(menu, cell, BoxPointer.PopupAnimation.FULL);
    }

    closeShared() {
        if (this._qs.menu.isOpen)
            this._qs.menu.close(BoxPointer.PopupAnimation.NONE);
    }

    _clearShared() {
        if (this._sharedSignal) {
            this._qs.menu.disconnect(this._sharedSignal);
            this._sharedSignal = null;
        }
        this._sharedCell?.setOpen(false);
        this._sharedCell = null;
    }

    closeAll() {
        this._context?.menu.close(BoxPointer.PopupAnimation.NONE);
        for (const popup of this._popups.values())
            popup.menu.close(BoxPointer.PopupAnimation.NONE);
        if (this._sharedCell)
            this._qs.menu.close(BoxPointer.PopupAnimation.NONE);
    }

    destroy() {
        this.closeAll();
        this._dropContext();
        this._clearShared();
        for (const popup of this._popups.values())
            popup.destroy();
        this._popups.clear();
        this._anchor.destroy();
    }

    // -- Wi-Fi ------------------------------------------------------------

    _fillNetwork(popup) {
        const {menu} = popup;
        const network = this._qs._network;
        const wifi = network?._wirelessToggle;
        const client = wifi?._client ?? network?._client;

        if (client) {
            const wifiSwitch = new PopupMenu.PopupSwitchMenuItem(
                _('Wi-Fi'), client.wireless_enabled);
            wifiSwitch.connect('toggled', (_item, state) => {
                client.wireless_enabled = state;
            });
            wifiSwitch.label.add_style_class_name('ssi-title');
            menu.addMenuItem(wifiSwitch);

            const syncId = client.connect('notify::wireless-enabled',
                () => wifiSwitch.setToggleState(client.wireless_enabled));
            popup.onClose(() => client.disconnect(syncId));
        }

        if (wifi?._itemsSection) {
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            popup.borrow(wifi._itemsSection);
            wifi._startScanning?.();
            popup.onClose(() => wifi._stopScanning?.());
        }

        const extras = [
            [network?._wiredToggle, _('Wired')],
            [network?._vpnToggle, _('VPN')],
        ];
        for (const [toggle, label] of extras) {
            if (!toggle?.visible || !toggle._itemsSection || toggle._itemsSection.isEmpty())
                continue;
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(label));
            popup.borrow(toggle._itemsSection);
        }

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addSettingsAction(_('All Networks'), 'gnome-wifi-panel.desktop');
    }

    // -- Power ------------------------------------------------------------

    _batteryDetails(powerToggle) {
        const proxy = powerToggle?._proxy;
        if (!proxy)
            return null;

        const state = proxy.State;
        if (state === STATE_CHARGING) {
            const seconds = proxy.TimeToFull;
            return seconds > 0
                ? _('Charging, %s until full').format(formatDuration(seconds))
                : _('Charging');
        }
        if (state === STATE_DISCHARGING) {
            const seconds = proxy.TimeToEmpty;
            return seconds > 0
                ? _('%s remaining').format(formatDuration(seconds))
                : _('On battery');
        }
        if (state === STATE_FULL)
            return _('Fully charged');
        if (state === STATE_EMPTY)
            return _('Empty');
        return null;
    }

    // One row, two buttons: the battery (opens the power settings) and the
    // processor temperature at the far end (opens the system monitor). The
    // temperature is read when the popup is filled, just before it opens, then
    // once a second while it is open, and turns red while the CPU is really
    // being throttled (what the hardware and the kernel report; not what
    // power-profiles-daemon says, which is only "turbo boost is off").
    _addStatusRow(popup, powerToggle) {
        const {menu} = popup;
        const hasBattery = !!powerToggle?.visible;
        const hasTemperature = this._temperature.read() !== null;
        if (!hasBattery && !hasTemperature)
            return false;

        // Not an item of its own (the buttons inside are): it neither
        // highlights nor activates, but stays "sensitive" so the text keeps its colour.
        const row = new PopupMenu.PopupBaseMenuItem({
            style_class: 'popup-menu-item ssi-status-row',
            activate: false,
            hover: false,
            can_focus: false,
        });
        row.track_hover = false;

        const button = (child, onClick, params = {}) => {
            const widget = new St.Button({
                style_class: 'ssi-row-button',
                can_focus: true,
                y_align: Clutter.ActorAlign.CENTER,
                child,
                ...params,
            });
            widget.connect('clicked', () => {
                menu.close(BoxPointer.PopupAnimation.FULL);
                onClick();
            });
            return widget;
        };

        if (hasBattery) {
            const content = new St.BoxLayout({style_class: 'ssi-row-content'});
            const icon = new St.Icon({style_class: 'popup-menu-icon', y_align: Clutter.ActorAlign.CENTER});
            if (powerToggle.gicon)
                icon.gicon = powerToggle.gicon;
            else
                icon.icon_name = 'battery-symbolic';
            content.add_child(icon);
            content.add_child(new St.Label({
                text: powerToggle.title || _('Battery'),
                style_class: 'ssi-title',
                y_align: Clutter.ActorAlign.CENTER,
            }));

            const details = this._batteryDetails(powerToggle);
            if (details) {
                content.add_child(new St.Label({
                    text: details,
                    style_class: 'dim-label',
                    y_align: Clutter.ActorAlign.CENTER,
                }));
            }
            row.add_child(button(content, () => openDesktopApp('gnome-power-panel.desktop')));
        }

        if (hasTemperature) {
            const label = new St.Label({
                style_class: 'ssi-title ssi-temperature',
                y_align: Clutter.ActorAlign.CENTER,
            });
            const monitor = findSystemMonitor();
            const update = () => {
                const celsius = this._temperature.read();
                label.text = celsius === null ? '' : CpuTemperature.format(celsius);
                if (this._temperature.throttling(celsius))
                    label.add_style_class_name('ssi-hot');
                else
                    label.remove_style_class_name('ssi-hot');
            };
            update();

            row.add_child(button(label, () => monitor && openDesktopApp(monitor), {
                x_expand: true,
                x_align: Clutter.ActorAlign.END,
                reactive: !!monitor,
            }));
            popup.every(1, update);
        }

        menu.addMenuItem(row);
        return true;
    }

    // Battery and temperature first, then the power mode. Suspend, restart and
    // the rest stay in the full popup (lock and power off buttons).
    _fillPower(popup) {
        const {menu} = popup;
        const powerToggle = this._qs._system?._systemItem?.powerToggle;

        if (this._addStatusRow(popup, powerToggle))
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        if (this._addPowerModes(menu))
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addSettingsAction(_('Power Settings'), 'gnome-power-panel.desktop');
    }

    // -- Indicators built on a Quick Settings toggle menu (GSConnect) --------

    /**
     * GSConnect (and similar toggles): switch, the device list, settings last.
     * Their own settings row stays in their menu; we add ours so it cannot
     * wander when items are borrowed and handed back.
     */
    _fillToggleMenu(popup) {
        const {menu} = popup;
        const toggle = popup.cell.body?.quickSettingsItems?.[0];
        if (!toggle?.menu)
            return;

        const power = new PopupMenu.PopupSwitchMenuItem(
            toggle.title || popup.cell.label, !!toggle.checked);
        power.label.add_style_class_name('ssi-title');
        power.connect('toggled', (_item, state) => {
            toggle.checked = state;
        });
        menu.addMenuItem(power);

        toggle.connectObject('notify::checked',
            () => power.setToggleState(!!toggle.checked), popup);
        popup.onClose(() => toggle.disconnectObject(popup));

        const devices = toggle.deviceSection;
        if (devices)
            popup.borrow(devices);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addSettingsAction(_('Mobile Settings'),
            'org.gnome.Shell.Extensions.GSConnect.Preferences.desktop');
    }

    // -- Bluetooth --------------------------------------------------------

    // Switch, the device list in the middle (the shell's own list, borrowed),
    // settings last. The shell's placeholder is a long sentence that made the
    // popup wider than the rest, so a short one replaces it.
    _fillBluetooth(popup) {
        const {menu} = popup;
        const toggle = popup.cell.body?.quickSettingsItems?.[0];
        if (!toggle?.menu || !toggle.visible)
            return;

        // The shell sorts connected devices first, but only when its own menu opens.
        toggle._reorderDeviceItems?.();

        const power = new PopupMenu.PopupSwitchMenuItem(_('Bluetooth'), !!toggle.checked);
        power.label.add_style_class_name('ssi-title');
        power.connect('toggled', (_item, state) => {
            // The toggle follows the adapter; a click is what switches it.
            if (state !== !!toggle.checked)
                toggle.emit('clicked', 0);
        });
        menu.addMenuItem(power);

        toggle.connectObject('notify::checked',
            () => power.setToggleState(!!toggle.checked), popup);
        popup.onClose(() => toggle.disconnectObject(popup));

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const devices = toggle._deviceSection;
        if (devices)
            popup.borrow(devices);

        const placeholder = new PopupMenu.PopupMenuItem(
            toggle._client?.active ? _('No available devices') : _('Bluetooth is off'), {
                reactive: false,
                can_focus: false,
            });
        placeholder.label.add_style_class_name('dim-label');
        menu.addMenuItem(placeholder);
        if (devices) {
            // Only while the list has nothing to show (known but disconnected
            // devices are listed, so they count as something).
            const binding = devices.actor.bind_property('visible', placeholder, 'visible',
                GObject.BindingFlags.SYNC_CREATE | GObject.BindingFlags.INVERT_BOOLEAN);
            popup.onClose(() => binding.unbind());
        }

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addSettingsAction(_('Bluetooth Settings'), 'gnome-bluetooth-panel.desktop');
    }

    // -- Performance ------------------------------------------------------

    _fillPerformance(popup) {
        const {menu} = popup;
        if (!this._addPowerModes(menu, {title: true}))
            return;
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addSettingsAction(_('Power Settings'), 'gnome-power-panel.desktop');
    }

    /**
     * The power mode choices (Performance, Balanced, Power Saver). False when
     * there are none. As the first row of a popup the heading is its title.
     */
    _addPowerModes(menu, {title = false} = {}) {
        const toggle = this._qs._powerProfiles?._powerProfilesToggle;
        const proxy = toggle?._proxy;
        if (!proxy)
            return false;

        const available = new Set(
            (proxy.Profiles ?? []).map(entry => entry.Profile?.unpack?.() ?? entry.Profile));
        const active = proxy.ActiveProfile;

        // Not reactive would dim it (:insensitive); it just must not respond.
        const heading = new PopupMenu.PopupMenuItem(_('Power Mode'), {
            activate: false,
            hover: false,
            can_focus: false,
        });
        heading.label.add_style_class_name(title ? 'ssi-title' : 'ssi-heading');
        menu.addMenuItem(heading);

        for (const [profile, name, icon] of PROFILES) {
            if (available.size && !available.has(profile))
                continue;
            const item = new PopupMenu.PopupImageMenuItem(_(name), icon);
            item.setOrnament(profile === active
                ? PopupMenu.Ornament.CHECK
                : PopupMenu.Ornament.NONE);
            item.connect('activate', () => {
                proxy.ActiveProfile = profile;
            });
            menu.addMenuItem(item);
        }

        return true;
    }
}

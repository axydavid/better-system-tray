// Background apps as a small round button in the header row of the full Quick
// Settings popup, next to the screenshot button.
//
// GNOME shows "N Background Apps" as a full-width tile at the very bottom of the
// popup and drops its list below it. Here the tile is hidden, a round button
// with a count badge takes its place, and the list opens from the top of the
// popup, right under the button row.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const ANIMATION_MS = 220;

// The popup grid is as wide as its widest child, shown or not. The list panel
// has long lines in it, so it must not take part: it simply fills whatever
// width the grid has, and its labels cut themselves short.
const ListPanel = GObject.registerClass(
class SSIBackgroundList extends St.BoxLayout {
    vfunc_get_preferred_width(_forHeight) {
        return [0, 0];
    }
});

export class BackgroundAppsButton {
    constructor(qs) {
        this._qs = qs;
        this._toggle = null;
        this._borrowed = [];
        this._expanded = false;
        this._syncSource = 0;
    }

    /** Returns false when this shell has no background apps tile to relocate. */
    enable() {
        const qs = this._qs;
        const toggle = qs._backgroundApps?.quickSettingsItems?.[0];
        const row = qs._system?._systemItem?.child;
        const grid = qs.menu?._grid;
        if (!toggle?._appsSection || !row || !grid)
            return false;

        this._toggle = toggle;
        this._row = row;

        this._buildButton();
        this._buildPanel(toggle);

        // The stock tile stays in the popup (its logic keeps running) but never shows.
        toggle.visible = false;
        toggle.connectObject('notify::visible', () => {
            if (toggle.visible)
                toggle.visible = false;
        }, this);

        toggle.connectObject('notify::title', () => this._queueSync(), this);
        toggle._appsSection.box?.connectObject(
            'child-added', () => this._queueSync(),
            'child-removed', () => this._queueSync(),
            this);

        qs.menu.connectObject('open-state-changed', (_menu, open) => {
            if (!open)
                this._collapse(false);
        }, this);

        this._sync();
        return true;
    }

    // -- widgets ----------------------------------------------------------

    _buildButton() {
        this._button = new St.Button({
            style_class: 'icon-button ssi-bg-button',
            can_focus: true,
            icon_name: 'background-app-ghost-symbolic',
            accessible_name: _('Background Apps'),
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._button.connect('clicked', () => this._toggleExpanded());

        this._badge = new St.Label({
            style_class: 'ssi-bg-badge',
            reactive: false,
            // BinLayout only aligns children that expand.
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
        });

        this._wrap = new St.Widget({
            style_class: 'ssi-bg-wrap',
            layout_manager: new Clutter.BinLayout(),
            visible: false,
        });
        this._wrap.add_child(this._button);
        this._wrap.add_child(this._badge);

        // Right before the screenshot button.
        const children = this._row.get_children();
        const screenshot = children.find(child => child.icon_name === 'screenshooter-symbolic');
        if (screenshot)
            this._row.insert_child_below(this._wrap, screenshot);
        else
            this._row.insert_child_at_index(this._wrap, Math.min(2, children.length));
    }

    _buildPanel(toggle) {
        this._panel = new ListPanel({
            style_class: 'ssi-bg-panel',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            clip_to_allocation: true,
            visible: false,
        });

        const header = new St.BoxLayout({style_class: 'ssi-bg-header'});
        header.add_child(new St.Icon({
            style_class: 'ssi-bg-header-icon',
            icon_name: 'background-app-ghost-symbolic',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        header.add_child(new St.Label({
            style_class: 'ssi-bg-header-title',
            text: _('Background Apps'),
            y_align: Clutter.ActorAlign.CENTER,
            y_expand: true,
        }));
        this._panel.add_child(header);

        // The stock list (and its explanation line) moves in; it keeps updating itself.
        for (const item of [toggle._listTitle, toggle._appsSection]) {
            const actor = item?.actor;
            const home = actor?.get_parent();
            if (!actor || !home)
                continue;
            this._borrowed.push({
                actor,
                home,
                next: actor.get_next_sibling(),
            });
            home.remove_child(actor);
            this._panel.add_child(actor);
        }

        const settings = new St.Button({
            style_class: 'ssi-bg-settings button',
            label: _('App Settings'),
            can_focus: true,
            x_align: Clutter.ActorAlign.END,
        });
        settings.connect('clicked', () => {
            this._qs.menu.close(0);
            const app = Gio.DesktopAppInfo.new('gnome-applications-panel.desktop');
            try {
                app?.launch([], global.create_app_launch_context(0, -1));
            } catch (e) {
                console.warn(`[better-system-tray] could not open app settings: ${e}`);
            }
        });
        this._panel.add_child(settings);

        // Straight under the header row (the system item is the first row).
        const menu = this._qs.menu;
        const systemItem = this._qs._system._systemItem;
        const next = systemItem.get_next_sibling();
        if (next)
            menu.insertItemBefore(this._panel, next, 2);
        else
            menu.addItem(this._panel, 2);
    }

    // -- state ------------------------------------------------------------

    _queueSync() {
        if (this._syncSource)
            return;
        this._syncSource = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._syncSource = 0;
            this._sync();
            return GLib.SOURCE_REMOVE;
        });
    }

    _count() {
        return this._toggle?._appsSection?._getMenuItems?.().length ?? 0;
    }

    _sync() {
        if (!this._toggle)
            return;

        const count = this._count();
        this._wrap.visible = count > 0 && !Main.sessionMode.isLocked;
        this._badge.text = count > 9 ? '9+' : `${count}`;
        this._button.accessible_name = this._toggle.title ?? _('Background Apps');

        if (count === 0)
            this._collapse(true);
    }

    _toggleExpanded() {
        if (this._expanded)
            this._collapse(true);
        else
            this._expand();
    }

    _expand() {
        if (this._expanded)
            return;
        this._expanded = true;
        this._button.add_style_pseudo_class('checked');

        const panel = this._panel;
        panel.remove_all_transitions();
        panel.height = -1;
        panel.show();
        const width = this._qs.menu._grid?.get_width() ?? 0;
        const [, natural] = panel.get_preferred_height(width > 0 ? width : -1);

        panel.set({height: 0, opacity: 0});
        panel.ease({
            height: natural,
            opacity: 255,
            duration: ANIMATION_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                panel.height = -1;
            },
        });
    }

    _collapse(animate) {
        const panel = this._panel;
        if (!panel || !this._expanded)
            return;
        this._expanded = false;
        this._button?.remove_style_pseudo_class('checked');

        panel.remove_all_transitions();
        if (!animate || !panel.mapped) {
            panel.hide();
            panel.height = -1;
            panel.opacity = 255;
            return;
        }

        panel.ease({
            height: 0,
            opacity: 0,
            duration: ANIMATION_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                panel.hide();
                panel.height = -1;
                panel.opacity = 255;
            },
        });
    }

    // -- teardown ---------------------------------------------------------

    destroy() {
        if (this._syncSource)
            GLib.source_remove(this._syncSource);
        this._syncSource = 0;

        const toggle = this._toggle;
        this._toggle = null;

        toggle?.disconnectObject(this);
        toggle?._appsSection?.box?.disconnectObject(this);
        this._qs.menu?.disconnectObject(this);

        // Hand the stock list back, in its old place.
        for (const {actor, home, next} of this._borrowed.splice(0)) {
            try {
                actor.get_parent()?.remove_child(actor);
                if (next && next.get_parent() === home)
                    home.insert_child_below(actor, next);
                else
                    home.add_child(actor);
            } catch (e) {
                console.warn(`[better-system-tray] could not return the background apps list: ${e}`);
            }
        }

        this._panel?.remove_all_transitions();
        this._panel?.destroy();
        this._wrap?.destroy();
        this._panel = null;
        this._wrap = null;
        this._button = null;
        this._badge = null;

        try {
            toggle?._syncVisibility?.();
        } catch (e) {
            console.warn(`[better-system-tray] could not restore the background apps tile: ${e}`);
        }
    }
}

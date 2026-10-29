import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const RULES = ['auto', 'show', 'hide'];

export default class SplitSystemIndicatorsPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.default_width = 660;
        window.default_height = 700;

        window.add(this._layoutPage(settings));
        window.add(this._iconsPage(settings));
        window.add(this._popupsPage(settings));
        window.add(this._tilesPage(settings));
        window.add(this._trayPage(settings));
    }

    // -- pages ------------------------------------------------------------

    _layoutPage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('Layout'),
            name: 'layout',
            icon_name: 'view-grid-symbolic',
        });

        const grid = new Adw.PreferencesGroup({
            title: _('Icon grid'),
            description: _('System icons come first, app tray icons after them. Drag any icon in the panel to rearrange.'),
        });
        grid.add(this._spin(settings, 'columns', _('Icons per row'),
            _('2 gives the two-column stack'), 1, 4));
        grid.add(this._spin(settings, 'icon-padding', _('Icon padding'),
            _('Space around each icon inside its hover highlight, in pixels'), 0, 12));
        grid.add(this._spin(settings, 'icon-spacing', _('Icon spacing'),
            _('Gap between neighbouring icons, in pixels'), 0, 12));
        grid.add(this._toggle(settings, 'fill-from-bottom', _('Stack from the bottom'),
            _('The first icon sits at the bottom and rows grow upwards')));
        page.add(grid);

        const order = new Adw.PreferencesGroup({title: _('Order')});
        order.add(this._resetRow(
            _('Icon order'),
            _('Back to the default: system icons, then tray icons'),
            () => settings.set_strv('icon-order', [])));
        page.add(order);

        return page;
    }

    _iconsPage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('Icons'),
            name: 'icons',
            icon_name: 'view-reveal-symbolic',
        });

        const help = new Adw.PreferencesGroup({
            description: _('Automatic follows GNOME: an icon only shows while it has something to say (Bluetooth with a device, Night Light while it is on). “Always show” keeps it on screen, “Hide” takes it out of the dock.'),
        });
        help.add(this._resetRow(
            _('Icon visibility'),
            _('Back to the defaults'),
            () => this._resetRules(settings, 'icon:')));
        page.add(help);

        const system = new Adw.PreferencesGroup({title: _('System icons')});
        const tray = new Adw.PreferencesGroup({title: _('App tray icons')});
        page.add(system);
        page.add(tray);

        this._keepListed(settings, [
            {group: system, prefix: 'icon:sys:', build: (key, label) => this._iconRow(settings, key, label)},
            {group: tray, prefix: 'icon:tray:', build: (key, label) => this._iconRow(settings, key, label)},
        ], _('Nothing here yet'),
        _('Icons are listed once the extension has run. Log out and back in after updating it.'));

        return page;
    }

    _popupsPage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('Popups'),
            name: 'popups',
            icon_name: 'view-more-horizontal-symbolic',
        });

        const popups = new Adw.PreferencesGroup({
            title: _('Separate popups'),
            description: _('Otherwise that icon opens the shared Quick Settings menu.'),
        });
        popups.add(this._toggle(settings, 'split-wifi', _('Wi-Fi opens its own popup'),
            _('Wi-Fi switch and network list, not the full system menu')));
        popups.add(this._toggle(settings, 'split-bluetooth', _('Bluetooth opens its own popup'),
            _('Bluetooth switch and devices')));
        popups.add(this._toggle(settings, 'split-power', _('Battery opens its own popup'),
            _('Battery status and the power mode (Performance, Balanced, Power Saver)')));
        popups.add(this._toggle(settings, 'split-performance', _('Power mode icon opens its own popup'),
            _('Only matters when the power mode icon is shown (Icons tab)')));
        popups.add(this._toggle(settings, 'split-gsconnect', _('GSConnect opens its own popup'),
            _('Connected devices and their actions')));
        page.add(popups);

        const full = new Adw.PreferencesGroup({
            title: _('Full popup'),
            description: _('The shared Quick Settings menu (volume, brightness, toggles).'),
        });
        full.add(this._toggle(settings, 'background-apps-button', _('Background apps as a round button'),
            _('A small button with a count next to the screenshot button; its list opens at the top of the popup')));
        page.add(full);

        return page;
    }

    _tilesPage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('Quick Settings'),
            name: 'tiles',
            icon_name: 'preferences-system-symbolic',
        });

        const help = new Adw.PreferencesGroup({
            description: _('Choose which tiles and buttons the full Quick Settings popup shows. A hidden tile keeps working, it is just not displayed.'),
        });
        help.add(this._resetRow(
            _('Popup tiles'),
            _('Show everything again'),
            () => this._resetRules(settings, 'tile:')));
        page.add(help);

        const tiles = new Adw.PreferencesGroup({title: _('Tiles')});
        const buttons = new Adw.PreferencesGroup({title: _('Header buttons')});
        page.add(tiles);
        page.add(buttons);

        this._keepListed(settings, [
            {
                group: buttons,
                prefix: 'tile:system.',
                build: (key, label) => this._tileRow(settings, key, label),
            },
            {
                group: tiles,
                prefix: 'tile:',
                exclude: 'tile:system.',
                build: (key, label) => this._tileRow(settings, key, label),
            },
        ], _('Nothing here yet'),
        _('Tiles are listed once the extension has run. Log out and back in after updating it.'));

        return page;
    }

    _trayPage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('Tray'),
            name: 'tray',
            icon_name: 'application-x-addon-symbolic',
        });

        const tray = new Adw.PreferencesGroup({
            title: _('App tray'),
            description: _('Icons of apps such as Discord, Steam or VPN clients.'),
        });
        tray.add(this._toggle(settings, 'legacy-tray-enabled', _('Legacy X11 tray icons'),
            _('Wine, older Steam, and other XEmbed icons')));
        tray.add(this._spin(settings, 'icon-size', _('Tray icon size'),
            _('0 follows the panel size'), 0, 48));
        tray.add(this._spin(settings, 'icon-opacity', _('Tray icon opacity'),
            _('255 is fully opaque'), 80, 255));
        page.add(tray);

        return page;
    }

    // -- the lists that follow what the extension has seen ---------------------

    /**
     * Fills each group with a row per known item (`known-items`, kept by the
     * extension) and refreshes them when the list grows.
     */
    _keepListed(settings, lists, emptyTitle, emptySubtitle) {
        const rows = [];
        let empty = null;

        const rebuild = () => {
            for (const {group, row} of rows.splice(0))
                group.remove(row);
            if (empty) {
                empty.group.remove(empty.row);
                empty = null;
            }

            const known = this._readMap(settings, 'known-items');
            let found = 0;

            for (const list of lists) {
                const keys = Object.keys(known)
                    .filter(key => key.startsWith(list.prefix) &&
                        !(list.exclude && key.startsWith(list.exclude)))
                    .sort((a, b) => known[a].localeCompare(known[b]));

                for (const key of keys) {
                    const row = list.build(key, known[key]);
                    list.group.add(row);
                    rows.push({group: list.group, row});
                    found++;
                }
            }

            if (found === 0) {
                const row = new Adw.ActionRow({title: emptyTitle, subtitle: emptySubtitle});
                lists[0].group.add(row);
                empty = {group: lists[0].group, row};
            }
        };

        rebuild();
        settings.connect('changed::known-items', rebuild);
    }

    _iconRow(settings, key, label) {
        const row = new Adw.ComboRow({
            title: label,
            model: Gtk.StringList.new([_('Automatic'), _('Always show'), _('Hide')]),
        });

        const current = this._readMap(settings, 'visibility')[key] ?? 'auto';
        row.selected = Math.max(0, RULES.indexOf(current));
        row.connect('notify::selected', () => {
            this._setRule(settings, key, RULES[row.selected] ?? 'auto');
        });
        return row;
    }

    _tileRow(settings, key, label) {
        const row = new Adw.SwitchRow({title: label});
        row.active = this._readMap(settings, 'visibility')[key] !== 'hide';
        row.connect('notify::active', () => {
            this._setRule(settings, key, row.active ? null : 'hide');
        });
        return row;
    }

    // -- settings helpers -------------------------------------------------------

    _readMap(settings, key) {
        try {
            return settings.get_value(key).recursiveUnpack();
        } catch {
            return {};
        }
    }

    _setRule(settings, key, value) {
        const rules = this._readMap(settings, 'visibility');
        if (value === null)
            delete rules[key];
        else
            rules[key] = value;
        settings.set_value('visibility', new GLib.Variant('a{ss}', rules));
    }

    // Drops every rule of one kind; icons fall back to the schema default.
    _resetRules(settings, prefix) {
        const defaults = settings.get_default_value('visibility').recursiveUnpack();
        const rules = this._readMap(settings, 'visibility');
        for (const key of Object.keys(rules)) {
            if (key.startsWith(prefix))
                delete rules[key];
        }
        for (const [key, value] of Object.entries(defaults)) {
            if (key.startsWith(prefix))
                rules[key] = value;
        }
        settings.set_value('visibility', new GLib.Variant('a{ss}', rules));
    }

    // -- widgets ---------------------------------------------------------------

    _resetRow(title, subtitle, onReset) {
        const row = new Adw.ActionRow({title, subtitle});
        const button = new Gtk.Button({
            label: _('Reset'),
            valign: Gtk.Align.CENTER,
        });
        button.connect('clicked', onReset);
        row.add_suffix(button);
        row.activatable_widget = button;
        return row;
    }

    _toggle(settings, key, title, subtitle) {
        const row = new Adw.SwitchRow({title, subtitle});
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    _spin(settings, key, title, subtitle, lower, upper) {
        const row = new Adw.SpinRow({
            title,
            subtitle,
            adjustment: new Gtk.Adjustment({
                lower,
                upper,
                step_increment: 1,
                page_increment: upper > 100 ? 16 : 1,
            }),
        });
        settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }
}

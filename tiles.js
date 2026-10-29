// Show or hide the tiles and buttons of the full Quick Settings popup.
//
// A hidden tile is taken out of its container instead of being made invisible.
// The shell keeps changing the `visible` property of its own tiles (Bluetooth
// appears with an adapter, rotation with a tablet), so overriding it would end
// up fighting the shell. A detached tile keeps working and keeps its own
// visibility logic; it just is not laid out. Handing it back puts it where it
// was.

import GObject from 'gi://GObject';

/** Detaches actors from their parents and hands them back later. */
export class TileHider {
    constructor() {
        this._hidden = new Map();
    }

    isHidden(actor) {
        return this._hidden.has(actor);
    }

    hide(actor) {
        const parent = actor.get_parent();
        if (!parent || this._hidden.has(actor))
            return;

        let span = null;
        try {
            span = parent.layout_manager?.get_child_meta?.(parent, actor)?.columnSpan ?? null;
        } catch {
            span = null;
        }

        this._hidden.set(actor, {parent, next: actor.get_next_sibling(), span});
        parent.remove_child(actor);
        actor.connectObject('destroy', () => this._hidden.delete(actor), this);
    }

    show(actor) {
        const entry = this._hidden.get(actor);
        if (!entry)
            return;

        this._hidden.delete(actor);
        actor.disconnectObject(this);

        const {parent, span} = entry;
        // Land in front of whatever followed the tile, skipping neighbours that
        // are hidden as well (their own successor is the next best anchor).
        let anchor = entry.next;
        while (anchor && anchor.get_parent() !== parent)
            anchor = this._hidden.get(anchor)?.next ?? null;

        try {
            if (anchor)
                parent.insert_child_below(actor, anchor);
            else
                parent.add_child(actor);

            if (span)
                parent.layout_manager.child_set_property(parent, actor, 'column-span', span);
        } catch (e) {
            console.warn(`[better-system-tray] could not restore a tile: ${e}`);
        }
    }

    restoreAll() {
        // Last hidden first, so the "next sibling" anchors resolve.
        for (const actor of [...this._hidden.keys()].reverse())
            this.show(actor);
    }

    destroy() {
        this.restoreAll();
        this._hidden.clear();
    }
}

// Indicators with several tiles (network) are told apart by their class.
const TILE_LABELS = {
    NMWiredToggle: 'Wired network',
    NMWirelessToggle: 'Wi-Fi',
    NMModemToggle: 'Mobile network',
    NMBluetoothToggle: 'Bluetooth tethering',
    NMVpnToggle: 'VPN',
};

const SYSTEM_BUTTONS = {
    PowerToggle: ['battery', 'Battery'],
    ScreenshotItem: ['screenshot', 'Screenshot'],
    SettingsItem: ['settings', 'Settings'],
    LockItem: ['lock', 'Lock Screen'],
    ShutdownItem: ['shutdown', 'Power Off menu'],
};

function nameOf(actor) {
    const type = GObject.type_name_from_instance(actor) ?? actor.constructor?.name ?? '';
    return type.replace(/^Gjs_/, '');
}

/**
 * Every tile and button of the full popup, as {id, label, actor}.
 * Ids are stable across restarts: `tile:<indicator>` plus a number for
 * indicators that bring more than one tile.
 */
export function collectTiles(qs, cells) {
    const tiles = [];

    for (const cell of cells) {
        const indicator = cell.body;
        const items = indicator.quickSettingsItems ?? [];
        const base = cell.itemId.replace(/^sys:/, '');

        if (indicator === qs._system) {
            const row = items[0]?.child;
            for (const actor of row?.get_children() ?? []) {
                const match = SYSTEM_BUTTONS[nameOf(actor)] ??
                    SYSTEM_BUTTONS[actor.constructor?.name];
                if (!match)
                    continue;
                // The battery pill's title is the charge ("80%"), not a name.
                const label = match[0] === 'battery' ? match[1] : actor.accessible_name || match[1];
                tiles.push({id: `tile:system.${match[0]}`, label, actor});
            }
            continue;
        }

        items.forEach((actor, index) => {
            // The background apps tile has its own round button on top.
            if (actor === qs._backgroundApps?.quickSettingsItems?.[0])
                return;
            const id = index === 0 ? `tile:${base}` : `tile:${base}#${index + 1}`;
            const type = nameOf(actor);
            const known = Object.keys(TILE_LABELS).find(name => type.endsWith(name));
            const label = known ? TILE_LABELS[known] :
                base === 'volumeInput' ? 'Microphone' :
                items.length === 1 ? cell.label : actor.title || cell.label;
            tiles.push({id, label, actor});
        });
    }

    return tiles;
}

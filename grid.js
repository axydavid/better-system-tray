// A bottom-up icon grid with per-icon hover cells and drag-and-drop reordering.
//
// The grid is a plain St.Widget with its own layout. It deliberately hides its
// children from `get_children()`: Dash to Panel walks the actor tree below every
// panel button and rewrites padding/orientation/size, which is what mangled the
// layout before. Shell internals (Clutter, St) never call the JS-level override.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const MIN_ICON = 16;
const REFLOW_MS = 140;
const DRAG_SLACK = 36;

function isCloseEnough(a, b) {
    return Math.abs(a - b) < 0.5;
}

/**
 * One interactive slot of the grid: a system indicator or a tray icon.
 *
 * `body` is the actor that is shown, `tracked` is the actor whose
 * visibility decides whether the slot takes up room.
 */
export const Cell = GObject.registerClass(
class SSICell extends St.Widget {
    _init(id, kind, content, tracked, options = {}) {
        super._init({
            style_class: 'ssi-cell',
            reactive: true,
            can_focus: true,
            track_hover: true,
            layout_manager: new Clutter.BinLayout(),
        });

        this.itemId = id;
        this.kind = kind;
        this.body = content;
        this.tracked = tracked;
        this.draggable = options.draggable ?? true;
        // When true the grid swallows the primary button press, tells a click from
        // a drag, and calls `onActivate` on a click. Tray icons open their menu on
        // button press, which would fire at the start of a drag, so their handler
        // replays the swallowed press. Foreign (X11) tray windows are left alone.
        this.interceptPress = options.interceptPress ?? true;
        this.onActivate = options.onActivate ?? null;
        /** Right click. Cells without it leave the secondary button alone. */
        this.onContext = options.onContext ?? null;
        /** Human readable name, used by the settings window. */
        this.label = options.label ?? id;
        // Actors that have to stay visible while the icon is set to "always show".
        this._forceTargets = options.forceTargets ?? (() => [tracked]);
        this._rule = 'auto';
        this._forced = null;
        this._forcing = false;

        content.set({
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
        });
        this.add_child(content);

        tracked.connectObject('notify::visible', () => this._syncVisible(), this);
        this._syncVisible();

        this._justClosedSource = 0;
        this.connect('destroy', () => {
            if (this._justClosedSource)
                GLib.source_remove(this._justClosedSource);
            this._justClosedSource = 0;
            this._forced = null;
        });
    }

    /**
     * True for the rest of the event that closed this cell's menu. A click on a
     * cell whose menu is open closes that menu (the shell's menu manager does
     * it on button press) and must not open it right back.
     */
    get justClosed() {
        return this._justClosedSource !== 0;
    }

    get rule() {
        return this._rule;
    }

    /**
     * 'auto' follows the shell, 'show' keeps the icon on screen even while the
     * shell hides it (Bluetooth without a device, a tray app that went idle),
     * 'hide' removes it from the grid.
     */
    setRule(rule) {
        if (!['auto', 'show', 'hide'].includes(rule))
            rule = 'auto';
        if (rule === this._rule)
            return;
        this._rule = rule;
        this._syncForce();
        this._syncVisible();
    }

    _syncVisible() {
        if (this._rule === 'hide')
            this.visible = false;
        else if (this._rule === 'show')
            this.visible = true;
        else
            this.visible = this.tracked.visible;
    }

    // While "always show" is on, the actors the shell would hide are held
    // visible. What the shell wanted is remembered and handed back afterwards.
    _syncForce() {
        this._releaseForce();
        if (this._rule !== 'show')
            return;

        this._forced = new Map();
        for (const actor of this._forceTargets()) {
            this._forced.set(actor, actor.visible);
            actor.connectObject('notify::visible', () => this._holdVisible(actor), this);
            this._setForced(actor, true);
        }
    }

    _holdVisible(actor) {
        if (this._forcing || !this._forced?.has(actor))
            return;
        this._forced.set(actor, actor.visible);
        if (!actor.visible)
            this._setForced(actor, true);
    }

    _setForced(actor, visible) {
        this._forcing = true;
        try {
            actor.visible = visible;
        } catch {
            // The actor was destroyed in the meantime.
        } finally {
            this._forcing = false;
        }
    }

    _releaseForce() {
        const forced = this._forced;
        this._forced = null;
        if (!forced)
            return;

        for (const [actor, natural] of forced) {
            actor.disconnectObject(this);
            this._setForced(actor, natural);
        }
    }

    activate(event) {
        this.onActivate?.(this, event);
    }

    showContext(event) {
        this.onContext?.(this, event);
    }

    setOpen(open) {
        if (open) {
            this.add_style_pseudo_class('open');
            return;
        }

        this.remove_style_pseudo_class('open');
        if (!this._justClosedSource) {
            this._justClosedSource = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._justClosedSource = 0;
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    vfunc_key_press_event(event) {
        const symbol = event.get_key_symbol();
        if (symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter ||
            symbol === Clutter.KEY_space) {
            this.activate(null);
            return Clutter.EVENT_STOP;
        }
        return super.vfunc_key_press_event(event);
    }
});

export const IconGrid = GObject.registerClass(
class SSIGrid extends St.Widget {
    _init() {
        super._init({
            style_class: 'ssi-grid',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.END,
        });

        this._cells = [];
        this._nextSeq = 0;
        this._columns = 2;
        this._padding = 3;
        this._spacing = 2;
        this._fromBottom = true;
        this._geometry = null;
        this._press = null;
        this._drag = null;

        /** Called with the ordered item ids once a drop is accepted. */
        this.onOrderCommitted = null;

        // Keep desktop-wide "restyle everything in the panel" code out of our cells.
        this.get_children = () => [];
    }

    // -- configuration ----------------------------------------------------

    configure({columns, padding, spacing, fromBottom}) {
        this._columns = Math.max(1, columns);
        this._padding = Math.max(0, padding);
        this._spacing = Math.max(0, spacing);
        this._fromBottom = fromBottom;
        this.queue_relayout();
    }

    get cells() {
        return this._cells.slice();
    }

    orderedIds() {
        return this._cells.map(cell => cell.itemId);
    }

    cellById(id) {
        return this._cells.find(cell => cell.itemId === id) ?? null;
    }

    /** The cell `actor` belongs to (the actor itself or one of its descendants). */
    cellFor(actor) {
        for (let node = actor; node; node = node.get_parent()) {
            if (this._cells.includes(node))
                return node;
        }
        return null;
    }

    // -- cells ------------------------------------------------------------

    addCell(cell) {
        if (this._cells.includes(cell))
            return;
        cell.seq = this._nextSeq++;
        this._cells.push(cell);
        this.add_child(cell);
        cell.connectObject(
            'captured-event', (_actor, event) => this._onCellEvent(cell, event),
            'destroy', () => this._forgetCell(cell),
            this);
        this.queue_relayout();
    }

    removeCell(cell) {
        this._forgetCell(cell);
        if (cell.get_parent() === this)
            this.remove_child(cell);
    }

    _forgetCell(cell) {
        if (this._press?.cell === cell || this._drag?.cell === cell)
            this._cancelPointer();
        cell.disconnectObject(this);
        const index = this._cells.indexOf(cell);
        if (index >= 0)
            this._cells.splice(index, 1);
        this.queue_relayout();
    }

    /**
     * Sort cells by the saved id list. Unknown ids keep their relative order
     * after the known ones, so newly appearing tray icons land on top. An
     * empty list means the default order: system icons, then tray icons, each
     * in the order they appeared.
     */
    applyOrder(ids) {
        if (ids.length === 0) {
            const kindRank = cell => (cell.kind === 'system' ? 0 : 1);
            this._cells.sort((a, b) => (kindRank(a) - kindRank(b)) || (a.seq - b.seq));
            this.queue_relayout();
            return;
        }

        const rank = cell => {
            const index = ids.indexOf(cell.itemId);
            return index < 0 ? Number.MAX_SAFE_INTEGER : index;
        };
        const indexed = this._cells.map((cell, position) => ({cell, position}));
        indexed.sort((a, b) => (rank(a.cell) - rank(b.cell)) || (a.position - b.position));
        this._cells = indexed.map(entry => entry.cell);
        this.queue_relayout();
    }

    // -- layout -----------------------------------------------------------

    _visibleCells() {
        return this._cells.filter(cell => cell.visible);
    }

    _measure() {
        const visible = this._visibleCells();
        let iconW = MIN_ICON;
        let iconH = MIN_ICON;
        for (const cell of visible) {
            const [, natW] = cell.get_preferred_width(-1);
            const [, natH] = cell.get_preferred_height(-1);
            iconW = Math.max(iconW, natW);
            iconH = Math.max(iconH, natH);
        }

        const count = visible.length;
        const cols = Math.max(1, Math.min(this._columns, count));
        const rows = count > 0 ? Math.ceil(count / cols) : 0;
        return {
            visible,
            count,
            cols,
            rows,
            cellW: Math.ceil(iconW + 2 * this._padding),
            cellH: Math.ceil(iconH + 2 * this._padding),
        };
    }

    vfunc_get_preferred_width(_forHeight) {
        const m = this._measure();
        if (m.count === 0)
            return [0, 0];
        const gaps = (m.cols - 1) * this._spacing;
        return [m.cols * MIN_ICON + gaps, m.cols * m.cellW + gaps];
    }

    vfunc_get_preferred_height(_forWidth) {
        const m = this._measure();
        if (m.count === 0)
            return [0, 0];
        const height = m.rows * m.cellH + (m.rows - 1) * this._spacing;
        return [height, height];
    }

    vfunc_allocate(box) {
        this.set_allocation(box);

        const m = this._measure();
        const availW = box.x2 - box.x1;
        const availH = box.y2 - box.y1;
        const gap = this._spacing;

        const cellW = Math.max(1, Math.min(m.cellW,
            Math.floor((availW - gap * (m.cols - 1)) / m.cols)));
        const cellH = m.cellH;
        const gridW = m.cols * cellW + gap * (m.cols - 1);
        const x0 = Math.floor((availW - gridW) / 2);

        this._geometry = {
            cols: m.cols,
            rows: m.rows,
            count: m.count,
            cellW,
            cellH,
            gap,
            x0,
            width: availW,
            height: availH,
        };

        m.visible.forEach((cell, index) => {
            const row = Math.floor(index / m.cols);
            const col = index % m.cols;
            const x = x0 + col * (cellW + gap);
            const y = this._fromBottom
                ? availH - (row + 1) * cellH - row * gap
                : row * (cellH + gap);

            const childBox = new Clutter.ActorBox();
            childBox.set_origin(x, y);
            childBox.set_size(cellW, cellH);
            cell.allocate(childBox);
            this._glide(cell, x, y);
        });
    }

    // Slide cells to their new slot instead of snapping.
    _glide(cell, x, y) {
        const last = cell._ssiSlot;
        cell._ssiSlot = {x, y};
        if (!last || (isCloseEnough(last.x, x) && isCloseEnough(last.y, y)))
            return;
        if (!cell.mapped)
            return;

        const [tx, ty] = cell.get_translation();
        cell.remove_all_transitions();
        cell.set_translation(tx + last.x - x, ty + last.y - y, 0);
        cell.ease({
            translation_x: 0,
            translation_y: 0,
            duration: REFLOW_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    // -- slot maths -------------------------------------------------------

    _slotAt(x, y) {
        const g = this._geometry;
        if (!g || g.count === 0)
            return 0;

        const col = Math.min(g.cols - 1,
            Math.max(0, Math.floor((x - g.x0) / (g.cellW + g.gap))));
        const row = this._fromBottom
            ? Math.floor((g.height - y) / (g.cellH + g.gap))
            : Math.floor(y / (g.cellH + g.gap));
        const clampedRow = Math.min(g.rows - 1, Math.max(0, row));
        return Math.min(g.count - 1, clampedRow * g.cols + col);
    }

    _moveCellToSlot(cell, slot) {
        const visible = this._visibleCells();
        const from = visible.indexOf(cell);
        if (from < 0 || from === slot)
            return;

        // Positions of the visible cells inside the full list; hidden cells
        // stay where they are so their saved rank is not disturbed.
        const positions = visible.map(c => this._cells.indexOf(c));
        const reordered = visible.slice();
        reordered.splice(from, 1);
        reordered.splice(slot, 0, cell);
        positions.forEach((position, i) => {
            this._cells[position] = reordered[i];
        });
        this.queue_relayout();
    }

    // -- pointer handling -------------------------------------------------

    _onCellEvent(cell, event) {
        const type = event.type();

        if (type === Clutter.EventType.TOUCH_BEGIN && cell.kind === 'system') {
            cell.activate(event);
            return Clutter.EVENT_STOP;
        }

        if (type === Clutter.EventType.BUTTON_PRESS &&
            event.get_button() === Clutter.BUTTON_SECONDARY && cell.onContext) {
            if (this._press)
                this._cancelPointer();
            cell.showContext(event);
            return Clutter.EVENT_STOP;
        }

        if (type !== Clutter.EventType.BUTTON_PRESS ||
            event.get_button() !== Clutter.BUTTON_PRIMARY ||
            !cell.interceptPress)
            return Clutter.EVENT_PROPAGATE;

        if (this._press)
            this._cancelPointer();

        const [x, y] = event.get_coords();
        this._press = {cell, x, y, event: event.copy()};
        cell.add_style_pseudo_class('active');
        global.stage.connectObject(
            'captured-event', (_stage, ev) => this._onStageEvent(ev), this);
        return Clutter.EVENT_STOP;
    }

    _onStageEvent(event) {
        const type = event.type();

        if (type === Clutter.EventType.MOTION) {
            const [x, y] = event.get_coords();
            if (this._drag) {
                this._updateDrag(x, y);
                return Clutter.EVENT_STOP;
            }
            if (this._press && this._press.cell.draggable) {
                const threshold = this._dragThreshold();
                if (Math.hypot(x - this._press.x, y - this._press.y) > threshold)
                    this._beginDrag(x, y);
            }
            return this._drag ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
        }

        if (type === Clutter.EventType.BUTTON_RELEASE &&
            event.get_button() === Clutter.BUTTON_PRIMARY) {
            const [x, y] = event.get_coords();
            if (this._drag) {
                this._finishDrag(x, y);
            } else if (this._press) {
                const {cell, event: pressEvent} = this._press;
                this._cancelPointer();
                cell.activate(pressEvent);
            }
            return Clutter.EVENT_STOP;
        }

        if (type === Clutter.EventType.KEY_PRESS &&
            event.get_key_symbol() === Clutter.KEY_Escape && (this._drag || this._press)) {
            this._abortDrag();
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _dragThreshold() {
        try {
            return global.stage.context.get_settings().dndDragThreshold;
        } catch {
            return 8;
        }
    }

    _beginDrag(x, y) {
        const cell = this._press.cell;
        const [cellX, cellY] = cell.get_transformed_position();

        const clone = new Clutter.Clone({source: cell, opacity: 235});
        clone.set_size(cell.width, cell.height);
        Main.uiGroup.add_child(clone);
        Main.uiGroup.set_child_above_sibling(clone, null);
        Shell.util_set_hidden_from_pick(clone, true);

        this._drag = {
            cell,
            clone,
            offsetX: this._press.x - cellX,
            offsetY: this._press.y - cellY,
            startOrder: this.orderedIds(),
        };
        this._press = null;

        cell.remove_style_pseudo_class('active');
        cell.add_style_pseudo_class('dragging');
        clone.set_position(cellX, cellY);
        this._updateDrag(x, y);
    }

    _updateDrag(x, y) {
        const drag = this._drag;
        drag.clone.set_position(x - drag.offsetX, y - drag.offsetY);

        const [ok, localX, localY] = this.transform_stage_point(x, y);
        if (!ok)
            return;

        if (this._insideDropZone(localX, localY))
            this._moveCellToSlot(drag.cell, this._slotAt(localX, localY));
    }

    _insideDropZone(localX, localY) {
        const g = this._geometry;
        if (!g)
            return false;
        return localX > -DRAG_SLACK && localX < g.width + DRAG_SLACK &&
            localY > -DRAG_SLACK && localY < g.height + DRAG_SLACK;
    }

    _finishDrag(x, y) {
        const drag = this._drag;
        const [ok, localX, localY] = this.transform_stage_point(x, y);
        const accepted = ok && this._insideDropZone(localX, localY);

        const cell = drag.cell;
        this._endDrag();

        if (!accepted) {
            this.applyOrder(drag.startOrder);
            return;
        }
        if (cell && this.orderedIds().join('\n') !== drag.startOrder.join('\n'))
            this.onOrderCommitted?.(this.orderedIds());
    }

    _abortDrag() {
        const drag = this._drag;
        const startOrder = drag?.startOrder;
        this._endDrag();
        this._cancelPointer();
        if (startOrder)
            this.applyOrder(startOrder);
    }

    _endDrag() {
        const drag = this._drag;
        this._drag = null;
        this._press = null;
        global.stage.disconnectObject(this);
        if (!drag)
            return;
        drag.cell.remove_style_pseudo_class('dragging');
        drag.clone.destroy();
    }

    _cancelPointer() {
        const press = this._press;
        this._press = null;
        global.stage.disconnectObject(this);
        press?.cell.remove_style_pseudo_class('active');

        if (this._drag)
            this._endDrag();
    }

    destroy() {
        this._cancelPointer();
        super.destroy();
    }
});

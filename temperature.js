// The laptop's processor temperature, and whether it is being throttled, read
// straight from sysfs.
//
// The sensors are looked up by name rather than by number (hwmon numbers move
// around between boots): the CPU package sensor of Intel (coretemp) and AMD
// (k10temp, zenpower) first, then the generic ACPI one.
//
// Throttling is NOT taken from power-profiles-daemon: its "performance
// degraded: high-operating-temperature" only means that turbo boost is off
// (intel_pstate/no_turbo = 1), whatever the temperature is. What is used is
// what the hardware reports:
//   - the sensor's alarm bit (coretemp's tempN_crit_alarm: the processor is
//     being held back at this very moment),
//   - the kernel's thermal throttle counter going up (Intel),
//   - the temperature being within a couple of degrees of the chip's limit.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const HWMON = '/sys/class/hwmon';
const THERMAL = '/sys/class/thermal';
const CPU = '/sys/devices/system/cpu';

// hwmon chips, best first.
const CHIPS = ['coretemp', 'k10temp', 'zenpower', 'cpu_thermal', 'acpitz'];
// Labels that mean "the whole processor", rather than one core.
const WHOLE_CPU = /^(package|tctl|tdie|cpu)/i;

// What counts as "too hot" when the chip does not tell its own limit, and how
// close to the limit still counts as throttling.
const DEFAULT_LIMIT = 95;
const LIMIT_MARGIN = 2;

// A throttling event keeps the warning up for this long (seconds), so a short
// one is not missed between two readings.
const HOLD_SECONDS = 5;
// A counter reading older than this (seconds) says nothing about "now".
const FRESH_SECONDS = 3;

const decoder = new TextDecoder();

function readText(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? decoder.decode(bytes).trim() : null;
    } catch {
        return null;
    }
}

function readNumber(path) {
    const value = Number.parseInt(readText(path) ?? '', 10);
    return Number.isFinite(value) ? value : null;
}

function listDir(path) {
    const names = [];
    try {
        const enumerator = Gio.File.new_for_path(path)
            .enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        for (let info = enumerator.next_file(null); info; info = enumerator.next_file(null))
            names.push(info.get_name());
        enumerator.close(null);
    } catch {
        // No such directory: this machine has no such sensors.
    }
    return names.sort();
}

/** The temperature input of the processor: a path, or null. */
function findSensor(root) {
    const hwmon = `${root}${HWMON}`;
    const chips = listDir(hwmon).map(name => ({
        dir: `${hwmon}/${name}`,
        name: readText(`${hwmon}/${name}/name`),
    }));

    for (const wanted of CHIPS) {
        for (const chip of chips.filter(c => c.name === wanted)) {
            const inputs = listDir(chip.dir).filter(file => /^temp\d+_input$/.test(file));
            const whole = inputs.find(file =>
                WHOLE_CPU.test(readText(`${chip.dir}/${file.replace('_input', '_label')}`) ?? ''));
            const pick = whole ?? inputs.find(file => file === 'temp1_input') ?? inputs[0];
            if (pick)
                return `${chip.dir}/${pick}`;
        }
    }

    const thermal = `${root}${THERMAL}`;
    const zones = listDir(thermal).filter(name => name.startsWith('thermal_zone'));
    for (const wanted of [/^x86_pkg_temp$/, /cpu/i]) {
        const zone = zones.find(name => wanted.test(readText(`${thermal}/${name}/type`) ?? ''));
        if (zone)
            return `${thermal}/${zone}/temp`;
    }

    return null;
}

/** The kernel's package throttle counter (Intel), or null. */
function findThrottleCounter(root) {
    const cpus = listDir(`${root}${CPU}`).filter(name => /^cpu\d+$/.test(name));
    for (const cpu of cpus) {
        const path = `${root}${CPU}/${cpu}/thermal_throttle/package_throttle_count`;
        if (readNumber(path) !== null)
            return path;
    }
    return null;
}

export class CpuTemperature {
    /** @param {object} [options] `root` prefixes the sysfs paths (for tests). */
    constructor({root = ''} = {}) {
        this._root = root;
        this._path = undefined;
        this._counterPath = undefined;
        this._limit = undefined;
        this._count = null;
        this._countAt = 0;
        this._hitAt = null;
    }

    /** Degrees Celsius, or null when this machine has no readable sensor. */
    read() {
        if (this._path === undefined)
            this._setSensor(findSensor(this._root));

        let value = this._path ? this._parse(readText(this._path)) : null;
        if (value === null && this._path) {
            // The sensor went away (a resume can renumber them): look again once.
            this._setSensor(findSensor(this._root));
            value = this._path ? this._parse(readText(this._path)) : null;
        }
        return value;
    }

    /**
     * Whether the processor is being held back by heat, as of now. Call it
     * about once a second while it matters; a short event stays reported for
     * a few seconds.
     *
     * @param {number|null} celsius the reading just taken (see read())
     */
    throttling(celsius) {
        const now = GLib.get_monotonic_time() / 1e6;
        let hit = false;

        // The sensor itself says so.
        if (this._alarmPath && readText(this._alarmPath) === '1')
            hit = true;

        // The kernel counted a new event since the previous reading.
        if (this._counterPath === undefined)
            this._counterPath = findThrottleCounter(this._root);
        if (this._counterPath) {
            const count = readNumber(this._counterPath);
            if (count !== null) {
                if (this._count !== null && now - this._countAt <= FRESH_SECONDS && count > this._count)
                    hit = true;
                this._count = count;
                this._countAt = now;
            }
        }

        // Right at the chip's limit.
        if (celsius !== null && celsius !== undefined && celsius >= this._limit - LIMIT_MARGIN)
            hit = true;

        if (hit)
            this._hitAt = now;
        return this._hitAt !== null && now - this._hitAt < HOLD_SECONDS;
    }

    _setSensor(path) {
        this._path = path;
        this._alarmPath = null;
        this._limit = DEFAULT_LIMIT;
        if (!path)
            return;

        // coretemp (and a few others) expose a limit and an alarm per sensor.
        const stem = path.replace(/_input$/, '');
        if (stem !== path) {
            if (readText(`${stem}_crit_alarm`) !== null)
                this._alarmPath = `${stem}_crit_alarm`;
            const limits = [`${stem}_crit`, `${stem}_max`]
                .map(file => readNumber(file))
                .filter(milli => milli !== null && milli > 0);
            if (limits.length)
                this._limit = Math.min(...limits) / 1000;
        }
    }

    _parse(text) {
        const milli = Number.parseInt(text ?? '', 10);
        return Number.isFinite(milli) ? milli / 1000 : null;
    }

    static format(celsius) {
        return `${Math.round(celsius)} °C`;
    }
}

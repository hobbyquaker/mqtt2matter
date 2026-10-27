/* The process figures of the statistics popup: CPU, memory, the event loop's utilisation and lag, and
   the MQTT message rate. They are averages over a window, sampled on a timer every few seconds, so
   any number of viewers read the same values and none of them resets the others' window; until the
   first window is complete the figures are those since the start. The event loop delay histogram
   (perf_hooks) costs next to nothing; nothing here allocates per message. */

import {type EventLoopUtilization, monitorEventLoopDelay, performance} from 'node:perf_hooks';

export interface RuntimeFigures {
    /** seconds since the process started */
    uptime: number;
    /** resident set size, MB */
    memoryMb: number;
    /** the V8 heap in use, MB */
    heapMb: number;
    /** user + system CPU time over the window, in percent of one core */
    cpuPercent: number;
    /** event loop utilisation over the window, percent */
    eluPercent: number;
    /** event loop delay over the window, ms */
    lagMeanMs: number;
    lagMaxMs: number;
    mqttMessagesPerSecond: number;
    /** the window these averages cover, s */
    window: number;
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

export class RuntimeStats {
    private readonly histogram = monitorEventLoopDelay({resolution: 20});
    private readonly intervalMs: number;
    private timer: ReturnType<typeof setInterval> | undefined;
    private since = performance.now();
    private cpu = process.cpuUsage();
    private elu: EventLoopUtilization = performance.eventLoopUtilization();
    private messages = 0;
    private last: Omit<RuntimeFigures, 'uptime' | 'memoryMb' | 'heapMb'> | undefined;

    constructor(intervalMs = 5000) {
        this.intervalMs = intervalMs;
    }

    start(): void {
        if (this.timer !== undefined) {
            return;
        }
        this.histogram.enable();
        this.timer = setInterval(() => {
            this.last = this.window(true);
        }, this.intervalMs);
        this.timer.unref();
    }

    stop(): void {
        if (this.timer !== undefined) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        this.histogram.disable();
    }

    /** one MQTT message arrived */
    count(): void {
        this.messages++;
    }

    figures(): RuntimeFigures {
        const memory = process.memoryUsage();
        return {
            uptime: Math.round(process.uptime()),
            memoryMb: Math.round(memory.rss / 1048576),
            heapMb: Math.round(memory.heapUsed / 1048576),
            ...(this.last ?? this.window(false)),
        };
    }

    /** the averages since the window began; `close` starts the next window */
    private window(close: boolean): Omit<RuntimeFigures, 'uptime' | 'memoryMb' | 'heapMb'> {
        const now = performance.now();
        const seconds = Math.max((now - this.since) / 1000, 0.001);
        const cpu = process.cpuUsage(this.cpu);
        const elu = performance.eventLoopUtilization(this.elu);
        // the histogram has no samples until the first tick of its resolution: NaN then
        const mean = Number.isFinite(this.histogram.mean) ? this.histogram.mean : 0;
        const figures = {
            cpuPercent: round1(((cpu.user + cpu.system) / 1000 / (seconds * 1000)) * 100),
            eluPercent: Math.round(elu.utilization * 100),
            lagMeanMs: round1(mean / 1e6),
            lagMaxMs: round1(this.histogram.max / 1e6),
            mqttMessagesPerSecond: round1(this.messages / seconds),
            window: Math.round(seconds),
        };
        if (close) {
            this.since = now;
            this.cpu = process.cpuUsage();
            this.elu = performance.eventLoopUtilization();
            this.messages = 0;
            this.histogram.reset();
        }
        return figures;
    }
}

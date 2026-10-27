<script lang="ts">
    /* The statistics popup: the process figures and what the bridge holds, polled every few seconds
       only while the popup is open. */
    import {type Stats, api} from '../api.ts';
    import {t} from '../i18n.svelte.ts';
    import BarIcon from './BarIcon.svelte';

    interface Props {
        open: boolean;
        ontoggle: () => void;
    }

    let {open, ontoggle}: Props = $props();

    let stats = $state<Stats | undefined>(undefined);
    let failed = $state(false);

    async function load(): Promise<void> {
        try {
            stats = await api.stats();
            failed = false;
        } catch {
            failed = true;
        }
    }

    $effect(() => {
        if (!open) {
            return;
        }
        void load();
        // the server closes its averaging window every 5 s; polling faster shows nothing new
        const timer = setInterval(() => void load(), 5000);
        return () => {
            clearInterval(timer);
        };
    });

    function uptime(seconds: number): string {
        const d = Math.floor(seconds / 86400);
        const h = Math.floor((seconds % 86400) / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        return `${d > 0 ? `${d}d ` : ''}${d > 0 || h > 0 ? `${h}h ` : ''}${m}m`;
    }
</script>

<div class="ui-popup-anchor">
    <button
        type="button"
        class="ui-bar-button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={t('Statistics')}
        title={t('Statistics')}
        onclick={(event) => {
            event.stopPropagation();
            ontoggle();
        }}
        data-testid="stats-button"
    >
        <BarIcon name="stats" />
    </button>
    {#if open}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <div class="ui-popup" onclick={(event) => event.stopPropagation()} data-testid="stats">
            {#if stats}
                <dl class="ui-kv">
                    <dt>{t('Uptime')}</dt>
                    <dd data-testid="stats-uptime">{uptime(stats.uptime)}</dd>
                    <dt>{t('Devices')}</dt>
                    <dd data-testid="stats-devices">{stats.devices}</dd>
                    <dt>{t('Endpoints')}</dt>
                    <dd data-testid="stats-endpoints">{stats.endpoints}</dd>
                    <dt>{t('Bridges')}</dt>
                    <dd data-testid="stats-bridges">{stats.bridgesCommissioned} / {stats.bridges} {t('paired')}</dd>
                    <dt>{t('Controllers (fabrics)')}</dt>
                    <dd data-testid="stats-fabrics">{stats.fabrics}</dd>
                    <dt>{t('MQTT topics')}</dt>
                    <dd data-testid="stats-topics">{stats.mqttTopics}</dd>
                    <dt>{t('MQTT msg/s')}</dt>
                    <dd data-testid="stats-rate">{stats.mqttMessagesPerSecond}</dd>
                    <dt>{t('Memory (RSS)')}</dt>
                    <dd data-testid="stats-memory">{stats.memoryMb} MB</dd>
                    <dt>{t('Heap')}</dt>
                    <dd>{stats.heapMb} MB</dd>
                    <dt>CPU</dt>
                    <dd data-testid="stats-cpu">{stats.cpuPercent} %</dd>
                    <dt>{t('Event loop utilisation')}</dt>
                    <dd data-testid="stats-elu">{stats.eluPercent} %</dd>
                    <dt>{t('Event loop lag mean')}</dt>
                    <dd data-testid="stats-lag-mean">{stats.lagMeanMs} ms</dd>
                    <dt>{t('Event loop lag max')}</dt>
                    <dd data-testid="stats-lag-max">{stats.lagMaxMs} ms</dd>
                </dl>
                <p class="ui-faint note">{t('Averages over the last {seconds} s', {seconds: stats.window})}</p>
            {:else if failed}
                <p class="ui-warn-text note">{t('Not reachable')}</p>
            {:else}
                <p class="ui-faint note">{t('Loading…')}</p>
            {/if}
        </div>
    {/if}
</div>

<style>
    .note {
        margin: 0 0 6px;
        font-size: var(--ui-font-size-small);
    }
</style>

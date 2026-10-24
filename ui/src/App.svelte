<script lang="ts">
    import {onMount} from 'svelte';

    import {api, type Status} from './lib/api.ts';
    import DialogHost from './lib/components/DialogHost.svelte';
    import Notices from './lib/components/Notices.svelte';
    import Tabs from './lib/components/Tabs.svelte';
    import {events} from './lib/events.svelte.ts';
    import {LANGUAGES, LANGUAGE_LABELS, i18n, t} from './lib/i18n.svelte.ts';
    import {type Page, router} from './lib/router.svelte.ts';
    import {type Theme, getTheme, nextTheme, setTheme} from './lib/theme.ts';
    import Adopt from './pages/Adopt.svelte';
    import Bridges from './pages/Bridges.svelte';
    import Check from './pages/Check.svelte';
    import Config from './pages/Config.svelte';
    import Devices from './pages/Devices.svelte';
    import Log from './pages/Log.svelte';
    import Mqtt from './pages/Mqtt.svelte';
    import Presets from './pages/Presets.svelte';

    let theme = $state<Theme>(getTheme());
    let status = $state<Status | undefined>(undefined);
    let logLevel = $state<'none' | 'warn' | 'error'>('none');

    const page = $derived(router.route.page);
    const mqttUp = $derived(events.mqttConnected ?? status?.mqtt.connected ?? false);
    const commissioned = $derived(status?.bridges.some((b) => b.commissioned) ?? false);
    const importers = $derived(status?.importers ?? []);

    const THEME_ICONS: Record<Theme, string> = {system: '◐', light: '☀', dark: '☾'};

    const tabs = $derived([
        {id: 'devices', label: t('Devices'), badge: status === undefined ? undefined : String(status.devices)},
        {id: 'presets', label: t('Presets')},
        {id: 'adopt', label: t('Adopt'), dot: importers.length === 0 ? ('none' as const) : undefined},
        {id: 'bridges', label: t('Bridges'), dot: commissioned ? ('ok' as const) : ('warn' as const)},
        {id: 'mqtt', label: 'MQTT', dot: mqttUp ? ('ok' as const) : ('error' as const)},
        {id: 'log', label: t('Log'), dot: logLevel === 'none' ? ('none' as const) : logLevel},
        {id: 'check', label: t('Check')},
        {id: 'config', label: t('Configuration')},
    ]);

    async function loadStatus(): Promise<void> {
        try {
            status = await api.status();
        } catch {
            status = undefined;
        }
    }

    onMount(() => {
        events.start();
        void loadStatus();
        const timer = setInterval(() => void loadStatus(), 15_000);
        const off = events.on((event) => {
            if (event.type === 'devices' || event.type === 'bridges' || event.type === 'status') {
                void loadStatus();
            }
            if (event.type === 'log' && page !== 'log') {
                if (event.entry.level === 'error') {
                    logLevel = 'error';
                } else if (event.entry.level === 'warn' && logLevel !== 'error') {
                    logLevel = 'warn';
                }
            }
        });
        return () => {
            clearInterval(timer);
            off();
            events.stop();
        };
    });

    $effect(() => {
        if (page === 'log') {
            logLevel = 'none';
        }
    });

    function cycleTheme(): void {
        theme = nextTheme(theme);
        setTheme(theme);
    }
</script>

<div class="shell" data-testid="app">
    <header class="header">
        <span class="brand">mqtt2matter</span>
        <Tabs {tabs} active={page} label={t('Pages')} onselect={(id) => router.go(id as Page)} />
        <div class="actions">
            <span class="status" title={mqttUp ? t('Connected to the broker') : t('Not connected to the broker')}>
                <span class="ui-dot" class:ui-dot-ok={mqttUp} class:ui-dot-error={!mqttUp}></span>MQTT
            </span>
            <span class="status" title={events.connected ? t('Event stream connected') : t('Event stream disconnected')}>
                <span class="ui-dot" class:ui-dot-ok={events.connected} class:ui-dot-error={!events.connected}></span>
                {t('Live')}
            </span>
            {#if status}<span class="version ui-faint">{status.version}</span>{/if}
            <select
                class="ui-select language"
                aria-label={t('Language')}
                title={t('Language')}
                value={i18n.choice}
                onchange={(event) => i18n.set(event.currentTarget.value as 'de' | 'en' | 'auto')}
                data-testid="language"
            >
                <option value="auto">{t('Browser language')}</option>
                {#each LANGUAGES as language (language)}
                    <option value={language}>{LANGUAGE_LABELS[language]}</option>
                {/each}
            </select>
            <button
                type="button"
                class="theme"
                aria-label={t('Theme: {theme}', {theme: t(theme)})}
                title={t('Theme: {theme}', {theme: t(theme)})}
                onclick={cycleTheme}
                data-testid="theme"
            >
                <span aria-hidden="true">{THEME_ICONS[theme]}</span>
            </button>
        </div>
    </header>
    <main class="main">
        {#if page === 'devices'}
            <Devices />
        {:else if page === 'presets'}
            <Presets />
        {:else if page === 'adopt'}
            <Adopt />
        {:else if page === 'bridges'}
            <Bridges />
        {:else if page === 'mqtt'}
            <Mqtt />
        {:else if page === 'log'}
            <Log />
        {:else if page === 'check'}
            <Check />
        {:else if page === 'config'}
            <Config />
        {/if}
    </main>
    <Notices />
    <DialogHost />
</div>

<style>
    .shell {
        display: flex;
        flex-direction: column;
        height: 100dvh;
        max-height: 100dvh;
        min-height: 0;
        overflow: hidden;
        background: var(--ui-bg);
        color: var(--ui-fg);
    }

    /* one flat bar with a hairline under it */
    .header {
        display: flex;
        align-items: center;
        gap: 10px;
        height: var(--ui-header-height);
        padding: 0 10px;
        background: var(--ui-header-bg);
        border-bottom: 1px solid var(--ui-border);
        flex: 0 0 auto;
        min-width: 0;
    }

    .brand {
        font-weight: 700;
        letter-spacing: 1px;
        color: var(--ui-accent);
        white-space: nowrap;
    }

    .actions {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-left: auto;
        white-space: nowrap;
    }

    .status {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        color: var(--ui-fg-muted);
        font-size: var(--ui-font-size-small);
    }

    .version {
        font-size: var(--ui-font-size-small);
    }

    .language {
        width: auto;
        min-height: 24px;
    }

    .theme {
        width: 26px;
        height: 24px;
        padding: 0;
        border: 1px solid var(--ui-border);
        border-radius: var(--ui-radius);
        background: var(--ui-bg);
        cursor: pointer;
        line-height: 1;
    }

    .theme:hover {
        border-color: var(--ui-border-strong);
        background: var(--ui-accent-bg);
    }

    .main {
        flex: 1 1 auto;
        min-height: 0;
        overflow: hidden;
    }

    @media (max-width: 700px) {
        .status,
        .version {
            display: none;
        }
    }
</style>

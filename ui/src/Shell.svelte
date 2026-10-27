<script lang="ts">
    import {onMount} from 'svelte';

    import {api, type Status} from './lib/api.ts';
    import BarIcon from './lib/components/BarIcon.svelte';
    import DialogHost from './lib/components/DialogHost.svelte';
    import LicensesDialog from './lib/components/LicensesDialog.svelte';
    import Notices from './lib/components/Notices.svelte';
    import StatsMenu from './lib/components/StatsMenu.svelte';
    import Tabs from './lib/components/Tabs.svelte';
    import VersionMenu from './lib/components/VersionMenu.svelte';
    import {events} from './lib/events.svelte.ts';
    import {t} from './lib/i18n.svelte.ts';
    import {type Page, router} from './lib/router.svelte.ts';
    import {session} from './lib/session.svelte.ts';
    import Adopt from './pages/Adopt.svelte';
    import Bridges from './pages/Bridges.svelte';
    import Check from './pages/Check.svelte';
    import Config from './pages/Config.svelte';
    import Devices from './pages/Devices.svelte';
    import Log from './pages/Log.svelte';
    import Mqtt from './pages/Mqtt.svelte';
    import Presets from './pages/Presets.svelte';

    let status = $state<Status | undefined>(undefined);
    let logLevel = $state<'none' | 'warn' | 'error'>('none');
    /** the one popup of the top bar that is open */
    let popup = $state<'version' | 'stats' | undefined>(undefined);
    let licensesOpen = $state(false);

    const page = $derived(router.route.page);
    const mqttUp = $derived(events.mqttConnected ?? status?.mqtt.connected ?? false);
    const commissioned = $derived(status?.bridges.some((b) => b.commissioned) ?? false);
    const importers = $derived(status?.importers ?? []);

    const tabs = $derived([
        {id: 'devices', label: t('Devices'), badge: status === undefined ? undefined : String(status.devices)},
        {id: 'presets', label: t('Presets')},
        {id: 'adopt', label: t('Adopt'), dot: importers.length === 0 ? ('none' as const) : undefined},
        {id: 'bridges', label: t('Bridges'), dot: commissioned ? ('ok' as const) : ('warn' as const)},
        {id: 'mqtt', label: 'MQTT', dot: mqttUp ? ('ok' as const) : ('error' as const)},
        {id: 'log', label: t('Log'), dot: logLevel === 'none' ? ('none' as const) : logLevel},
        {id: 'check', label: t('Check')},
    ]);

    const REPOSITORY = 'https://github.com/hobbyquaker/mqtt2matter';

    function toggle(which: 'version' | 'stats'): void {
        popup = popup === which ? undefined : which;
    }

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
</script>

<!-- a click outside closes the popup; one in a dialog it opened (confirm the update) does not -->
<svelte:document
    onclick={(event) => {
        if (!(event.target instanceof Element && event.target.closest('dialog') !== null)) {
            popup = undefined;
        }
    }}
    onkeydown={(event) => {
        if (event.key === 'Escape') {
            popup = undefined;
        }
    }}
/>

<div class="shell" data-testid="app">
    <header class="header">
        <span class="brand">mqtt2matter</span>
        <div class="tabs">
            <Tabs {tabs} active={page} label={t('Pages')} onselect={(id) => router.go(id as Page)} />
        </div>
        <div class="actions">
            <span class="status" title={mqttUp ? t('Connected to the broker') : t('Not connected to the broker')}>
                <span class="ui-dot" class:ui-dot-ok={mqttUp} class:ui-dot-error={!mqttUp}></span>MQTT
            </span>
            <span class="status" title={events.connected ? t('Event stream connected') : t('Event stream disconnected')}>
                <span class="ui-dot" class:ui-dot-ok={events.connected} class:ui-dot-error={!events.connected}></span>
                {t('Live')}
            </span>
            {#if session.state?.mode === 'proxy' && session.state.user !== undefined}
                <span class="status user" data-testid="user">{session.state.user}</span>
            {/if}
            <a class="ui-bar-button" href={REPOSITORY} target="_blank" rel="noopener" title="GitHub" aria-label="GitHub" data-testid="github">
                <BarIcon name="github" />
            </a>
            <button
                type="button"
                class="ui-bar-button paragraph"
                title={t('Licences')}
                aria-label={t('Licences')}
                onclick={() => {
                    licensesOpen = true;
                }}
                data-testid="licenses-button">§</button
            >
            {#if status}
                <VersionMenu
                    open={popup === 'version'}
                    version={status.version}
                    newer={status.update?.newer === true}
                    ontoggle={() => toggle('version')}
                    onchange={() => void loadStatus()}
                />
            {/if}
            <StatsMenu open={popup === 'stats'} ontoggle={() => toggle('stats')} />
            <button
                type="button"
                class="ui-bar-button"
                class:ui-bar-button-active={page === 'config'}
                title={t('Configuration')}
                aria-label={t('Configuration')}
                aria-current={page === 'config' ? 'page' : undefined}
                onclick={() => router.go('config')}
                data-testid="config-button"
            >
                <BarIcon name="gear" />
            </button>
            {#if session.state?.mode === 'password' || session.state?.logoutUrl !== undefined}
                <button
                    type="button"
                    class="ui-bar-button"
                    title={t('Log out')}
                    aria-label={t('Log out')}
                    onclick={() => session.logout()}
                    data-testid="logout"
                >
                    <BarIcon name="logout" />
                </button>
            {/if}
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
    <LicensesDialog
        open={licensesOpen}
        onclose={() => {
            licensesOpen = false;
        }}
    />
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

    /* the tabs scroll sideways when the window is narrow; the icons on the right never leave */
    .tabs {
        display: flex;
        align-self: stretch;
        flex: 1 1 auto;
        min-width: 0;
    }

    .actions {
        display: flex;
        align-items: center;
        gap: 2px;
        flex: 0 0 auto;
        white-space: nowrap;
    }

    .status {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        margin-right: 6px;
        color: var(--ui-fg-muted);
        font-size: var(--ui-font-size-small);
    }

    .paragraph {
        font-size: 15px;
        font-weight: 600;
        line-height: 1;
    }

    .main {
        flex: 1 1 auto;
        min-height: 0;
        overflow: hidden;
    }

    @media (max-width: 700px) {
        .status {
            display: none;
        }
    }

    @media (max-width: 480px) {
        .brand {
            display: none;
        }
    }
</style>

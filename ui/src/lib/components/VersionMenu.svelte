<script lang="ts">
    /* The version in the top bar and its popup: installed and latest, check for updates, the update
       and the restart. It stays mounted while the popup is closed, so a restart or an update it
       started is still watched (and the page reloaded on a new version) after the popup closed. */
    import {onDestroy} from 'svelte';

    import {type UpdateStatus, api, errorMessage} from '../api.ts';
    import {dialogs} from '../dialogs.svelte.ts';
    import {t} from '../i18n.svelte.ts';
    import {notices} from '../notices.svelte.ts';
    import BarIcon from './BarIcon.svelte';

    interface Props {
        open: boolean;
        /** the running version, from the status */
        version: string;
        /** the status says a newer version is published */
        newer: boolean;
        ontoggle: () => void;
        /** the update state changed (checked, requested): the shell reloads its status */
        onchange?: (() => void) | undefined;
    }

    let {open, version, newer, ontoggle, onchange = undefined}: Props = $props();

    let status = $state<UpdateStatus | undefined>(undefined);
    let checking = $state(false);
    /** the version running before a restart or an update: when it answers again, the page reloads */
    let waitingFrom = $state<string | undefined>(undefined);
    let timer: ReturnType<typeof setInterval> | undefined;

    async function load(check = false): Promise<void> {
        try {
            status = await api.updateStatus(check);
        } catch (error) {
            if (waitingFrom === undefined) {
                notices.error(errorMessage(error));
            }
        }
    }

    $effect(() => {
        if (open) {
            void load();
        }
    });

    onDestroy(() => {
        if (timer !== undefined) {
            clearInterval(timer);
        }
    });

    /** poll until the bridge answers again (after a restart) or the update is through */
    function watch(): void {
        waitingFrom = status?.current ?? version;
        let down = false;
        const started = Date.now();
        if (timer !== undefined) {
            clearInterval(timer);
        }
        timer = setInterval(() => {
            api.updateStatus().then(
                (next) => {
                    status = next;
                    const updated = waitingFrom !== undefined && next.current !== waitingFrom;
                    if (updated || (down && next.update.requested === undefined)) {
                        clearInterval(timer);
                        timer = undefined;
                        waitingFrom = undefined;
                        notices.info(t('mqtt2matter {version} is running.', {version: next.current}));
                        // a new version brings a new UI
                        if (updated) {
                            window.location.reload();
                        }
                    }
                },
                () => {
                    down = true;
                },
            );
            if (Date.now() - started > 15 * 60 * 1000) {
                clearInterval(timer);
                timer = undefined;
                waitingFrom = undefined;
            }
        }, 2000);
    }

    async function check(): Promise<void> {
        checking = true;
        await load(true);
        checking = false;
        onchange?.();
    }

    async function update(): Promise<void> {
        const latest = status?.latest;
        if (latest === undefined) {
            return;
        }
        const ok = await dialogs.confirm(
            t('Install mqtt2matter {version} and restart? The bridge is offline for a moment; the pairings stay.', {
                version: latest,
            }),
            {confirm: t('Update')},
        );
        if (!ok) {
            return;
        }
        try {
            await api.requestUpdate(latest);
            notices.info(t('Update to {version} requested.', {version: latest}));
            await load();
            watch();
            onchange?.();
        } catch (error) {
            notices.error(errorMessage(error));
        }
    }

    async function restart(): Promise<void> {
        const ok = await dialogs.confirm(t('Restart mqtt2matter? The bridge is offline for a moment.'), {confirm: t('Restart')});
        if (!ok) {
            return;
        }
        try {
            await api.restart();
            notices.info(t('Restarting…'));
            watch();
        } catch (error) {
            notices.error(errorMessage(error));
        }
    }

    const showDot = $derived(status?.newer ?? newer);
</script>

<div class="ui-popup-anchor">
    <button
        type="button"
        class="ui-bar-button version"
        aria-haspopup="true"
        aria-expanded={open}
        title={t('Version')}
        onclick={(event) => {
            event.stopPropagation();
            ontoggle();
        }}
        data-testid="version-button"
    >
        v{version}
        {#if showDot}<span class="ui-update-dot" title={t('Update available')} data-testid="update-dot"></span>{/if}
        {#if waitingFrom !== undefined}<span class="ui-spinning spin" aria-hidden="true"><BarIcon name="refresh" size={11} /></span>{/if}
    </button>
    {#if open}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <div class="ui-popup" onclick={(event) => event.stopPropagation()} data-testid="version">
            <dl class="ui-kv">
                <dt>{t('Installed')}</dt>
                <dd data-testid="version-current">{status?.current ?? version}</dd>
                <dt>{t('Latest')}</dt>
                <dd data-testid="version-latest">
                    {#if status === undefined}
                        …
                    {:else if status.published === false}
                        {t('not published on npm yet')}
                    {:else if status.latest !== undefined}
                        <span class:newer={status.newer}>{status.latest}</span>
                        {#if !status.newer}<span class="ui-faint">· {t('up to date')}</span>{/if}
                    {:else}
                        —
                    {/if}
                </dd>
            </dl>
            {#if status?.error}<p class="ui-warn-text">{status.error}</p>{/if}
            <div class="ui-popup-actions">
                {#if status?.newer && status.latest !== undefined}
                    <button
                        type="button"
                        class="ui-popup-primary"
                        disabled={!status.update.available || waitingFrom !== undefined}
                        title={status.update.reason ?? ''}
                        onclick={update}
                        data-testid="update"
                    >
                        <BarIcon name="refresh" size={12} />
                        {t('Update to {version}', {version: status.latest})}
                    </button>
                    {#if !status.update.available && status.update.reason}<p class="ui-muted reason">{status.update.reason}</p>{/if}
                {/if}
                <button type="button" disabled={checking} onclick={check} data-testid="check-update">
                    <span class:ui-spinning={checking} class="spin"><BarIcon name="refresh" size={11} /></span>
                    {checking ? t('Checking…') : t('Check for updates')}
                </button>
                <button
                    type="button"
                    disabled={status === undefined || !status.restart.available || waitingFrom !== undefined}
                    title={status?.restart.reason ?? ''}
                    onclick={restart}
                    data-testid="restart"
                >
                    <BarIcon name="power" size={12} />
                    {t('Restart')}
                </button>
                {#if status !== undefined && !status.restart.available && status.restart.reason}<p class="ui-muted reason">{status.restart.reason}</p>{/if}
            </div>
            {#if waitingFrom !== undefined}<p class="ui-warn-text" data-testid="waiting">{t('Waiting for mqtt2matter to come back…')}</p>{/if}
            {#if status !== undefined && status.update.log.length > 0}
                <pre class="ui-pre log" data-testid="update-log">{status.update.log.join('\n')}</pre>
            {/if}
        </div>
    {/if}
</div>

<style>
    .version {
        font-size: var(--ui-font-size-small);
    }

    .spin {
        display: inline-flex;
    }

    .newer {
        color: var(--ui-warn);
        font-weight: 600;
    }

    p {
        margin: 0 0 6px;
    }

    .reason {
        margin: 0 0 4px;
        text-align: center;
        font-size: var(--ui-font-size-small);
    }

    .log {
        margin-top: 6px;
        max-height: 160px;
        font-size: var(--ui-font-size-small);
    }
</style>

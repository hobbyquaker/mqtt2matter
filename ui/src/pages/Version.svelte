<script lang="ts">
    import {onDestroy, onMount} from 'svelte';

    import {type UpdateStatus, api, errorMessage} from '../lib/api.ts';
    import {dialogs} from '../lib/dialogs.svelte.ts';
    import {t} from '../lib/i18n.svelte.ts';
    import {notices} from '../lib/notices.svelte.ts';

    let status = $state<UpdateStatus | undefined>(undefined);
    let busy = $state(false);
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

    onMount(() => {
        void load();
    });

    onDestroy(() => {
        if (timer !== undefined) {
            clearInterval(timer);
        }
    });

    /** poll until the bridge answers again (after a restart) or the update is through */
    function watch(): void {
        waitingFrom = status?.current;
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
        busy = true;
        await load(true);
        busy = false;
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
</script>

<section class="ui-section" data-testid="version">
    <div class="ui-section-title">{t('Version')}</div>
    {#if status}
        <dl class="ui-kv">
            <dt>{t('Running')}</dt>
            <dd data-testid="version-current">{status.current}</dd>
            <dt>{t('Latest')}</dt>
            <dd data-testid="version-latest">
                {#if status.published === false}
                    {t('not published on npm yet')}
                {:else if status.latest !== undefined}
                    {status.latest}
                    {#if status.newer}<span class="ui-badge ui-badge-accent">{t('newer')}</span>{/if}
                {:else}
                    —
                {/if}
                {#if status.error}<span class="ui-warn-text">{status.error}</span>{/if}
            </dd>
        </dl>
        <div class="ui-toolbar">
            <button type="button" class="ui-button" disabled={busy} onclick={check} data-testid="check-update">{t('Check now')}</button>
            <button
                type="button"
                class="ui-button ui-button-primary"
                disabled={!status.newer || !status.update.available || waitingFrom !== undefined}
                title={status.update.reason ?? ''}
                onclick={update}
                data-testid="update">{t('Update')}</button
            >
            <button
                type="button"
                class="ui-button"
                disabled={!status.restart.available || waitingFrom !== undefined}
                title={status.restart.reason ?? ''}
                onclick={restart}
                data-testid="restart">{t('Restart')}</button
            >
        </div>
        {#if !status.restart.available && status.restart.reason}<p class="ui-muted">{status.restart.reason}</p>{/if}
        {#if waitingFrom !== undefined}<p class="ui-warn-text" data-testid="waiting">{t('Waiting for mqtt2matter to come back…')}</p>{/if}
        {#if status.update.log.length > 0}
            <pre class="log" data-testid="update-log">{status.update.log.join('\n')}</pre>
        {/if}
    {/if}
</section>

<style>
    p {
        margin: 0;
    }

    .log {
        max-height: 240px;
        overflow: auto;
        margin: 0;
        padding: 6px;
        font-family: var(--ui-font-mono, monospace);
        font-size: var(--ui-font-size-small);
        background: var(--ui-bg);
        border: 1px solid var(--ui-border-muted);
        border-radius: var(--ui-radius);
        white-space: pre-wrap;
    }
</style>

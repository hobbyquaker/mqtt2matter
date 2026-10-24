<script lang="ts">
    import {onMount} from 'svelte';

    import {type AdoptEntry, api, errorMessage} from '../lib/api.ts';
    import Dialog from '../lib/components/Dialog.svelte';
    import {dialogs} from '../lib/dialogs.svelte.ts';
    import {events} from '../lib/events.svelte.ts';
    import {formatValue} from '../lib/format.ts';
    import {t} from '../lib/i18n.svelte.ts';
    import {notices} from '../lib/notices.svelte.ts';
    import {router} from '../lib/router.svelte.ts';

    let importers = $state<string[]>([]);
    let entries = $state<AdoptEntry[]>([]);
    let loaded = $state(false);
    let busy = $state(false);
    let filter = $state('');
    let diffOf = $state<AdoptEntry | undefined>(undefined);

    const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/;
    const ORDER: Record<AdoptEntry['state'], number> = {new: 0, changed: 1, orphaned: 2, adopted: 3};

    const shown = $derived.by(() => {
        const needle = filter.trim().toLowerCase();
        return entries
            .filter((e) => needle === '' || `${e.name} ${e.sourceKey} ${e.vendor ?? ''} ${e.model ?? ''}`.toLowerCase().includes(needle))
            .sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.name.localeCompare(b.name));
    });
    const counts = $derived.by(() => {
        const c = {new: 0, changed: 0, orphaned: 0, adopted: 0};
        for (const e of entries) {
            c[e.state]++;
        }
        return c;
    });

    async function load(): Promise<void> {
        try {
            const result = await api.adopt();
            importers = result.importers;
            entries = result.entries;
            loaded = true;
        } catch (error) {
            notices.error(errorMessage(error));
        }
    }

    onMount(() => {
        void load();
        return events.on((event) => {
            if (event.type === 'discovered' || event.type === 'devices') {
                void load();
            }
        });
    });

    async function resync(): Promise<void> {
        busy = true;
        try {
            const result = await api.resync();
            importers = result.importers;
            entries = result.entries;
        } catch (error) {
            notices.error(errorMessage(error));
        } finally {
            busy = false;
        }
    }

    async function adopt(entry: AdoptEntry): Promise<void> {
        let key: string | undefined;
        if (entry.state === 'new') {
            const answer = await dialogs.prompt(t('Device key for {name}', {name: entry.name}), {
                value: entry.deviceKey,
                pattern: KEY_PATTERN,
                confirm: t('Adopt'),
            });
            if (answer === null) {
                return;
            }
            key = answer;
        } else if (entry.state === 'changed') {
            const ok = await dialogs.confirm(t("Take the source's version of {name}? Your own edits of its bindings are replaced.", {name: entry.name}), {
                confirm: t('Update'),
            });
            if (!ok) {
                return;
            }
        }
        try {
            const detail = await api.adoptDevice(entry.kind, entry.sourceKey, key);
            notices.info(t('{name} adopted as {key}', {name: entry.name, key: detail.key}));
            diffOf = undefined;
            await load();
        } catch (error) {
            notices.error(errorMessage(error));
        }
    }

    async function adoptAllNew(): Promise<void> {
        const fresh = entries.filter((e) => e.state === 'new');
        if (!(await dialogs.confirm(t('Adopt {count} new devices with their proposed keys?', {count: fresh.length}), {confirm: t('Adopt')}))) {
            return;
        }
        for (const entry of fresh) {
            try {
                await api.adoptDevice(entry.kind, entry.sourceKey);
            } catch (error) {
                notices.error(`${entry.name}: ${errorMessage(error)}`);
            }
        }
        await load();
    }

    async function remove(entry: AdoptEntry): Promise<void> {
        const ok = await dialogs.confirm(t('Delete {name}? Controllers lose the device, its rooms and automations.', {name: entry.name}), {
            confirm: t('Delete'),
            danger: true,
        });
        if (!ok) {
            return;
        }
        try {
            await api.deleteDevice(entry.deviceKey);
            await load();
        } catch (error) {
            notices.error(errorMessage(error));
        }
    }

    function stateLabel(state: AdoptEntry['state']): string {
        return {new: t('new'), changed: t('changed'), orphaned: t('orphaned'), adopted: t('adopted')}[state];
    }

    function kindLabel(kind: string): string {
        return {z2m: 'Zigbee2MQTT', 'ha-discovery': 'HA discovery'}[kind] ?? kind;
    }
</script>

<div class="ui-page" data-testid="adopt-page">
    <div class="ui-toolbar">
        <button type="button" class="ui-button" disabled={busy || importers.length === 0} onclick={resync} data-testid="resync">{t('Re-sync')}</button>
        <button type="button" class="ui-button ui-button-primary" disabled={counts.new === 0} onclick={adoptAllNew}>{t('Adopt all new')}</button>
        <input class="ui-input filter" placeholder={t('Filter')} bind:value={filter} />
        <div class="ui-toolbar-trailing">
            {t('{count} new', {count: counts.new})} · {t('{count} changed', {count: counts.changed})} · {t('{count} orphaned', {count: counts.orphaned})} · {t(
                '{count} adopted',
                {count: counts.adopted},
            )}
        </div>
    </div>
    <div class="ui-page-scroll">
        {#if loaded && importers.length === 0}
            <div class="ui-empty">{t('No importer is configured. Discovered devices from Zigbee2MQTT and Home Assistant discovery appear here.')}</div>
        {:else if loaded && entries.length === 0}
            <div class="ui-empty">{t('Nothing discovered yet.')}</div>
        {:else}
            <table class="ui-table" data-testid="adopt-table">
                <thead>
                    <tr><th>{t('State')}</th><th>{t('Name')}</th><th>{t('Source')}</th><th>{t('Model')}</th><th>{t('Key')}</th><th></th></tr>
                </thead>
                <tbody>
                    {#each shown as entry (`${entry.kind}/${entry.sourceKey}`)}
                        <tr data-testid="adopt-row" data-state={entry.state}>
                            <td>
                                <span
                                    class="ui-badge"
                                    class:ui-badge-accent={entry.state === 'new'}
                                    class:ui-badge-warn={entry.state === 'changed' || entry.state === 'orphaned'}
                                    class:ui-badge-ok={entry.state === 'adopted'}>{stateLabel(entry.state)}</span
                                >
                            </td>
                            <td>{entry.name}</td>
                            <td>{kindLabel(entry.kind)} <code>{entry.sourceKey}</code></td>
                            <td>{[entry.vendor, entry.model].filter(Boolean).join(' ')}</td>
                            <td><code>{entry.deviceKey}</code></td>
                            <td class="ui-actions">
                                {#if entry.state === 'new'}
                                    <button type="button" class="ui-button" onclick={() => adopt(entry)} data-testid="adopt">{t('Adopt')}</button>
                                {:else if entry.state === 'changed'}
                                    <button type="button" class="ui-button" onclick={() => (diffOf = entry)} data-testid="show-diff">{t('Diff')}</button>
                                    <button type="button" class="ui-button" onclick={() => adopt(entry)}>{t('Update')}</button>
                                {:else if entry.state === 'orphaned'}
                                    <button type="button" class="ui-button" onclick={() => router.go('devices', entry.deviceKey)}>{t('Open')}</button>
                                    <button type="button" class="ui-button ui-button-danger" onclick={() => remove(entry)} data-testid="remove-orphan"
                                        >{t('Delete')}</button
                                    >
                                {:else}
                                    <button type="button" class="ui-button" onclick={() => router.go('devices', entry.deviceKey)}>{t('Open')}</button>
                                {/if}
                            </td>
                        </tr>
                    {/each}
                </tbody>
            </table>
        {/if}
    </div>
</div>

{#if diffOf}
    <Dialog open={true} title={t('Changes for {name}', {name: diffOf.name})} width="720px" onclose={() => (diffOf = undefined)} testId="diff-dialog">
        <table class="ui-table">
            <thead><tr><th>{t('Path')}</th><th>{t('Configured')}</th><th>{t('Source')}</th></tr></thead>
            <tbody>
                {#each diffOf.changes ?? [] as change (change.path)}
                    <tr>
                        <td><code>{change.path}</code></td>
                        <td class="ui-error-text"><code>{formatValue(change.before)}</code></td>
                        <td class="ui-ok-text"><code>{formatValue(change.after)}</code></td>
                    </tr>
                {/each}
            </tbody>
        </table>
        {#snippet buttons()}
            <button type="button" class="ui-button" onclick={() => (diffOf = undefined)}>{t('Close')}</button>
            <button type="button" class="ui-button ui-button-primary" onclick={() => diffOf && adopt(diffOf)}>{t('Update')}</button>
        {/snippet}
    </Dialog>
{/if}

<style>
    .filter {
        width: 220px;
    }
</style>

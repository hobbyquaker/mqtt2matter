<script lang="ts">
    import {onMount} from 'svelte';

    import {type AdoptEntry, api, errorMessage} from '../lib/api.ts';
    import Dialog from '../lib/components/Dialog.svelte';
    import Icon from '../lib/components/Icon.svelte';
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
    let showUnsupported = $state(false);
    let detailsOf = $state<AdoptEntry | undefined>(undefined);

    const ORDER: Record<AdoptEntry['status'], number> = {new: 0, updated: 1, restored: 1, orphaned: 2, invalid: 3, unchanged: 4, unsupported: 5};

    const shown = $derived.by(() => {
        const needle = filter.trim().toLowerCase();
        return entries
            .filter((e) => showUnsupported || e.status !== 'unsupported')
            .filter((e) => needle === '' || `${e.name} ${e.key} ${e.area ?? ''} ${e.notes.join(' ')}`.toLowerCase().includes(needle))
            .sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.name.localeCompare(b.name));
    });
    const counts = $derived.by(() => {
        const c: Record<string, number> = {};
        for (const e of entries) {
            c[e.status] = (c[e.status] ?? 0) + 1;
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
        const pending = entries.filter((e) => e.status === 'updated' || e.status === 'restored' || e.status === 'orphaned');
        const ok = await dialogs.confirm(
            t(
                'Re-sync every adopted device? {count} entries change: updated ones take the new description (your edits are kept, conflicts reported), orphans are marked.',
                {
                    count: pending.length,
                },
            ),
            {confirm: t('Re-sync')},
        );
        if (!ok) {
            return;
        }
        busy = true;
        try {
            const result = await api.resync();
            importers = result.importers;
            entries = result.entries;
            notices.info(t('{count} devices written', {count: result.written.length}));
        } catch (error) {
            notices.error(errorMessage(error));
        } finally {
            busy = false;
        }
    }

    async function adopt(entry: AdoptEntry): Promise<void> {
        if (entry.status === 'updated' || entry.status === 'restored') {
            const ok = await dialogs.confirm(
                entry.conflicts.length > 0
                    ? t('Update {name}? {count} of your edits conflict with the new description; your edits win, the conflicts are listed in the details.', {
                          name: entry.name,
                          count: entry.conflicts.length,
                      })
                    : t('Update {name} from the source? Your own edits are kept.', {name: entry.name}),
                {confirm: t('Update')},
            );
            if (!ok) {
                return;
            }
        }
        try {
            const detail = await api.adoptDevice(entry.importer, entry.key);
            notices.info(t('{name} adopted as {key}', {name: entry.name, key: detail.key}));
            detailsOf = undefined;
            await load();
        } catch (error) {
            notices.error(errorMessage(error));
        }
    }

    /** a device another importer describes natively is left to that importer */
    function nativeElsewhere(entry: AdoptEntry): boolean {
        return entry.native !== undefined && importers.some((kind) => entry.native?.startsWith(`${kind}:`) === true);
    }

    async function adoptAllNew(): Promise<void> {
        const fresh = entries.filter((e) => e.status === 'new' && !nativeElsewhere(e));
        if (!(await dialogs.confirm(t('Adopt {count} new devices?', {count: fresh.length}), {confirm: t('Adopt')}))) {
            return;
        }
        busy = true;
        for (const entry of fresh) {
            try {
                await api.adoptDevice(entry.importer, entry.key);
            } catch (error) {
                notices.error(`${entry.name}: ${errorMessage(error)}`);
            }
        }
        busy = false;
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
            await api.deleteDevice(entry.key);
            await load();
        } catch (error) {
            notices.error(errorMessage(error));
        }
    }

    function statusLabel(status: AdoptEntry['status']): string {
        return {
            new: t('new'),
            unchanged: t('adopted'),
            updated: t('changed'),
            restored: t('back again'),
            orphaned: t('orphaned'),
            invalid: t('invalid'),
            unsupported: t('unsupported'),
        }[status];
    }

    function kindLabel(kind: string): string {
        return {z2m: 'Zigbee2MQTT', 'ha-discovery': 'HA discovery'}[kind] ?? kind;
    }

    function badgeClass(status: AdoptEntry['status']): string {
        switch (status) {
            case 'new':
                return 'ui-badge-accent';
            case 'unchanged':
                return 'ui-badge-ok';
            case 'updated':
            case 'restored':
            case 'orphaned':
                return 'ui-badge-warn';
            case 'invalid':
                return 'ui-badge-error';
            default:
                return '';
        }
    }
</script>

<div class="ui-page" data-testid="adopt-page">
    <div class="ui-toolbar">
        <button type="button" class="ui-button" disabled={busy || importers.length === 0} onclick={resync} data-testid="resync">{t('Re-sync')}</button>
        <button type="button" class="ui-button ui-button-primary" disabled={busy || (counts.new ?? 0) === 0} onclick={adoptAllNew}>{t('Adopt all new')}</button>
        <input class="ui-input filter" placeholder={t('Filter')} bind:value={filter} />
        <label class="ui-check"><input type="checkbox" bind:checked={showUnsupported} /> {t('show unsupported')}</label>
        <div class="ui-toolbar-trailing">
            {t('{count} new', {count: counts.new ?? 0})} · {t('{count} changed', {count: (counts.updated ?? 0) + (counts.restored ?? 0)})} · {t(
                '{count} orphaned',
                {
                    count: counts.orphaned ?? 0,
                },
            )} · {t('{count} adopted', {count: counts.unchanged ?? 0})} · {t('{count} unsupported', {count: counts.unsupported ?? 0})}
        </div>
    </div>
    <div class="ui-page-scroll">
        {#if loaded && importers.length === 0}
            <div class="ui-empty">{t('No importer is configured. Discovered devices from Zigbee2MQTT and Home Assistant discovery appear here.')}</div>
        {:else if loaded && entries.length === 0}
            <div class="ui-empty">
                {t(
                    'Nothing discovered yet. Zigbee2MQTT publishes its devices on <base>/bridge/devices, Home Assistant discovery under <prefix>/; the bridge subscribes both.',
                )}
            </div>
        {:else}
            <table class="ui-table" data-testid="adopt-table">
                <thead>
                    <tr><th>{t('State')}</th><th>{t('Name')}</th><th>{t('Source')}</th><th>{t('Area')}</th><th>{t('Key')}</th><th>{t('Notes')}</th><th></th></tr
                    >
                </thead>
                <tbody>
                    {#each shown as entry (`${entry.importer}/${entry.key}`)}
                        <tr data-testid="adopt-row" data-status={entry.status} data-key={entry.key}>
                            <td><span class="ui-badge {badgeClass(entry.status)}">{statusLabel(entry.status)}</span></td>
                            <td
                                >{entry.name}{#if entry.kind === 'group'}<span class="ui-badge group">{t('group')}</span>{/if}</td
                            >
                            <td
                                >{kindLabel(entry.importer)}{#if entry.native !== undefined}<span
                                        class="ui-badge native"
                                        title={t('Also described natively by {source} as {key}; the native description is preferred.', {
                                            source: kindLabel(entry.native.split(':')[0] ?? ''),
                                            key: entry.native,
                                        })}>{t('native: {source}', {source: kindLabel(entry.native.split(':')[0] ?? '')})}</span
                                    >{/if}</td
                            >
                            <td data-testid="adopt-area">{entry.area ?? ''}</td>
                            <td><code>{entry.key}</code></td>
                            <td class="notes">
                                {#if entry.conflicts.length > 0}<span class="ui-badge ui-badge-warn"
                                        >{t('{count} conflicts', {count: entry.conflicts.length})}</span
                                    >{/if}
                                {#if entry.edits > 0}<span class="ui-badge">{t('{count} edits', {count: entry.edits})}</span>{/if}
                                {#if entry.unmapped.length > 0}<span class="ui-badge" title={entry.unmapped.join(', ')}
                                        >{t('{count} unmapped', {count: entry.unmapped.length})}</span
                                    >{/if}
                                <span class="ui-muted">{entry.notes.join('; ')}</span>
                            </td>
                            <td class="ui-actions">
                                <button type="button" class="ui-icon-button" title={t('Details')} onclick={() => (detailsOf = entry)} data-testid="show-details"
                                    ><Icon name="info" /></button
                                >
                                {#if entry.status === 'new'}
                                    <button type="button" class="ui-button" disabled={busy} onclick={() => adopt(entry)} data-testid="adopt"
                                        >{t('Adopt')}</button
                                    >
                                {:else if entry.status === 'updated' || entry.status === 'restored'}
                                    <button type="button" class="ui-button" disabled={busy} onclick={() => adopt(entry)} data-testid="update"
                                        >{t('Update')}</button
                                    >
                                {:else if entry.status === 'orphaned'}
                                    <button type="button" class="ui-button" onclick={() => router.go('devices', entry.key)}>{t('Open')}</button>
                                    <button type="button" class="ui-button ui-button-danger" onclick={() => remove(entry)} data-testid="remove-orphan"
                                        >{t('Delete')}</button
                                    >
                                {:else if entry.status === 'unchanged' || entry.status === 'invalid'}
                                    <button type="button" class="ui-button" onclick={() => router.go('devices', entry.key)}>{t('Open')}</button>
                                {/if}
                            </td>
                        </tr>
                    {/each}
                </tbody>
            </table>
        {/if}
    </div>
</div>

{#if detailsOf}
    <Dialog open={true} title={detailsOf.name} width="760px" onclose={() => (detailsOf = undefined)} testId="details-dialog">
        <dl class="ui-kv">
            <dt>{t('State')}</dt>
            <dd>{statusLabel(detailsOf.status)}</dd>
            <dt>{t('Key')}</dt>
            <dd><code>{detailsOf.key}</code></dd>
            {#if detailsOf.area !== undefined}
                <dt>{t('Area')}</dt>
                <dd>{detailsOf.area}</dd>
            {/if}
            {#if detailsOf.native !== undefined}
                <dt>{t('Native')}</dt>
                <dd>
                    {t('Also described natively by {source} as {key}; the native description is preferred.', {
                        source: kindLabel(detailsOf.native.split(':')[0] ?? ''),
                        key: detailsOf.native,
                    })}
                </dd>
            {/if}
            {#if detailsOf.notes.length > 0}
                <dt>{t('Notes')}</dt>
                <dd>{detailsOf.notes.join('; ')}</dd>
            {/if}
            {#if detailsOf.unmapped.length > 0}
                <dt>{t('Not mapped')}</dt>
                <dd><code>{detailsOf.unmapped.join(', ')}</code></dd>
            {/if}
            {#if detailsOf.edits > 0}
                <dt>{t('Your edits')}</dt>
                <dd>{detailsOf.edits}</dd>
            {/if}
        </dl>
        {#if detailsOf.conflicts.length > 0}
            <h3>{t('Conflicts')}</h3>
            <p class="ui-muted">{t('Your edit and the new description changed the same value; your edit stays.')}</p>
            <table class="ui-table">
                <thead><tr><th>{t('Path')}</th><th>{t('Your edit')}</th><th>{t('Source')}</th></tr></thead>
                <tbody>
                    {#each detailsOf.conflicts as conflict, index (index)}
                        <tr>
                            <td><code>{conflict.path}</code></td>
                            <td class="ui-ok-text"><code>{formatValue(conflict.user)}</code></td>
                            <td class="ui-warn-text"><code>{formatValue(conflict.now)}</code></td>
                        </tr>
                    {/each}
                </tbody>
            </table>
        {/if}
        {#snippet buttons()}
            {#if detailsOf}
                {@const entry = detailsOf}
                <button type="button" class="ui-button" onclick={() => (detailsOf = undefined)}>{t('Close')}</button>
                {#if entry.status === 'new' || entry.status === 'updated' || entry.status === 'restored'}
                    <button type="button" class="ui-button ui-button-primary" onclick={() => adopt(entry)}>
                        {entry.status === 'new' ? t('Adopt') : t('Update')}
                    </button>
                {/if}
            {/if}
        {/snippet}
    </Dialog>
{/if}

<style>
    .filter {
        width: 220px;
    }

    .notes {
        white-space: normal;
    }

    .group,
    .native {
        margin-left: 4px;
    }

    p {
        margin: 0;
    }
</style>

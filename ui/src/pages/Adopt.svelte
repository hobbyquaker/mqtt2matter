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
    /** the sensor types chosen in the details dialog for its binary sensors without a class: entity id → class or '' */
    let chosen = $state<Record<string, string>>({});

    /** the classes a binary sensor without one can be given, one per Matter sensor type the importer generates */
    const SENSOR_TYPES: {value: string; label: string}[] = $derived([
        {value: 'motion', label: t('Motion / occupancy')},
        {value: 'opening', label: t('Contact (door, window)')},
        {value: 'moisture', label: t('Water leak')},
        {value: 'cold', label: t('Frost')},
        {value: 'smoke', label: t('Smoke alarm')},
        {value: 'carbon_monoxide', label: t('CO alarm')},
        {value: 'battery', label: t('Battery low')},
        {value: 'battery_charging', label: t('Battery charging')},
    ]);

    function showDetails(entry: AdoptEntry): void {
        chosen = Object.fromEntries((entry.unclassed ?? []).map((u) => [u.id, u.class ?? '']));
        detailsOf = entry;
    }

    /** what the dialog's choice changes against the stored one: entity id → class, null clears; undefined when nothing */
    function classChanges(entry: AdoptEntry): Record<string, string | null> | undefined {
        const changes: Record<string, string | null> = {};
        for (const u of entry.unclassed ?? []) {
            const now = chosen[u.id] ?? '';
            if (now !== (u.class ?? '')) {
                changes[u.id] = now === '' ? null : now;
            }
        }
        return Object.keys(changes).length === 0 ? undefined : changes;
    }

    /** an unsupported entry becomes adoptable once a binary sensor has a type */
    const anyChosen = $derived(Object.values(chosen).some((c) => c !== ''));
    const untyped = (entry: AdoptEntry): number => (entry.unclassed ?? []).filter((u) => u.class === undefined).length;

    const ORDER: Record<AdoptEntry['status'], number> = {
        new: 0,
        updated: 1,
        restored: 1,
        orphaned: 2,
        invalid: 3,
        covered: 4,
        unchanged: 5,
        unsupported: 6,
    };

    const shown = $derived.by(() => {
        const needle = filter.trim().toLowerCase();
        return (
            entries
                // an unsupported entry that a sensor type would make adoptable is shown: it needs the user
                .filter((e) => showUnsupported || e.status !== 'unsupported' || (e.unclassed ?? []).length > 0)
                .filter((e) => needle === '' || `${e.name} ${e.key} ${e.area ?? ''} ${e.notes.join(' ')}`.toLowerCase().includes(needle))
                .sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.name.localeCompare(b.name))
        );
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

    /** a covered entry: the same device as another importer's; adopted only after the user said so */
    async function confirmCovered(entry: AdoptEntry): Promise<{force: boolean; replace: boolean} | undefined> {
        const twins = entry.twins ?? [];
        if (entry.native === undefined && twins.length > 0) {
            // the native description of a device adopted through HA discovery: replace the twin
            const ok = await dialogs.confirm(
                t(
                    '{name} is already adopted as {key}. Replace it: the native description is adopted and {key} is disabled — it stays in the configuration until you delete it. Controllers see a new device.',
                    {name: entry.name, key: twins.join(', ')},
                ),
                {confirm: t('Replace')},
            );
            return ok ? {force: true, replace: true} : undefined;
        }
        const key = entry.covered ?? entry.native ?? '';
        const ok = await dialogs.confirm(
            t(
                '{name} is the same device as {key}, which {source} describes natively. Adopting it here makes a second Matter device for one device: controllers show it twice. Adopt it anyway?',
                {name: entry.name, key, source: kindLabel(key.split(':')[0] ?? '')},
            ),
            {confirm: t('Adopt anyway'), danger: true},
        );
        return ok ? {force: true, replace: false} : undefined;
    }

    async function adopt(entry: AdoptEntry, classes?: Record<string, string | null>): Promise<void> {
        let options: {force?: boolean; replace?: boolean; classes?: Record<string, string | null>} = {};
        if (entry.status === 'covered') {
            const confirmed = await confirmCovered(entry);
            if (confirmed === undefined) {
                return;
            }
            options = confirmed;
        }
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
        if (classes !== undefined) {
            options = {...options, classes};
        }
        try {
            const detail = await api.adoptDevice(entry.importer, entry.key, options);
            notices.info(
                entry.status === 'unchanged'
                    ? t('Sensor types of {name} saved', {name: entry.name})
                    : t('{name} adopted as {key}', {name: entry.name, key: detail.key}),
            );
            detailsOf = undefined;
            await load();
        } catch (error) {
            notices.error(errorMessage(error));
        }
    }

    async function adoptAllNew(): Promise<void> {
        // a covered entry (the same device as another importer's) is never among them: the server says so too
        const fresh = entries.filter((e) => e.status === 'new');
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
            covered: t('duplicate'),
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
            )} · {t('{count} adopted', {count: counts.unchanged ?? 0})} · {t('{count} duplicates', {count: counts.covered ?? 0})} · {t('{count} unsupported', {
                count: counts.unsupported ?? 0,
            })}
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
                                {#if untyped(entry) > 0}<span class="ui-badge ui-badge-warn" data-testid="untyped"
                                        >{t('{count} without a type', {count: untyped(entry)})}</span
                                    >{/if}
                                <span class="ui-muted">{entry.notes.join('; ')}</span>
                            </td>
                            <td class="ui-actions">
                                <button type="button" class="ui-icon-button" title={t('Details')} onclick={() => showDetails(entry)} data-testid="show-details"
                                    ><Icon name="info" /></button
                                >
                                {#if entry.status === 'new'}
                                    <button type="button" class="ui-button" disabled={busy} onclick={() => adopt(entry)} data-testid="adopt"
                                        >{t('Adopt')}</button
                                    >
                                {:else if entry.status === 'covered'}
                                    <button type="button" class="ui-button" disabled={busy} onclick={() => adopt(entry)} data-testid="adopt"
                                        >{entry.native === undefined && (entry.twins ?? []).length > 0 ? t('Replace') : t('Adopt anyway')}</button
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
                                {:else if entry.status === 'unsupported' && (entry.unclassed ?? []).length > 0}
                                    <button type="button" class="ui-button" onclick={() => showDetails(entry)} data-testid="choose-types"
                                        >{t('Choose types')}</button
                                    >
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
            {#if (detailsOf.twins ?? []).length > 0}
                <dt>{t('Twins')}</dt>
                <dd><code>{(detailsOf.twins ?? []).join(', ')}</code></dd>
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
        {#if (detailsOf.unclassed ?? []).length > 0}
            <h3>{t('Sensor types')}</h3>
            <p class="ui-muted">
                {t(
                    'These binary sensors are announced without a device class, so their sensor type is not known. Choose one for each; the choice is kept when the device announces itself again.',
                )}
            </p>
            <dl class="ui-kv">
                {#each detailsOf.unclassed ?? [] as sensor (sensor.id)}
                    <dt>{sensor.name}</dt>
                    <dd>
                        <select class="ui-input" bind:value={chosen[sensor.id]} data-testid="sensor-type" data-entity={sensor.id}>
                            <option value="">{t('not mapped')}</option>
                            {#each SENSOR_TYPES as type (type.value)}
                                <option value={type.value}>{type.label}</option>
                            {/each}
                        </select>
                    </dd>
                {/each}
            </dl>
        {/if}
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
                {@const changes = classChanges(entry)}
                <button type="button" class="ui-button" onclick={() => (detailsOf = undefined)}>{t('Close')}</button>
                {#if entry.status === 'new' || entry.status === 'updated' || entry.status === 'restored'}
                    <button type="button" class="ui-button ui-button-primary" onclick={() => adopt(entry, changes)} data-testid="details-adopt">
                        {entry.status === 'new' ? t('Adopt') : t('Update')}
                    </button>
                {:else if entry.status === 'covered'}
                    <button type="button" class="ui-button" onclick={() => adopt(entry, changes)}>
                        {entry.native === undefined && (entry.twins ?? []).length > 0 ? t('Replace') : t('Adopt anyway')}
                    </button>
                {:else if entry.status === 'unsupported' && (entry.unclassed ?? []).length > 0}
                    <button
                        type="button"
                        class="ui-button ui-button-primary"
                        disabled={!anyChosen}
                        onclick={() => adopt(entry, changes)}
                        data-testid="details-adopt">{t('Adopt')}</button
                    >
                {:else if entry.status === 'unchanged' && (entry.unclassed ?? []).length > 0}
                    <button
                        type="button"
                        class="ui-button ui-button-primary"
                        disabled={changes === undefined}
                        onclick={() => adopt(entry, changes)}
                        data-testid="details-apply">{t('Apply')}</button
                    >
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

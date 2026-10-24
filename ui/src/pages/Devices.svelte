<script lang="ts">
    import {onMount} from 'svelte';

    import {type Catalog, type DeviceListEntry, api, errorMessage} from '../lib/api.ts';
    import Dialog from '../lib/components/Dialog.svelte';
    import Icon from '../lib/components/Icon.svelte';
    import {dialogs} from '../lib/dialogs.svelte.ts';
    import {events} from '../lib/events.svelte.ts';
    import {download, pretty} from '../lib/format.ts';
    import {t} from '../lib/i18n.svelte.ts';
    import {notices} from '../lib/notices.svelte.ts';
    import {router} from '../lib/router.svelte.ts';
    import DeviceEditor from './DeviceEditor.svelte';

    let devices = $state<DeviceListEntry[]>([]);
    let loaded = $state(false);
    let filter = $state('');
    let catalog = $state<Catalog | undefined>(undefined);

    // the create dialog
    let creating = $state(false);
    let newKey = $state('');
    let newName = $state('');
    let newType = $state('OnOffPlugInUnit');
    let typeFilter = $state('');

    const editing = $derived(router.route.rest);
    const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/;
    const keyValid = $derived(KEY_PATTERN.test(newKey) && !devices.some((d) => d.key === newKey));

    const shown = $derived.by(() => {
        const needle = filter.trim().toLowerCase();
        const list =
            needle === ''
                ? devices
                : devices.filter((d) => [d.key, d.name, d.deviceTypes.join(' '), d.source.kind, d.bridge ?? ''].join(' ').toLowerCase().includes(needle));
        return [...list].sort((a, b) => a.name.localeCompare(b.name));
    });

    const typeChoices = $derived.by(() => {
        const needle = typeFilter.trim().toLowerCase();
        return (catalog?.deviceTypes ?? [])
            .filter((d) => d.classification !== 'node' && d.name !== 'RootNode' && d.name !== 'Aggregator')
            .filter((d) => needle === '' || d.name.toLowerCase().includes(needle));
    });

    async function load(): Promise<void> {
        try {
            devices = await api.devices();
            loaded = true;
        } catch (error) {
            notices.error(errorMessage(error));
        }
    }

    onMount(() => {
        void load();
        void api.catalog().then((c) => (catalog = c));
        return events.on((event) => {
            if (event.type === 'devices' || (event.type === 'attribute' && event.cluster === 'BridgedDeviceBasicInformation')) {
                void load();
            }
        });
    });

    function sourceLabel(kind: string): string {
        return {manual: t('manual'), z2m: 'Zigbee2MQTT', 'ha-discovery': 'HA discovery', preset: t('preset')}[kind] ?? kind;
    }

    function openCreate(): void {
        newKey = '';
        newName = '';
        typeFilter = '';
        creating = true;
    }

    function suggestKey(): void {
        if (newKey === '' || !keyValid) {
            newKey = newName
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '')
                .slice(0, 64);
        }
    }

    async function create(): Promise<void> {
        if (!keyValid || newName.trim() === '') {
            return;
        }
        try {
            await api.saveDevice(newKey, {name: newName.trim(), endpoints: [{deviceTypes: [newType]}]});
            creating = false;
            router.go('devices', newKey);
        } catch (error) {
            notices.error(errorMessage(error));
        }
    }

    async function toggle(entry: DeviceListEntry): Promise<void> {
        try {
            const detail = await api.device(entry.key);
            await api.saveDevice(entry.key, {...detail.device, enabled: !entry.enabled});
            await load();
        } catch (error) {
            notices.error(errorMessage(error));
        }
    }

    async function duplicate(entry: DeviceListEntry): Promise<void> {
        const key = await dialogs.prompt(t('Key of the copy'), {value: `${entry.key}-copy`, pattern: KEY_PATTERN, confirm: t('Duplicate')});
        if (key === null) {
            return;
        }
        try {
            const detail = await api.device(entry.key);
            await api.saveDevice(key, {...detail.device, name: `${detail.device.name} 2`.slice(0, 32), source: {kind: 'manual'}, bridge: undefined});
            router.go('devices', key);
        } catch (error) {
            notices.error(errorMessage(error));
        }
    }

    async function exportOne(entry: DeviceListEntry): Promise<void> {
        try {
            download(`${entry.key}.json`, pretty(await api.exportDevice(entry.key)));
        } catch (error) {
            notices.error(errorMessage(error));
        }
    }

    async function remove(entry: DeviceListEntry): Promise<void> {
        const ok = await dialogs.confirm(t('Delete {name}? Controllers lose the device, its rooms and automations.', {name: entry.name}), {
            confirm: t('Delete'),
            danger: true,
        });
        if (!ok) {
            return;
        }
        try {
            await api.deleteDevice(entry.key);
            notices.info(t('{name} deleted', {name: entry.name}));
            await load();
        } catch (error) {
            notices.error(errorMessage(error));
        }
    }
</script>

{#if editing !== ''}
    <DeviceEditor key={editing} onclose={() => router.go('devices')} />
{:else}
    <div class="ui-page" data-testid="devices-page">
        <div class="ui-toolbar">
            <button type="button" class="ui-button ui-button-primary" onclick={openCreate} data-testid="new-device">+ {t('New device')}</button>
            <button type="button" class="ui-button" onclick={() => router.go('presets')}>{t('From preset')}</button>
            <input class="ui-input filter" placeholder={t('Filter')} bind:value={filter} data-testid="device-filter" />
            <div class="ui-toolbar-trailing">{t('{count} devices', {count: devices.length})}</div>
        </div>
        <div class="ui-page-scroll">
            {#if loaded && devices.length === 0}
                <div class="ui-empty">{t('No devices yet. Create one by hand, apply a preset, or adopt a discovered device.')}</div>
            {:else}
                <table class="ui-table" data-testid="device-table">
                    <thead>
                        <tr>
                            <th>{t('Name')}</th>
                            <th>{t('Key')}</th>
                            <th>{t('Device types')}</th>
                            <th>{t('Source')}</th>
                            <th>{t('Bridge')}</th>
                            <th>{t('Endpoint')}</th>
                            <th>{t('State')}</th>
                            <th></th>
                        </tr>
                    </thead>
                    <tbody>
                        {#each shown as entry (entry.key)}
                            <tr class="ui-row-link" data-testid="device-row" data-key={entry.key} onclick={() => router.go('devices', entry.key)}>
                                <td>
                                    <span
                                        class="ui-dot"
                                        class:ui-dot-ok={entry.reachable === true}
                                        class:ui-dot-error={entry.reachable === false}
                                        title={entry.reachable === undefined ? t('not built') : entry.reachable ? t('reachable') : t('unreachable')}
                                    ></span>
                                    {entry.name}
                                </td>
                                <td><code>{entry.key}</code></td>
                                <td>{entry.deviceTypes.join(', ')}{entry.endpoints > 1 ? ` +${entry.endpoints - 1}` : ''}</td>
                                <td>
                                    <span class="ui-badge" class:ui-badge-accent={entry.source.kind !== 'manual'}>{sourceLabel(entry.source.kind)}</span>
                                    {#if entry.source.orphaned}<span class="ui-badge ui-badge-warn">{t('orphaned')}</span>{/if}
                                </td>
                                <td>{entry.bridge ?? ''}</td>
                                <td>{entry.number ?? ''}</td>
                                <td>
                                    {#if !entry.enabled}
                                        <span class="ui-badge">{t('disabled')}</span>
                                    {:else if entry.errors > 0}
                                        <span class="ui-badge ui-badge-error">{t('{count} errors', {count: entry.errors})}</span>
                                    {:else if !entry.built}
                                        <span class="ui-badge ui-badge-warn">{t('not built')}</span>
                                    {:else if entry.violations > 0 || entry.warnings > 0}
                                        <span class="ui-badge ui-badge-warn">{t('{count} warnings', {count: entry.violations + entry.warnings})}</span>
                                    {:else}
                                        <span class="ui-badge ui-badge-ok">{t('ok')}</span>
                                    {/if}
                                </td>
                                <td class="ui-actions" onclick={(event) => event.stopPropagation()}>
                                    <button
                                        type="button"
                                        class="ui-icon-button"
                                        title={entry.enabled ? t('Disable') : t('Enable')}
                                        onclick={() => toggle(entry)}
                                    >
                                        {#if entry.enabled}<Icon name="pause" />{:else}<Icon name="play" />{/if}
                                    </button>
                                    <button type="button" class="ui-icon-button" title={t('Duplicate')} onclick={() => duplicate(entry)}
                                        ><Icon name="copy" /></button
                                    >
                                    <button type="button" class="ui-icon-button" title={t('Export')} onclick={() => exportOne(entry)}
                                        ><Icon name="download" /></button
                                    >
                                    <button type="button" class="ui-icon-button" title={t('Delete')} onclick={() => remove(entry)} data-testid="delete-device"
                                        ><Icon name="trash" /></button
                                    >
                                </td>
                            </tr>
                        {/each}
                    </tbody>
                </table>
            {/if}
        </div>
    </div>

    <Dialog open={creating} title={t('New device')} onclose={() => (creating = false)} testId="create-dialog">
        <div class="ui-form">
            <label class="ui-form-label" for="new-name">{t('Name')}</label>
            <div class="ui-form-field">
                <input id="new-name" class="ui-input" bind:value={newName} onblur={suggestKey} maxlength="32" data-testid="new-name" />
            </div>
            <label class="ui-form-label" for="new-key">{t('Key')}</label>
            <div class="ui-form-field">
                <input id="new-key" class="ui-input ui-mono" class:ui-invalid={newKey !== '' && !keyValid} bind:value={newKey} data-testid="new-key" />
            </div>
            <div class="ui-form-help">{t('The key is the Matter endpoint id: stable, never renamed. Letters, digits, : . _ -')}</div>
            <label class="ui-form-label" for="type-filter">{t('Device type')}</label>
            <div class="ui-form-field"><input id="type-filter" class="ui-input" placeholder={t('Filter')} bind:value={typeFilter} /></div>
            <div class="ui-form-full">
                <select class="ui-select types" size="8" bind:value={newType} data-testid="new-type">
                    {#each typeChoices as type (type.name)}
                        <option value={type.name}>{type.name}</option>
                    {/each}
                </select>
            </div>
            <div class="ui-form-help">{t('The device type brings its mandatory clusters; their mappings are filled in the editor.')}</div>
        </div>
        {#snippet buttons()}
            <button type="button" class="ui-button" onclick={() => (creating = false)}>{t('Cancel')}</button>
            <button
                type="button"
                class="ui-button ui-button-primary"
                disabled={!keyValid || newName.trim() === ''}
                onclick={create}
                data-testid="create-device"
            >
                {t('Create')}
            </button>
        {/snippet}
    </Dialog>
{/if}

<style>
    .filter {
        width: 220px;
    }

    .types {
        width: 100%;
        font-family: var(--ui-font-mono);
    }
</style>

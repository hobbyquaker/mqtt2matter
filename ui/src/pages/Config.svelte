<script lang="ts">
    import {onMount} from 'svelte';

    import {type ConfigView, api, errorMessage} from '../lib/api.ts';
    import Checkbox from '../lib/components/Checkbox.svelte';
    import {dialogs} from '../lib/dialogs.svelte.ts';
    import {download, isRecord, pretty, tryJson} from '../lib/format.ts';
    import {t} from '../lib/i18n.svelte.ts';
    import {notices} from '../lib/notices.svelte.ts';

    let view = $state<ConfigView | undefined>(undefined);
    let text = $state('');
    let importText = $state('');
    let replace = $state(false);
    let saving = $state(false);

    const parsed = $derived(tryJson(text));
    const valid = $derived(isRecord(parsed));
    const importParsed = $derived(tryJson(importText));
    const importDevices = $derived.by(() => {
        if (!isRecord(importParsed)) {
            return undefined;
        }
        const devices = isRecord(importParsed.devices) ? importParsed.devices : importParsed;
        return Object.keys(devices).length > 0 ? devices : undefined;
    });

    async function load(): Promise<void> {
        try {
            view = await api.config();
            text = pretty(view.settings);
        } catch (error) {
            notices.error(errorMessage(error));
        }
    }

    onMount(() => {
        void load();
    });

    async function save(): Promise<void> {
        if (!valid) {
            return;
        }
        saving = true;
        try {
            await api.saveConfig(parsed);
            notices.warn(t('Settings saved. They apply at the next start of mqtt2matter.'));
            await load();
        } catch (error) {
            notices.error(errorMessage(error));
        } finally {
            saving = false;
        }
    }

    async function exportAll(): Promise<void> {
        try {
            download('mqtt2matter.json', pretty(await api.exportAll()));
        } catch (error) {
            notices.error(errorMessage(error));
        }
    }

    function pickFile(event: Event): void {
        const file = (event.currentTarget as HTMLInputElement).files?.[0];
        if (file === undefined) {
            return;
        }
        file.text().then(
            (content) => {
                importText = content;
            },
            () => notices.error(t('The file could not be read.')),
        );
    }

    async function doImport(): Promise<void> {
        if (importDevices === undefined) {
            return;
        }
        const count = Object.keys(importDevices).length;
        const ok = await dialogs.confirm(
            replace
                ? t('Import {count} devices and delete every other device?', {count})
                : t('Import {count} devices? Existing devices with the same key are replaced.', {count}),
            {confirm: t('Import'), danger: replace},
        );
        if (!ok) {
            return;
        }
        try {
            const result = await api.importDevices(importDevices, replace);
            notices.info(t('{count} devices imported', {count: result.imported}));
            importText = '';
        } catch (error) {
            notices.error(errorMessage(error));
        }
    }
</script>

<div class="ui-page" data-testid="config-page">
    <div class="ui-page-scroll columns">
        <section class="ui-section">
            <div class="ui-section-title">
                {t('Settings')}
                {#if view}<span class="ui-faint ui-small">{view.path}</span>{/if}
            </div>
            <p class="ui-muted">
                {t(
                    'The top level of the configuration file without the devices: mqtt, storage, log, vendorId, productId, bridges, server, presets. Changes apply at the next start.',
                )}
            </p>
            {#if view && view.overridden.length > 0}
                <p class="ui-warn-text">{t('Set by the environment and not editable here: {paths}', {paths: view.overridden.join(', ')})}</p>
            {/if}
            <textarea class="ui-textarea" rows="18" bind:value={text} spellcheck="false" data-testid="settings-json"></textarea>
            <div class="ui-toolbar">
                <button type="button" class="ui-button ui-button-primary" disabled={!valid || saving} onclick={save} data-testid="save-settings"
                    >{t('Save')}</button
                >
                <button type="button" class="ui-button" onclick={load}>{t('Reload')}</button>
                {#if !valid}<span class="ui-error-text">{t('Not valid JSON')}</span>{/if}
            </div>
        </section>
        <div class="stack">
            <section class="ui-section">
                <div class="ui-section-title">{t('Export')}</div>
                <p class="ui-muted">{t('The whole configuration file, as it is on disk. One device exports from the device list.')}</p>
                <div><button type="button" class="ui-button" onclick={exportAll} data-testid="export-all">{t('Download mqtt2matter.json')}</button></div>
            </section>
            <section class="ui-section">
                <div class="ui-section-title">{t('Import')}</div>
                <p class="ui-muted">{t('A configuration file or a devices object; every device is validated before anything is written.')}</p>
                <input type="file" accept="application/json,.json" onchange={pickFile} />
                <textarea class="ui-textarea" rows="8" bind:value={importText} placeholder={'{"devices": {…}}'} spellcheck="false" data-testid="import-json"
                ></textarea>
                <div class="ui-toolbar">
                    <button type="button" class="ui-button ui-button-primary" disabled={importDevices === undefined} onclick={doImport} data-testid="import">
                        {importDevices === undefined ? t('Import') : t('Import {count} devices', {count: Object.keys(importDevices).length})}
                    </button>
                    <Checkbox bind:checked={replace} label={t('replace every device')} />
                </div>
            </section>
        </div>
    </div>
</div>

<style>
    .columns {
        display: grid;
        grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
        gap: 10px;
        align-content: start;
    }

    .stack {
        display: flex;
        flex-direction: column;
        gap: 10px;
    }

    p {
        margin: 0;
    }

    @media (max-width: 900px) {
        .columns {
            grid-template-columns: minmax(0, 1fr);
        }
    }
</style>

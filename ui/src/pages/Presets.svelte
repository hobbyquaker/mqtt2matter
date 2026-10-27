<script lang="ts">
    import {onMount} from 'svelte';

    import {type Device, type Issue, type PresetEntry, api, errorMessage} from '../lib/api.ts';
    import Dialog from '../lib/components/Dialog.svelte';
    import Issues from '../lib/components/Issues.svelte';
    import {pretty} from '../lib/format.ts';
    import {t} from '../lib/i18n.svelte.ts';
    import {notices} from '../lib/notices.svelte.ts';
    import {router} from '../lib/router.svelte.ts';

    let presets = $state<PresetEntry[]>([]);
    let problems = $state<{file: string; message: string}[]>([]);
    let loaded = $state(false);

    let current = $state<PresetEntry | undefined>(undefined);
    let values = $state<Record<string, string>>({});
    let key = $state('');
    let result = $state<{device: Device; issues: Issue[]} | undefined>(undefined);
    let applying = $state(false);

    const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/;
    const keyValid = $derived(KEY_PATTERN.test(key));
    let query = $state('');

    /** every word of the query must occur in the preset's name, vendor, id or description */
    const shown = $derived.by(() => {
        const words = query
            .trim()
            .toLowerCase()
            .split(/\s+/)
            .filter((w) => w !== '');
        if (words.length === 0) {
            return presets;
        }
        return presets.filter((preset) => {
            const text = [preset.name, preset.vendor ?? '', preset.id, preset.description ?? ''].join(' ').toLowerCase();
            return words.every((word) => text.includes(word));
        });
    });
    const grouped = $derived.by(() => {
        const groups = new Map<string, PresetEntry[]>();
        for (const preset of shown) {
            const vendor = preset.vendor ?? t('Other');
            groups.set(vendor, [...(groups.get(vendor) ?? []), preset]);
        }
        return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
    });

    onMount(() => {
        api.presets()
            .then((library) => {
                presets = library.presets;
                problems = library.problems;
                loaded = true;
            })
            .catch((error: unknown) => notices.error(errorMessage(error)));
    });

    function open(preset: PresetEntry): void {
        current = preset;
        values = Object.fromEntries(Object.entries(preset.variables).map(([name, v]) => [name, v.default ?? '']));
        key = '';
        result = undefined;
    }

    async function preview(): Promise<void> {
        if (current === undefined) {
            return;
        }
        applying = true;
        try {
            result = await api.applyPreset(current.id, values);
            if (key === '') {
                key = result.device.name
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, '-')
                    .replace(/^-+|-+$/g, '');
            }
        } catch (error) {
            notices.error(errorMessage(error));
        } finally {
            applying = false;
        }
    }

    async function create(): Promise<void> {
        if (result === undefined || !keyValid) {
            return;
        }
        try {
            await api.saveDevice(key, result.device);
            notices.info(t('{name} created', {name: result.device.name}));
            current = undefined;
            router.go('devices', key);
        } catch (error) {
            notices.error(errorMessage(error));
        }
    }
</script>

<div class="ui-page" data-testid="presets-page">
    {#if presets.length > 0}
        <div class="ui-toolbar">
            <!-- svelte-ignore a11y_autofocus -->
            <input
                type="search"
                class="ui-input search"
                placeholder={t('Search presets')}
                aria-label={t('Search presets')}
                bind:value={query}
                autofocus
                data-testid="preset-search"
            />
            <div class="ui-toolbar-trailing">{t('{count} of {total} presets', {count: shown.length, total: presets.length})}</div>
        </div>
    {/if}
    <div class="ui-page-scroll">
        {#if loaded && presets.length === 0}
            <div class="ui-empty">{t('No presets. Put preset files into a directory named in the configuration.')}</div>
        {:else if presets.length > 0 && shown.length === 0}
            <div class="ui-empty" data-testid="preset-no-match">{t('No preset matches “{query}”.', {query: query.trim()})}</div>
        {/if}
        {#each grouped as [vendor, list] (vendor)}
            <section class="group">
                <h3>{vendor}</h3>
                <div class="cards">
                    {#each list as preset (preset.id)}
                        <button type="button" class="card" onclick={() => open(preset)} data-testid="preset" data-id={preset.id}>
                            <span class="name">{preset.name}</span>
                            {#if preset.description}<span class="ui-muted description">{preset.description}</span>{/if}
                            <span class="ui-faint ui-small"><code>{preset.id}</code>{preset.shipped ? '' : ` · ${t('own')}`}</span>
                        </button>
                    {/each}
                </div>
            </section>
        {/each}
        {#if problems.length > 0}
            <section class="ui-section">
                <div class="ui-section-title ui-warn-text">{t('Preset files with problems')}</div>
                {#each problems as problem (problem.file)}
                    <div class="ui-small"><code>{problem.file}</code>: {problem.message}</div>
                {/each}
            </section>
        {/if}
    </div>
</div>

{#if current}
    <Dialog open={true} title={current.name} width="640px" onclose={() => (current = undefined)} testId="preset-dialog">
        {#if current.description}<p class="ui-muted intro">{current.description}</p>{/if}
        <div class="ui-form">
            {#each Object.entries(current.variables) as [name, variable] (name)}
                <label class="ui-form-label" for="var-{name}">{variable.label}</label>
                <div class="ui-form-field">
                    <input
                        id="var-{name}"
                        class="ui-input"
                        bind:value={values[name]}
                        placeholder={variable.optional ? t('optional') : ''}
                        data-testid="preset-var-{name}"
                    />
                </div>
                {#if variable.description}<div class="ui-form-help">{variable.description}</div>{/if}
            {/each}
            <span></span>
            <div class="ui-form-field">
                <button type="button" class="ui-button" disabled={applying} onclick={preview} data-testid="preset-preview">{t('Preview')}</button>
            </div>
        </div>
        {#if result}
            <div class="ui-form">
                <label class="ui-form-label" for="preset-key">{t('Key')}</label>
                <div class="ui-form-field">
                    <input id="preset-key" class="ui-input ui-mono" class:ui-invalid={!keyValid} bind:value={key} data-testid="preset-key" />
                </div>
            </div>
            <Issues issues={result.issues} empty={t('The device validates.')} />
            <pre class="ui-pre">{pretty(result.device)}</pre>
        {/if}
        {#snippet buttons()}
            <button type="button" class="ui-button" onclick={() => (current = undefined)}>{t('Cancel')}</button>
            <button type="button" class="ui-button ui-button-primary" disabled={result === undefined || !keyValid} onclick={create} data-testid="preset-create">
                {t('Create device')}
            </button>
        {/snippet}
    </Dialog>
{/if}

<style>
    .search {
        width: 320px;
        max-width: 100%;
    }

    .group {
        margin-bottom: 14px;
    }

    .group h3 {
        margin-bottom: 6px;
        color: var(--ui-fg-muted);
    }

    .cards {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
        gap: 8px;
    }

    .card {
        display: flex;
        flex-direction: column;
        gap: 3px;
        align-items: flex-start;
        text-align: left;
        padding: 8px 10px;
        border: 1px solid var(--ui-border);
        border-radius: var(--ui-radius);
        background: var(--ui-bg);
        color: var(--ui-fg);
        cursor: pointer;
    }

    .card:hover {
        background: var(--ui-row-hover);
        border-color: var(--ui-border-strong);
    }

    .name {
        font-weight: 600;
    }

    .description {
        font-size: var(--ui-font-size-grid);
    }

    .intro {
        margin: 0;
    }
</style>

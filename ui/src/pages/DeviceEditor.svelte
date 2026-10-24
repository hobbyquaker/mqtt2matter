<script lang="ts">
    import {onMount} from 'svelte';

    import {
        type Binding,
        type BridgeInfo,
        type Catalog,
        type Device,
        type DeviceDetail,
        type Endpoint,
        type EndpointState,
        type Issue,
        api,
        errorMessage,
    } from '../lib/api.ts';
    import Checkbox from '../lib/components/Checkbox.svelte';
    import Issues from '../lib/components/Issues.svelte';
    import {dialogs} from '../lib/dialogs.svelte.ts';
    import {events} from '../lib/events.svelte.ts';
    import {debounce, download, formatValue, isRecord, pretty, tryJson} from '../lib/format.ts';
    import {t} from '../lib/i18n.svelte.ts';
    import {
        FAMILY_CLUSTERS,
        OPTION_CHOICES,
        SUGGESTED,
        type Suggestion,
        bindingTarget,
        boundClusters,
        cleanDevice,
        clusterOf,
        emptyBinding,
        emptyEndpoint,
        familiesFor,
    } from '../lib/model.ts';
    import {notices} from '../lib/notices.svelte.ts';
    import BindingEditor from './BindingEditor.svelte';

    interface Props {
        key: string;
        onclose: () => void;
    }

    let {key, onclose}: Props = $props();

    let detail = $state<DeviceDetail | undefined>(undefined);
    let device = $state<Device | undefined>(undefined);
    let catalog = $state<Catalog | undefined>(undefined);
    let bridges = $state<BridgeInfo[]>([]);
    let liveState = $state<EndpointState | undefined>(undefined);
    let issues = $state<Issue[]>([]);
    let dirty = $state(false);
    let saving = $state(false);
    let checking = $state(false);
    let checkIssues = $state<Issue[] | undefined>(undefined);
    let view = $state<'form' | 'json'>('form');
    let jsonText = $state('');
    let availabilityOn = $state(false);

    // the binding editor
    let editing = $state<{endpoint: number; index: number; binding: Binding} | undefined>(undefined);
    let addType = $state<Record<number, string>>({});

    const jsonParsed = $derived(tryJson(jsonText));
    const typeNames = $derived(
        (catalog?.deviceTypes ?? []).filter((d) => d.classification !== 'node' && d.name !== 'RootNode' && d.name !== 'Aggregator').map((d) => d.name),
    );

    function clustersOf(endpoint: Endpoint): {cluster: string; mandatory: boolean}[] {
        const result = new Map<string, boolean>();
        for (const name of endpoint.deviceTypes) {
            for (const requirement of catalog?.deviceTypes.find((d) => d.name === name)?.clusters ?? []) {
                if (requirement.cluster === 'Identify' || requirement.cluster === 'Groups' || requirement.cluster === 'ScenesManagement') {
                    continue;
                }
                result.set(requirement.cluster, (result.get(requirement.cluster) ?? false) || requirement.mandatory);
            }
        }
        for (const cluster of boundClusters(endpoint)) {
            if (!result.has(cluster)) {
                result.set(cluster, false);
            }
        }
        return [...result.entries()].map(([cluster, mandatory]) => ({cluster, mandatory})).sort((a, b) => Number(b.mandatory) - Number(a.mandatory));
    }

    function endpointClusters(endpoint: Endpoint): string[] {
        return clustersOf(endpoint).map((c) => c.cluster);
    }

    function suggestionsFor(endpoint: Endpoint): {cluster: string; mandatory: boolean; targets: Suggestion[]}[] {
        const bound = new Set(endpoint.bindings.map((b) => bindingTarget(b).name));
        return clustersOf(endpoint)
            .map(({cluster, mandatory}) => ({
                cluster,
                mandatory,
                targets: (SUGGESTED[cluster] ?? []).filter((s) => !bound.has(s.name)),
            }))
            .filter((c) => c.targets.length > 0);
    }

    function familyOptions(endpoint: Endpoint): {family: string; options: Record<string, unknown>}[] {
        const clusters = new Set([...endpointClusters(endpoint), ...boundClusters(endpoint)]);
        return familiesFor(clusters).map((family) => ({family, options: endpoint.options[family] ?? {}}));
    }

    const validate = debounce(() => {
        if (device === undefined) {
            return;
        }
        api.validate(cleanDevice(device)).then(
            (result) => (issues = result.issues),
            () => undefined,
        );
    }, 300);

    function changed(): void {
        dirty = true;
        validate();
    }

    async function load(): Promise<void> {
        try {
            detail = await api.device(key);
            device = structuredClone(detail.device);
            issues = detail.issues;
            liveState = detail.state;
            availabilityOn = device.availability !== undefined;
            dirty = false;
            jsonText = pretty(device);
        } catch (error) {
            notices.error(errorMessage(error));
            onclose();
        }
    }

    onMount(() => {
        void load();
        void api.catalog().then((c) => (catalog = c));
        void api.bridges().then((b) => (bridges = b));
        return events.on((event) => {
            if (event.type === 'attribute' && event.key === key && liveState !== undefined) {
                const endpoint = liveState[event.endpoint];
                if (endpoint !== undefined) {
                    endpoint.state[event.cluster] = {...(endpoint.state[event.cluster] ?? {}), [event.attribute]: event.value};
                }
            }
        });
    });

    async function save(): Promise<void> {
        if (device === undefined) {
            return;
        }
        saving = true;
        try {
            const saved = await api.saveDevice(key, cleanDevice(device));
            detail = saved;
            device = structuredClone(saved.device);
            issues = saved.issues;
            liveState = saved.state;
            dirty = false;
            jsonText = pretty(device);
            notices.info(saved.built ? t('{name} saved and built', {name: saved.device.name}) : t('{name} saved', {name: saved.device.name}));
        } catch (error) {
            notices.error(errorMessage(error));
        } finally {
            saving = false;
        }
    }

    async function check(): Promise<void> {
        if (device === undefined) {
            return;
        }
        checking = true;
        try {
            const result = await api.check({[key]: cleanDevice(device)});
            checkIssues = result.devices[key] ?? [];
        } catch (error) {
            notices.error(errorMessage(error));
        } finally {
            checking = false;
        }
    }

    async function back(): Promise<void> {
        if (dirty && !(await dialogs.confirm(t('Discard the unsaved changes?'), {confirm: t('Discard'), danger: true}))) {
            return;
        }
        onclose();
    }

    function applyJson(): void {
        if (!isRecord(jsonParsed)) {
            return;
        }
        device = jsonParsed as unknown as Device;
        availabilityOn = device.availability !== undefined;
        view = 'form';
        changed();
    }

    function exportDevice(): void {
        if (device !== undefined) {
            download(`${key}.json`, pretty({[key]: cleanDevice(device)}));
        }
    }

    // ── endpoints and bindings ────────────────────────────────────────────────────────────────

    function addEndpoint(): void {
        if (device === undefined) {
            return;
        }
        const id = `child${device.endpoints.length}`;
        device.endpoints.push(emptyEndpoint(id, ['TemperatureSensor']));
        changed();
    }

    async function removeEndpoint(index: number): Promise<void> {
        if (device === undefined || index === 0) {
            return;
        }
        if (await dialogs.confirm(t('Remove this endpoint and its bindings?'), {confirm: t('Remove'), danger: true})) {
            device.endpoints.splice(index, 1);
            changed();
        }
    }

    function addDeviceType(index: number): void {
        const name = addType[index];
        const endpoint = device?.endpoints[index];
        if (endpoint === undefined || name === undefined || name === '' || endpoint.deviceTypes.includes(name)) {
            return;
        }
        endpoint.deviceTypes.push(name);
        addType[index] = '';
        changed();
    }

    function removeDeviceType(index: number, name: string): void {
        const endpoint = device?.endpoints[index];
        if (endpoint === undefined || endpoint.deviceTypes.length <= 1) {
            return;
        }
        endpoint.deviceTypes = endpoint.deviceTypes.filter((d) => d !== name);
        changed();
    }

    function openBinding(endpoint: number, index: number, binding: Binding): void {
        editing = {endpoint, index, binding};
    }

    function newBinding(endpoint: number, target: Suggestion): void {
        editing = {endpoint, index: -1, binding: emptyBinding(target)};
    }

    function saveBinding(binding: Binding): void {
        if (editing === undefined || device === undefined) {
            return;
        }
        const endpoint = device.endpoints[editing.endpoint];
        if (endpoint === undefined) {
            return;
        }
        if (editing.index === -1) {
            endpoint.bindings.push(binding);
        } else {
            endpoint.bindings[editing.index] = binding;
        }
        editing = undefined;
        changed();
    }

    function removeBinding(endpoint: number, index: number): void {
        device?.endpoints[endpoint]?.bindings.splice(index, 1);
        changed();
    }

    function duplicateBinding(endpoint: number, index: number): void {
        const bindings = device?.endpoints[endpoint]?.bindings;
        const binding = bindings?.[index];
        if (bindings !== undefined && binding !== undefined) {
            bindings.splice(index + 1, 0, structuredClone($state.snapshot(binding)));
            changed();
        }
    }

    function setOption(endpoint: Endpoint, family: string, name: string, value: unknown): void {
        endpoint.options[family] = {...(endpoint.options[family] ?? {}), [name]: value};
        changed();
    }

    function optionKeys(family: string): string[] {
        const known: Record<string, string[]> = {
            light: ['onCommandType', 'transition', 'minMireds', 'maxMireds'],
            cover: ['echoFilter', 'reportTimeout', 'tolerance'],
            climate: ['minHeat', 'maxHeat', 'minCool', 'maxCool', 'deadband'],
            fan: ['low', 'medium', 'speedMax'],
            switch: ['kind', 'numberOfPositions', 'multiPressMax', 'multiPressDelay', 'longPressDelay', 'pressDuration'],
            powerSource: ['warning', 'critical'],
        };
        return known[family] ?? [];
    }

    const OPTION_DEFAULTS: Record<string, Record<string, unknown>> = {
        light: {onCommandType: 'last', transition: true, minMireds: 153, maxMireds: 500},
        cover: {echoFilter: false, reportTimeout: 30, tolerance: 100},
        climate: {minHeat: 7, maxHeat: 30, minCool: 16, maxCool: 32, deadband: 2},
        fan: {low: 33, medium: 66, speedMax: 0},
        switch: {kind: 'momentary', numberOfPositions: 2, multiPressMax: 3, multiPressDelay: 300, longPressDelay: 500, pressDuration: 50},
        powerSource: {warning: 20, critical: 10},
    };

    function toggleAvailability(on: boolean): void {
        if (device === undefined) {
            return;
        }
        availabilityOn = on;
        if (on) {
            device.availability ??= {mode: 'latest', topics: [{topic: '', online: 'online', offline: 'offline'}]};
        } else {
            delete device.availability;
        }
        changed();
    }

    function halfSummary(binding: Binding, half: 'status' | 'command'): string {
        const h = binding[half];
        if (h === undefined) {
            return '';
        }
        const parts = [h.topic];
        if ('extract' in h && h.extract !== undefined) {
            parts.push(h.extract);
        }
        if (h.unit !== undefined) {
            parts.push(h.unit);
        }
        if ('map' in h && h.map !== undefined) {
            parts.push(t('map'));
        }
        if ('format' in h && h.format !== undefined) {
            parts.push(t('format'));
        }
        if (h.template !== undefined) {
            parts.push(t('template'));
        }
        return parts.join(' · ');
    }
</script>

<div class="ui-page" data-testid="device-editor">
    <div class="ui-toolbar">
        <button type="button" class="ui-button" onclick={back} data-testid="editor-back">← {t('Devices')}</button>
        <h2 class="title">{device?.name ?? key} <code class="ui-faint">{key}</code></h2>
        {#if detail}
            {#if detail.built}
                <span class="ui-badge ui-badge-ok">{t('endpoint {number}', {number: detail.number})}</span>
            {:else if device?.enabled === false}
                <span class="ui-badge">{t('disabled')}</span>
            {:else}
                <span class="ui-badge ui-badge-warn">{t('not built')}</span>
            {/if}
            {#if detail.bridge}<span class="ui-badge">{detail.bridge}</span>{/if}
        {/if}
        <div class="ui-toolbar-trailing">
            <button type="button" class="ui-button" class:ui-button-primary={view === 'form'} onclick={() => (view = 'form')}>{t('Form')}</button>
            <button
                type="button"
                class="ui-button"
                class:ui-button-primary={view === 'json'}
                onclick={() => {
                    jsonText = device === undefined ? '' : pretty(cleanDevice(device));
                    view = 'json';
                }}
                data-testid="view-json">JSON</button
            >
            <button type="button" class="ui-button" onclick={exportDevice}>{t('Export')}</button>
            <button type="button" class="ui-button" disabled={checking} onclick={check} data-testid="check-device"
                >{checking ? t('Checking…') : t('Check')}</button
            >
            <button type="button" class="ui-button ui-button-primary" disabled={saving || !dirty} onclick={save} data-testid="save-device">{t('Save')}</button>
        </div>
    </div>

    {#if device && catalog}
        {#if view === 'json'}
            <div class="ui-page-scroll column">
                <textarea class="ui-textarea json" bind:value={jsonText} spellcheck="false" data-testid="device-json"></textarea>
                <div class="ui-toolbar">
                    <button type="button" class="ui-button ui-button-primary" disabled={!isRecord(jsonParsed)} onclick={applyJson} data-testid="apply-json"
                        >{t('Apply to the form')}</button
                    >
                    {#if !isRecord(jsonParsed)}<span class="ui-error-text">{t('Not valid JSON')}</span>{/if}
                </div>
            </div>
        {:else}
            <div class="ui-page-scroll column">
                <Issues {issues} empty={t('The device validates.')} />
                {#if checkIssues}
                    <section class="ui-section">
                        <div class="ui-section-title">{t('Strict dry run')}</div>
                        <Issues issues={checkIssues} empty={t('matter.js builds the device without complaint.')} />
                    </section>
                {/if}
                <div class="ui-split">
                    <section class="ui-section">
                        <div class="ui-section-title">{t('Device')}</div>
                        <div class="ui-form">
                            <label class="ui-form-label" for="dev-name">{t('Name')}</label>
                            <div class="ui-form-field">
                                <input id="dev-name" class="ui-input" maxlength="32" bind:value={device.name} oninput={changed} data-testid="device-name" />
                            </div>
                            <label class="ui-form-label" for="dev-vendor">{t('Vendor')}</label>
                            <div class="ui-form-field">
                                <input id="dev-vendor" class="ui-input" maxlength="32" bind:value={device.vendor} oninput={changed} />
                            </div>
                            <label class="ui-form-label" for="dev-model">{t('Model')}</label>
                            <div class="ui-form-field">
                                <input id="dev-model" class="ui-input" maxlength="32" bind:value={device.model} oninput={changed} />
                            </div>
                            <label class="ui-form-label" for="dev-serial">{t('Serial')}</label>
                            <div class="ui-form-field">
                                <input id="dev-serial" class="ui-input" maxlength="32" placeholder={key} bind:value={device.serial} oninput={changed} />
                            </div>
                            <label class="ui-form-label" for="dev-bridge">{t('Bridge')}</label>
                            <div class="ui-form-field">
                                <select id="dev-bridge" class="ui-select ui-field-medium" bind:value={device.bridge} onchange={changed}>
                                    <option value={undefined}>{t('assigned automatically')}</option>
                                    {#each bridges as bridge (bridge.id)}<option value={bridge.id}>{bridge.id}</option>{/each}
                                </select>
                            </div>
                            <span class="ui-form-label">{t('Enabled')}</span>
                            <div class="ui-form-field"><Checkbox bind:checked={device.enabled} onchange={changed} testId="device-enabled" /></div>
                            <span class="ui-form-label">{t('Source')}</span>
                            <div class="ui-form-field">
                                <span class="ui-badge" class:ui-badge-accent={device.source.kind !== 'manual'}>{device.source.kind}</span>
                                {#if device.source.key}<code>{device.source.key}</code>{/if}
                                {#if device.source.orphaned}<span class="ui-badge ui-badge-warn">{t('orphaned')}</span>{/if}
                            </div>
                        </div>
                    </section>
                    <section class="ui-section">
                        <div class="ui-section-title">
                            <Checkbox checked={availabilityOn} label={t('Availability')} onchange={toggleAvailability} />
                        </div>
                        {#if device.availability}
                            <div class="ui-form">
                                <label class="ui-form-label" for="av-mode">{t('Mode')}</label>
                                <div class="ui-form-field">
                                    <select id="av-mode" class="ui-select ui-field-medium" bind:value={device.availability.mode} onchange={changed}>
                                        <option value="latest">latest</option><option value="all">all</option><option value="any">any</option>
                                    </select>
                                </div>
                                {#each device.availability.topics as topic, index (index)}
                                    <label class="ui-form-label" for="av-topic-{index}">{t('Topic')}</label>
                                    <div class="ui-form-field">
                                        <input id="av-topic-{index}" class="ui-input ui-mono" bind:value={topic.topic} oninput={changed} />
                                        <input
                                            class="ui-input ui-mono ui-field-narrow"
                                            placeholder={t('extract')}
                                            bind:value={topic.extract}
                                            oninput={changed}
                                        />
                                        <input class="ui-input ui-field-narrow" bind:value={topic.online} oninput={changed} />
                                        <input class="ui-input ui-field-narrow" bind:value={topic.offline} oninput={changed} />
                                        <button
                                            type="button"
                                            class="ui-icon-button"
                                            title={t('Remove')}
                                            onclick={() => {
                                                device?.availability?.topics.splice(index, 1);
                                                changed();
                                            }}>✕</button
                                        >
                                    </div>
                                {/each}
                                <span></span>
                                <div>
                                    <button
                                        type="button"
                                        class="ui-button"
                                        onclick={() => {
                                            device?.availability?.topics.push({topic: '', online: 'online', offline: 'offline'});
                                            changed();
                                        }}>+ {t('Topic')}</button
                                    >
                                </div>
                                <div class="ui-form-help">{t('topic · JSON path · the online payload · the offline payload')}</div>
                            </div>
                        {:else}
                            <div class="ui-muted">
                                {t('Without an availability topic the device counts as reachable while it reports (see expire on a status half).')}
                            </div>
                        {/if}
                    </section>
                </div>

                {#each device.endpoints as endpoint, ei (ei)}
                    <section class="ui-section" data-testid="endpoint" data-id={endpoint.id}>
                        <div class="ui-section-title">
                            {ei === 0 ? t('Endpoint (the bridged node)') : t('Child endpoint')}
                            <input
                                class="ui-input ui-mono ui-field-medium"
                                bind:value={endpoint.id}
                                oninput={changed}
                                disabled={ei === 0 && endpoint.id === 'main'}
                            />
                            {#if liveState?.[endpoint.id]?.number !== undefined}<span class="ui-badge">#{liveState[endpoint.id]?.number}</span>{/if}
                            <div class="ui-toolbar-trailing">
                                <label class="ui-muted" for="coalesce-{ei}">{t('coalesce (ms)')}</label>
                                <input
                                    id="coalesce-{ei}"
                                    class="ui-input ui-field-narrow"
                                    type="number"
                                    min="0"
                                    max="5000"
                                    bind:value={endpoint.coalesce}
                                    oninput={changed}
                                />
                                {#if ei > 0}<button type="button" class="ui-icon-button" title={t('Remove')} onclick={() => removeEndpoint(ei)}>🗑</button>{/if}
                            </div>
                        </div>
                        <div class="types">
                            <span class="ui-muted">{t('Device types')}:</span>
                            {#each endpoint.deviceTypes as name (name)}
                                <span class="chip" data-testid="device-type-chip">
                                    {name}
                                    {#if endpoint.deviceTypes.length > 1}<button
                                            type="button"
                                            class="chip-remove"
                                            title={t('Remove')}
                                            onclick={() => removeDeviceType(ei, name)}>✕</button
                                        >{/if}
                                </span>
                            {/each}
                            <select class="ui-select ui-field-medium" bind:value={addType[ei]} onchange={() => addDeviceType(ei)} data-testid="add-device-type">
                                <option value="">+ {t('add type')}</option>
                                {#each typeNames as name (name)}<option value={name}>{name}</option>{/each}
                            </select>
                        </div>

                        {#each familyOptions(endpoint) as { family, options } (family)}
                            <div class="options">
                                <span class="ui-muted">{t('Options')} {family} ({FAMILY_CLUSTERS[family]?.join(', ')}):</span>
                                {#each optionKeys(family) as name (name)}
                                    {@const value = options[name] ?? OPTION_DEFAULTS[family]?.[name]}
                                    {@const choices = OPTION_CHOICES[family]?.[name]}
                                    <label class="option">
                                        <span class="ui-muted">{name}</span>
                                        {#if choices}
                                            <select
                                                class="ui-select"
                                                value={String(value)}
                                                onchange={(e) => setOption(endpoint, family, name, e.currentTarget.value)}
                                            >
                                                {#each choices as choice (choice)}<option value={choice}>{choice}</option>{/each}
                                            </select>
                                        {:else if typeof value === 'boolean'}
                                            <input
                                                type="checkbox"
                                                checked={value}
                                                onchange={(e) => setOption(endpoint, family, name, e.currentTarget.checked)}
                                            />
                                        {:else}
                                            <input
                                                class="ui-input ui-field-narrow"
                                                type="number"
                                                step="any"
                                                value={value as number}
                                                onchange={(e) => setOption(endpoint, family, name, Number(e.currentTarget.value))}
                                            />
                                        {/if}
                                    </label>
                                {/each}
                            </div>
                        {/each}

                        <table class="ui-table" data-testid="bindings">
                            <thead>
                                <tr
                                    ><th>{t('Target')}</th><th>{t('Status (device → Matter)')}</th><th>{t('Command (Matter → device)')}</th><th>{t('Live')}</th
                                    ><th></th></tr
                                >
                            </thead>
                            <tbody>
                                {#each endpoint.bindings as binding, bi (bi)}
                                    {@const target = bindingTarget(binding)}
                                    {@const live = liveState?.[endpoint.id]?.state[clusterOf(target.name)]?.[target.name.split('.')[1] ?? '']}
                                    <tr class="ui-row-link" onclick={() => openBinding(ei, bi, binding)} data-testid="binding-row">
                                        <td>
                                            <code>{target.name}</code>
                                            {#if target.kind !== 'attribute'}<span class="ui-badge">{target.kind}</span>{/if}
                                            {#if binding.comment}<span class="ui-faint"> — {binding.comment}</span>{/if}
                                        </td>
                                        <td><code>{halfSummary(binding, 'status')}</code></td>
                                        <td><code>{halfSummary(binding, 'command')}</code></td>
                                        <td><code>{formatValue(live)}</code></td>
                                        <td class="ui-actions" onclick={(event) => event.stopPropagation()}>
                                            <button type="button" class="ui-icon-button" title={t('Duplicate')} onclick={() => duplicateBinding(ei, bi)}
                                                >⧉</button
                                            >
                                            <button
                                                type="button"
                                                class="ui-icon-button"
                                                title={t('Remove')}
                                                onclick={() => removeBinding(ei, bi)}
                                                data-testid="remove-binding">🗑</button
                                            >
                                        </td>
                                    </tr>
                                {/each}
                                {#each suggestionsFor(endpoint) as group (group.cluster)}
                                    <tr class="suggestion" data-testid="suggestion-row">
                                        <td colspan="4">
                                            <span class="ui-muted">{group.cluster}</span>
                                            {#if group.mandatory}<span class="ui-badge ui-badge-warn">{t('mandatory')}</span>{/if}
                                            {#each group.targets as target (target.name)}
                                                <button
                                                    type="button"
                                                    class="ui-button suggest"
                                                    onclick={() => newBinding(ei, target)}
                                                    data-testid="bind-suggestion"
                                                    data-target={target.name}
                                                >
                                                    + {target.name}{target.kind !== 'attribute' ? ` (${target.kind})` : ''}
                                                </button>
                                            {/each}
                                        </td>
                                        <td></td>
                                    </tr>
                                {/each}
                            </tbody>
                        </table>
                        <div>
                            <button type="button" class="ui-button" onclick={() => newBinding(ei, {kind: 'attribute', name: ''})} data-testid="add-binding"
                                >+ {t('Binding')}</button
                            >
                        </div>
                    </section>
                {/each}
                <div><button type="button" class="ui-button" onclick={addEndpoint} data-testid="add-endpoint">+ {t('Child endpoint')}</button></div>
            </div>
        {/if}

        {#if editing}
            {@const endpoint = device.endpoints[editing.endpoint]}
            <BindingEditor
                open={true}
                binding={editing.binding}
                {catalog}
                endpointClusters={endpoint === undefined ? [] : endpointClusters(endpoint)}
                onsave={saveBinding}
                onclose={() => (editing = undefined)}
            />
        {/if}
    {:else}
        <div class="ui-empty">{t('Loading')}…</div>
    {/if}
</div>

<style>
    .title {
        display: flex;
        align-items: baseline;
        gap: 8px;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
    }

    .column {
        display: flex;
        flex-direction: column;
        gap: 10px;
    }

    .json {
        flex: 1 1 auto;
        min-height: 300px;
    }

    .types,
    .options {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 6px;
    }

    .chip {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 1px 8px;
        border: 1px solid var(--ui-accent);
        border-radius: 999px;
        color: var(--ui-accent);
        font-size: var(--ui-font-size-grid);
    }

    .chip-remove {
        border: none;
        background: none;
        color: inherit;
        cursor: pointer;
        padding: 0;
        line-height: 1;
    }

    .option {
        display: inline-flex;
        align-items: center;
        gap: 4px;
    }

    .option .ui-select {
        width: auto;
    }

    .suggestion td {
        height: auto;
        padding: 4px 8px;
        white-space: normal;
        background: var(--ui-bg-sunken);
    }

    .suggest {
        margin: 2px 2px 2px 4px;
        font-size: var(--ui-font-size-small);
        min-height: 20px;
        padding: 1px 6px;
    }
</style>

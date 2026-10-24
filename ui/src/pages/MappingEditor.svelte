<script lang="ts">
    import {onMount} from 'svelte';

    import {type Mapping, type Catalog, type ClusterInfo, type CommandHalf, type Preview, type StatusHalf, api, errorMessage} from '../lib/api.ts';
    import Checkbox from '../lib/components/Checkbox.svelte';
    import Dialog from '../lib/components/Dialog.svelte';
    import {debounce, formatValue} from '../lib/format.ts';
    import {t} from '../lib/i18n.svelte.ts';
    import {type Suggestion, mappingTarget, cleanMapping, clusterOf, scalarOf, valueOf} from '../lib/model.ts';
    import {notices} from '../lib/notices.svelte.ts';
    import TopicPicker from './TopicPicker.svelte';

    interface Props {
        open: boolean;
        mapping: Mapping;
        catalog: Catalog;
        /** the clusters of the endpoint's device types, offered first */
        endpointClusters: string[];
        onsave: (mapping: Mapping) => void;
        onclose: () => void;
    }

    let {open, mapping, catalog, endpointClusters, onsave, onclose}: Props = $props();

    // the editable copy
    let kind = $state<Suggestion['kind']>('attribute');
    let cluster = $state('');
    let member = $state('');
    let comment = $state('');
    let status = $state<StatusHalf | undefined>(undefined);
    let command = $state<CommandHalf | undefined>(undefined);
    let mapRows = $state<{key: string; value: string}[]>([]);
    let formatRows = $state<{key: string; value: string}[]>([]);
    let optimistic = $state<'auto' | 'true' | 'false'>('auto');
    let clusterInfo = $state<ClusterInfo | undefined>(undefined);

    // the preview
    let statusPayload = $state('');
    let statusPreview = $state<Preview | undefined>(undefined);
    let commandValue = $state('');
    let commandPreview = $state<Preview | undefined>(undefined);
    let picker = $state<'status' | 'command' | 'get' | undefined>(undefined);

    const target = $derived(cluster === '' || member === '' ? '' : kind === 'event' ? cluster : `${cluster}.${member}`);
    const clusters = $derived([...endpointClusters, ...catalog.clusters.filter((c) => !endpointClusters.includes(c))]);
    const attributeInfo = $derived(clusterInfo?.attributes.find((a) => a.name === member));
    const composite = $derived(catalog.composites[target]);
    const members = $derived.by(() => {
        if (kind === 'event') {
            return [];
        }
        if (kind === 'invoke') {
            return (clusterInfo?.commands ?? []).map((c) => ({name: c.name, hint: c.fields.join(', ')}));
        }
        const own = (clusterInfo?.attributes ?? []).map((a) => ({
            name: a.name,
            hint: `${a.metatype}${a.writable ? ` · ${t('writable')}` : ''}${a.conformance === 'M' ? ` · ${t('mandatory')}` : ''}`,
        }));
        const composites = Object.entries(catalog.composites)
            .filter(([, c]) => c.cluster === cluster)
            .map(([name, c]) => ({name: name.split('.')[1] ?? name, hint: c.description}));
        return [...composites, ...own];
    });
    const enumMembers = $derived(attributeInfo?.enumMembers === undefined ? [] : Object.keys(attributeInfo.enumMembers));

    $effect(() => {
        if (!open) {
            return;
        }
        const current = mappingTarget(mapping);
        kind = current.kind;
        cluster = current.kind === 'event' ? current.name || 'Switch' : clusterOf(current.name);
        member = current.kind === 'event' ? 'Switch' : (current.name.split('.')[1] ?? '');
        comment = mapping.comment ?? '';
        status = mapping.status === undefined ? undefined : structuredClone($state.snapshot(mapping.status));
        command = mapping.command === undefined ? undefined : structuredClone($state.snapshot(mapping.command));
        mapRows = Object.entries(mapping.status?.map ?? {}).map(([key, value]) => ({key, value: String(value)}));
        formatRows = Object.entries(mapping.command?.format ?? {}).map(([key, value]) => ({key, value}));
        optimistic = mapping.command?.optimistic === undefined ? 'auto' : mapping.command.optimistic ? 'true' : 'false';
        statusPreview = undefined;
        commandPreview = undefined;
        commandValue = '';
        statusPayload = '';
        void loadLastPayload(mapping.status?.topic);
    });

    $effect(() => {
        if (cluster === '' || kind === 'event') {
            clusterInfo = undefined;
            return;
        }
        const wanted = cluster;
        api.cluster(wanted).then(
            (info) => {
                if (wanted === cluster) {
                    clusterInfo = info;
                }
            },
            () => {
                clusterInfo = undefined;
            },
        );
    });

    /** the last payload seen on the status topic, as the preview's input while the box is empty */
    async function loadLastPayload(topic: string | undefined): Promise<void> {
        if (topic === undefined || topic === '') {
            return;
        }
        try {
            const entry = (await api.topics(topic)).find((e) => e.topic === topic);
            if (entry !== undefined && statusPayload === '') {
                statusPayload = entry.payload;
                runStatusPreview();
            }
        } catch {
            // the preview starts empty
        }
    }

    function assemble(): Mapping {
        const out: Mapping = {};
        if (kind === 'attribute') {
            out.attribute = target;
        } else if (kind === 'invoke') {
            out.invoke = target;
        } else {
            out.event = cluster;
        }
        if (comment !== '') {
            out.comment = comment;
        }
        if (status !== undefined) {
            const half: StatusHalf = {...$state.snapshot(status)};
            const map = Object.fromEntries(mapRows.filter((r) => r.key !== '').map((r) => [r.key, scalarOf(r.value)]));
            if (Object.keys(map).length > 0) {
                half.map = map;
            } else {
                delete half.map;
            }
            if (half.default !== undefined && typeof half.default === 'string') {
                half.default = scalarOf(half.default);
            }
            out.status = half;
        }
        if (command !== undefined) {
            const half: CommandHalf = {...$state.snapshot(command)};
            const format = Object.fromEntries(formatRows.filter((r) => r.key !== '').map((r) => [r.key, r.value]));
            if (Object.keys(format).length > 0) {
                half.format = format;
            } else {
                delete half.format;
            }
            if (optimistic === 'auto') {
                delete half.optimistic;
            } else {
                half.optimistic = optimistic === 'true';
            }
            out.command = half;
        }
        return cleanMapping(out);
    }

    const runStatusPreview = debounce(() => {
        const assembled = assemble();
        if (assembled.status === undefined) {
            statusPreview = undefined;
            return;
        }
        api.previewStatus(assembled.status, statusPayload, assembled.attribute).then(
            (preview) => (statusPreview = preview),
            (error: unknown) => {
                statusPreview = {stages: [], ok: false, reason: errorMessage(error)};
            },
        );
    }, 250);

    const runCommandPreview = debounce(() => {
        const assembled = assemble();
        if (assembled.command === undefined) {
            commandPreview = undefined;
            return;
        }
        api.previewCommand(assembled.command, valueOf(commandValue), assembled.attribute).then(
            (preview) => (commandPreview = preview),
            (error: unknown) => {
                commandPreview = {stages: [], ok: false, reason: errorMessage(error)};
            },
        );
    }, 250);

    function changed(): void {
        runStatusPreview();
        runCommandPreview();
    }

    async function publish(topic: string | undefined, payload: unknown): Promise<void> {
        if (topic === undefined || topic === '' || typeof payload !== 'string') {
            return;
        }
        try {
            await api.publish(topic, payload);
            notices.info(t('Published to {topic}', {topic}));
        } catch (error) {
            notices.error(errorMessage(error));
        }
    }

    function enableStatus(on: boolean): void {
        status = on ? {topic: ''} : undefined;
        changed();
    }

    function enableCommand(on: boolean): void {
        command = on ? {topic: ''} : undefined;
        changed();
    }

    function scaleOf(half: StatusHalf | CommandHalf): {from: [number, number]; to: [number, number]; clamp?: boolean} {
        half.scale ??= {from: [0, 100], to: [0, 100]};
        return half.scale;
    }

    function toggleScale(half: StatusHalf | CommandHalf, on: boolean): void {
        if (on) {
            scaleOf(half);
        } else {
            delete half.scale;
        }
        changed();
    }

    function pick(topic: string, extract?: string): void {
        if (picker === 'status' && status !== undefined) {
            status.topic = topic;
            if (extract !== undefined) {
                status.extract = extract;
            }
            void loadLastPayload(topic);
        } else if (picker === 'command' && command !== undefined) {
            command.topic = topic;
        } else if (picker === 'get' && status !== undefined) {
            status.get = {topic, payload: status.get?.payload ?? ''};
        }
        picker = undefined;
        changed();
    }

    function save(): void {
        if (target === '' || (status === undefined && command === undefined)) {
            return;
        }
        onsave(assemble());
    }

    function numberOrUndefined(text: string): number | undefined {
        return text === '' ? undefined : Number(text);
    }

    onMount(() => () => undefined);
</script>

<Dialog {open} title={target === '' ? t('Mapping') : target} width="980px" {onclose} testId="mapping-editor">
    <div class="ui-form compact">
        <span class="ui-form-label">{t('Kind')}</span>
        <div class="ui-form-field">
            <select
                class="ui-select ui-field-medium"
                bind:value={kind}
                onchange={() => {
                    member = kind === 'event' ? 'Switch' : '';
                    if (kind === 'event') cluster = 'Switch';
                    changed();
                }}
                data-testid="mapping-kind"
            >
                <option value="attribute">{t('attribute')}</option>
                <option value="invoke">{t('command (invoke)')}</option>
                <option value="event">{t('event channel')}</option>
            </select>
            {#if kind === 'event'}
                <select class="ui-select ui-field-medium" bind:value={cluster} onchange={changed}>
                    {#each catalog.eventChannels as channel (channel)}<option value={channel}>{channel}</option>{/each}
                </select>
            {:else}
                <select
                    class="ui-select ui-field-medium"
                    bind:value={cluster}
                    onchange={() => {
                        member = '';
                        changed();
                    }}
                    data-testid="mapping-cluster"
                >
                    <option value="">{t('— cluster —')}</option>
                    {#each clusters as name (name)}<option value={name}>{name}</option>{/each}
                </select>
                <select class="ui-select" bind:value={member} onchange={changed} data-testid="mapping-member">
                    <option value="">{kind === 'invoke' ? t('— command —') : t('— attribute —')}</option>
                    {#each members as m (m.name)}<option value={m.name}>{m.name} — {m.hint}</option>{/each}
                </select>
            {/if}
        </div>
        {#if composite}
            <div class="ui-form-help">{composite.description}</div>
        {:else if attributeInfo}
            <div class="ui-form-help">
                {attributeInfo.metatype}{attributeInfo.nullable ? ` · ${t('nullable')}` : ''}{attributeInfo.min !== undefined || attributeInfo.max !== undefined
                    ? ` · ${attributeInfo.min ?? ''}–${attributeInfo.max ?? ''}`
                    : ''}
                {#if enumMembers.length > 0}· {enumMembers.join(', ')}{/if}
                {#if attributeInfo.bitFields}· {attributeInfo.bitFields.map((f) => f.name).join(', ')}{/if}
            </div>
        {/if}
        <label class="ui-form-label" for="mapping-comment">{t('Comment')}</label>
        <div class="ui-form-field"><input id="mapping-comment" class="ui-input" bind:value={comment} /></div>
    </div>

    <div class="halves">
        <!-- status: device → Matter -->
        <section class="ui-section">
            <div class="ui-section-title">
                <Checkbox checked={status !== undefined} label={t('Status (device → Matter)')} onchange={enableStatus} testId="status-enabled" />
            </div>
            {#if status}
                <div class="ui-form compact">
                    <label class="ui-form-label" for="status-topic">{t('Topic')}</label>
                    <div class="ui-form-field">
                        <input id="status-topic" class="ui-input ui-mono" bind:value={status.topic} oninput={changed} data-testid="status-topic" />
                        <button type="button" class="ui-button" onclick={() => (picker = 'status')} data-testid="pick-status-topic">{t('Pick')}</button>
                    </div>
                    <label class="ui-form-label" for="status-extract">{t('Extract (JSON path)')}</label>
                    <div class="ui-form-field">
                        <input
                            id="status-extract"
                            class="ui-input ui-mono"
                            placeholder="$.state"
                            bind:value={status.extract}
                            oninput={changed}
                            data-testid="status-extract"
                        />
                    </div>
                    <label class="ui-form-label" for="status-template">{t('Template')}</label>
                    <div class="ui-form-field">
                        <input
                            id="status-template"
                            class="ui-input ui-mono"
                            placeholder={'{{ value_json.state }}'}
                            bind:value={status.template}
                            oninput={changed}
                        />
                    </div>
                    <span class="ui-form-label">{t('Map')}</span>
                    <div class="rows">
                        {#each mapRows as row, index (index)}
                            <div class="row">
                                <input class="ui-input ui-mono" placeholder={t('payload')} bind:value={row.key} oninput={changed} data-testid="map-key" />
                                <span>→</span>
                                <input class="ui-input ui-mono" placeholder={t('value')} bind:value={row.value} oninput={changed} data-testid="map-value" />
                                <button
                                    type="button"
                                    class="ui-icon-button"
                                    title={t('Remove')}
                                    onclick={() => {
                                        mapRows.splice(index, 1);
                                        changed();
                                    }}>✕</button
                                >
                            </div>
                        {/each}
                        <div>
                            <button type="button" class="ui-button" onclick={() => mapRows.push({key: '', value: ''})} data-testid="map-add"
                                >+ {t('Row')}</button
                            >
                            {#if enumMembers.length > 0 && mapRows.length === 0}
                                <button
                                    type="button"
                                    class="ui-button"
                                    onclick={() => {
                                        mapRows = enumMembers.map((name) => ({key: name.toLowerCase(), value: name}));
                                        changed();
                                    }}>{t('Enum names')}</button
                                >
                            {/if}
                        </div>
                    </div>
                    <label class="ui-form-label" for="status-default">{t('Default')}</label>
                    <div class="ui-form-field">
                        <input id="status-default" class="ui-input ui-field-medium" bind:value={status.default} oninput={changed} />
                    </div>
                    <label class="ui-form-label" for="status-type">{t('Type')}</label>
                    <div class="ui-form-field">
                        <select id="status-type" class="ui-select ui-field-medium" bind:value={status.type} onchange={changed}>
                            <option value={undefined}>{t('— none —')}</option>
                            <option value="boolean">boolean</option>
                            <option value="number">number</option>
                            <option value="string">string</option>
                        </select>
                    </div>
                    <label class="ui-form-label" for="status-unit">{t('Unit')}</label>
                    <div class="ui-form-field">
                        <select id="status-unit" class="ui-select ui-field-medium" bind:value={status.unit} onchange={changed} data-testid="status-unit">
                            <option value={undefined}>{t('— none —')}</option>
                            {#each catalog.units as unit (unit)}<option value={unit}>{unit}</option>{/each}
                        </select>
                    </div>
                    <span class="ui-form-label">{t('Scale')}</span>
                    <div class="ui-form-field">
                        <Checkbox checked={status.scale !== undefined} onchange={(on) => status && toggleScale(status, on)} />
                        {#if status.scale}
                            <input class="ui-input ui-field-narrow" type="number" bind:value={status.scale.from[0]} oninput={changed} />–<input
                                class="ui-input ui-field-narrow"
                                type="number"
                                bind:value={status.scale.from[1]}
                                oninput={changed}
                            />
                            →
                            <input class="ui-input ui-field-narrow" type="number" bind:value={status.scale.to[0]} oninput={changed} />–<input
                                class="ui-input ui-field-narrow"
                                type="number"
                                bind:value={status.scale.to[1]}
                                oninput={changed}
                            />
                        {/if}
                    </div>
                    <span class="ui-form-label">{t('Offset / round / invert')}</span>
                    <div class="ui-form-field">
                        <input
                            class="ui-input ui-field-narrow"
                            type="number"
                            step="any"
                            placeholder={t('offset')}
                            value={status.offset ?? ''}
                            oninput={(e) => {
                                if (status) status.offset = numberOrUndefined(e.currentTarget.value);
                                changed();
                            }}
                        />
                        <input
                            class="ui-input ui-field-narrow"
                            type="number"
                            min="0"
                            max="10"
                            placeholder={t('round')}
                            value={status.round ?? ''}
                            oninput={(e) => {
                                if (status) status.round = numberOrUndefined(e.currentTarget.value);
                                changed();
                            }}
                        />
                        <Checkbox
                            checked={status.invert === true}
                            label={t('invert')}
                            onchange={(on) => {
                                if (status) status.invert = on ? true : undefined;
                                changed();
                            }}
                        />
                    </div>
                    <label class="ui-form-label" for="status-expire">{t('Expire (s)')}</label>
                    <div class="ui-form-field">
                        <input
                            id="status-expire"
                            class="ui-input ui-field-narrow"
                            type="number"
                            min="1"
                            value={status.expire ?? ''}
                            oninput={(e) => {
                                if (status) status.expire = numberOrUndefined(e.currentTarget.value);
                            }}
                        />
                        <span class="ui-muted ui-small">{t('without a message for this long the device is unreachable')}</span>
                    </div>
                    <label class="ui-form-label" for="status-get">{t('Get request')}</label>
                    <div class="ui-form-field">
                        <input
                            id="status-get"
                            class="ui-input ui-mono"
                            placeholder={t('topic')}
                            value={status.get?.topic ?? ''}
                            oninput={(e) => {
                                if (status) status.get = {topic: e.currentTarget.value, payload: status.get?.payload ?? ''};
                            }}
                        />
                        <input
                            class="ui-input ui-mono ui-field-medium"
                            placeholder={t('payload')}
                            value={status.get?.payload ?? ''}
                            oninput={(e) => {
                                if (status) status.get = {topic: status.get?.topic ?? '', payload: e.currentTarget.value};
                            }}
                        />
                    </div>
                </div>
                <div class="preview">
                    <div class="ui-section-title">{t('Preview')}</div>
                    <div class="ui-form compact">
                        <label class="ui-form-label" for="status-payload">{t('Payload')}</label>
                        <div class="ui-form-field">
                            <textarea
                                id="status-payload"
                                class="ui-textarea"
                                rows="2"
                                bind:value={statusPayload}
                                oninput={runStatusPreview}
                                data-testid="status-payload"
                            ></textarea>
                        </div>
                    </div>
                    {#if statusPreview}
                        <ol class="stages" data-testid="status-stages">
                            {#each statusPreview.stages as stage (stage.step)}
                                <li class:ui-error-text={!stage.ok}>
                                    <span class="ui-muted step">{stage.step}</span>
                                    {#if stage.ok}<code>{formatValue(stage.value)}</code>{:else}{stage.reason}{/if}
                                </li>
                            {/each}
                        </ol>
                        {#if statusPreview.stages.length === 0 && statusPreview.reason}<div class="ui-error-text">{statusPreview.reason}</div>{/if}
                    {/if}
                    <div>
                        <button
                            type="button"
                            class="ui-button"
                            disabled={status.topic === '' || statusPayload === ''}
                            onclick={() => publish(status?.topic, statusPayload)}
                            data-testid="send-status"
                        >
                            {t('Publish as the device would')}
                        </button>
                    </div>
                </div>
            {/if}
        </section>

        <!-- command: Matter → device -->
        <section class="ui-section">
            <div class="ui-section-title">
                <Checkbox checked={command !== undefined} label={t('Command (Matter → device)')} onchange={enableCommand} testId="command-enabled" />
            </div>
            {#if command}
                <div class="ui-form compact">
                    <label class="ui-form-label" for="command-topic">{t('Topic')}</label>
                    <div class="ui-form-field">
                        <input id="command-topic" class="ui-input ui-mono" bind:value={command.topic} oninput={changed} data-testid="command-topic" />
                        <button type="button" class="ui-button" onclick={() => (picker = 'command')}>{t('Pick')}</button>
                    </div>
                    <label class="ui-form-label" for="command-unit">{t('Unit')}</label>
                    <div class="ui-form-field">
                        <select id="command-unit" class="ui-select ui-field-medium" bind:value={command.unit} onchange={changed}>
                            <option value={undefined}>{t('— none —')}</option>
                            {#each catalog.units as unit (unit)}<option value={unit}>{unit}</option>{/each}
                        </select>
                    </div>
                    <span class="ui-form-label">{t('Scale')}</span>
                    <div class="ui-form-field">
                        <Checkbox checked={command.scale !== undefined} onchange={(on) => command && toggleScale(command, on)} />
                        {#if command.scale}
                            <input class="ui-input ui-field-narrow" type="number" bind:value={command.scale.from[0]} oninput={changed} />–<input
                                class="ui-input ui-field-narrow"
                                type="number"
                                bind:value={command.scale.from[1]}
                                oninput={changed}
                            />
                            →
                            <input class="ui-input ui-field-narrow" type="number" bind:value={command.scale.to[0]} oninput={changed} />–<input
                                class="ui-input ui-field-narrow"
                                type="number"
                                bind:value={command.scale.to[1]}
                                oninput={changed}
                            />
                        {/if}
                    </div>
                    <span class="ui-form-label">{t('Offset / round / invert')}</span>
                    <div class="ui-form-field">
                        <input
                            class="ui-input ui-field-narrow"
                            type="number"
                            step="any"
                            placeholder={t('offset')}
                            value={command.offset ?? ''}
                            oninput={(e) => {
                                if (command) command.offset = numberOrUndefined(e.currentTarget.value);
                                changed();
                            }}
                        />
                        <input
                            class="ui-input ui-field-narrow"
                            type="number"
                            min="0"
                            max="10"
                            placeholder={t('round')}
                            value={command.round ?? ''}
                            oninput={(e) => {
                                if (command) command.round = numberOrUndefined(e.currentTarget.value);
                                changed();
                            }}
                        />
                        <input
                            class="ui-input ui-field-narrow"
                            type="number"
                            min="0"
                            max="10"
                            placeholder={t('precision')}
                            value={command.precision ?? ''}
                            oninput={(e) => {
                                if (command) command.precision = numberOrUndefined(e.currentTarget.value);
                                changed();
                            }}
                        />
                        <Checkbox
                            checked={command.invert === true}
                            label={t('invert')}
                            onchange={(on) => {
                                if (command) command.invert = on ? true : undefined;
                                changed();
                            }}
                        />
                    </div>
                    <span class="ui-form-label">{t('Format')}</span>
                    <div class="rows">
                        {#each formatRows as row, index (index)}
                            <div class="row">
                                <input class="ui-input ui-mono" placeholder={t('value')} bind:value={row.key} oninput={changed} data-testid="format-key" />
                                <span>→</span>
                                <input
                                    class="ui-input ui-mono"
                                    placeholder={t('payload')}
                                    bind:value={row.value}
                                    oninput={changed}
                                    data-testid="format-value"
                                />
                                <button
                                    type="button"
                                    class="ui-icon-button"
                                    title={t('Remove')}
                                    onclick={() => {
                                        formatRows.splice(index, 1);
                                        changed();
                                    }}>✕</button
                                >
                            </div>
                        {/each}
                        <div>
                            <button type="button" class="ui-button" onclick={() => formatRows.push({key: '', value: ''})} data-testid="format-add"
                                >+ {t('Row')}</button
                            >
                            {#if attributeInfo?.metatype === 'boolean' && formatRows.length === 0}
                                <button
                                    type="button"
                                    class="ui-button"
                                    onclick={() => {
                                        formatRows = [
                                            {key: 'true', value: 'ON'},
                                            {key: 'false', value: 'OFF'},
                                        ];
                                        changed();
                                    }}>ON / OFF</button
                                >
                            {/if}
                            {#if enumMembers.length > 0 && formatRows.length === 0}
                                <button
                                    type="button"
                                    class="ui-button"
                                    onclick={() => {
                                        formatRows = enumMembers.map((name) => ({key: name, value: name.toLowerCase()}));
                                        changed();
                                    }}>{t('Enum names')}</button
                                >
                            {/if}
                        </div>
                    </div>
                    <label class="ui-form-label" for="command-payload">{t('Fixed payload')}</label>
                    <div class="ui-form-field"><input id="command-payload" class="ui-input ui-mono" bind:value={command.payload} oninput={changed} /></div>
                    <label class="ui-form-label" for="command-template">{t('Template')}</label>
                    <div class="ui-form-field">
                        <input
                            id="command-template"
                            class="ui-input ui-mono"
                            placeholder={'{"brightness": {{ brightness }}}'}
                            bind:value={command.template}
                            oninput={changed}
                        />
                    </div>
                    <label class="ui-form-label" for="command-wrap">{t('Wrap (JSON path)')}</label>
                    <div class="ui-form-field">
                        <input
                            id="command-wrap"
                            class="ui-input ui-mono"
                            placeholder="state"
                            bind:value={command.wrap}
                            oninput={changed}
                            data-testid="command-wrap"
                        />
                    </div>
                    <span class="ui-form-label">{t('Retain / QoS / optimistic')}</span>
                    <div class="ui-form-field">
                        <Checkbox
                            checked={command.retain === true}
                            label={t('retain')}
                            onchange={(on) => {
                                if (command) command.retain = on ? true : undefined;
                            }}
                        />
                        <select
                            class="ui-select ui-field-narrow"
                            value={command.qos ?? 0}
                            onchange={(e) => {
                                if (command) command.qos = Number(e.currentTarget.value) as 0 | 1 | 2;
                            }}
                        >
                            <option value={0}>QoS 0</option><option value={1}>QoS 1</option><option value={2}>QoS 2</option>
                        </select>
                        <select class="ui-select ui-field-medium" bind:value={optimistic}>
                            <option value="auto">{t('optimistic: automatic')}</option>
                            <option value="true">{t('optimistic: yes')}</option>
                            <option value="false">{t('optimistic: no')}</option>
                        </select>
                    </div>
                </div>
                <div class="preview">
                    <div class="ui-section-title">{t('Preview')}</div>
                    <div class="ui-form compact">
                        <label class="ui-form-label" for="command-value">{t('Matter value')}</label>
                        <div class="ui-form-field">
                            {#if enumMembers.length > 0 && attributeInfo?.enumMembers}
                                <select id="command-value" class="ui-select" bind:value={commandValue} onchange={runCommandPreview}>
                                    <option value="">—</option>
                                    {#each Object.entries(attributeInfo.enumMembers) as [name, id] (name)}<option value={String(id)}>{name} ({id})</option
                                        >{/each}
                                </select>
                            {:else if attributeInfo?.metatype === 'boolean'}
                                <select
                                    id="command-value"
                                    class="ui-select ui-field-medium"
                                    bind:value={commandValue}
                                    onchange={runCommandPreview}
                                    data-testid="command-value"
                                >
                                    <option value="">—</option><option value="true">true</option><option value="false">false</option>
                                </select>
                            {:else}
                                <input
                                    id="command-value"
                                    class="ui-input ui-mono"
                                    placeholder={t('a number, text or JSON')}
                                    bind:value={commandValue}
                                    oninput={runCommandPreview}
                                    data-testid="command-value"
                                />
                            {/if}
                        </div>
                    </div>
                    {#if commandPreview}
                        <ol class="stages" data-testid="command-stages">
                            {#each commandPreview.stages as stage (stage.step)}
                                <li class:ui-error-text={!stage.ok}>
                                    <span class="ui-muted step">{stage.step}</span>
                                    {#if stage.ok}<code>{formatValue(stage.value)}</code>{:else}{stage.reason}{/if}
                                </li>
                            {/each}
                        </ol>
                        {#if commandPreview.stages.length === 0 && commandPreview.reason}<div class="ui-error-text">{commandPreview.reason}</div>{/if}
                    {/if}
                    <div>
                        <button
                            type="button"
                            class="ui-button"
                            disabled={command.topic === '' || commandPreview?.ok !== true}
                            onclick={() => publish(command?.topic, commandPreview?.result)}
                            data-testid="send-command"
                        >
                            {t('Test-publish')}
                        </button>
                    </div>
                </div>
            {/if}
        </section>
    </div>

    {#snippet buttons()}
        <button type="button" class="ui-button" onclick={onclose}>{t('Cancel')}</button>
        <button
            type="button"
            class="ui-button ui-button-primary"
            disabled={target === '' || (status === undefined && command === undefined)}
            onclick={save}
            data-testid="mapping-save"
        >
            {t('Apply')}
        </button>
    {/snippet}
</Dialog>

<TopicPicker
    open={picker !== undefined}
    initial={picker === 'command' ? (command?.topic ?? '') : (status?.topic ?? '')}
    withExtract={picker === 'status'}
    onpick={pick}
    onclose={() => (picker = undefined)}
/>

<style>
    .halves {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
        gap: 10px;
    }

    @media (max-width: 900px) {
        .halves {
            grid-template-columns: minmax(0, 1fr);
        }
    }

    .compact {
        --ui-form-label-width: 150px;
    }

    .rows {
        display: flex;
        flex-direction: column;
        gap: 4px;
    }

    .row {
        display: flex;
        align-items: center;
        gap: 4px;
    }

    .preview {
        border-top: 1px solid var(--ui-border-muted);
        padding-top: 6px;
        display: flex;
        flex-direction: column;
        gap: 4px;
    }

    .stages {
        margin: 0;
        padding-left: 18px;
        font-size: var(--ui-font-size-grid);
    }

    .step {
        display: inline-block;
        min-width: 70px;
    }
</style>

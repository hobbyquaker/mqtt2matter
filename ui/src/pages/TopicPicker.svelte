<script lang="ts">
    import {onMount} from 'svelte';

    import {type TopicEntry, api, errorMessage} from '../lib/api.ts';
    import Dialog from '../lib/components/Dialog.svelte';
    import {events} from '../lib/events.svelte.ts';
    import {formatTime, formatValue, jsonPaths, tryJson} from '../lib/format.ts';
    import {t} from '../lib/i18n.svelte.ts';
    import {notices} from '../lib/notices.svelte.ts';

    interface Props {
        open: boolean;
        /** the topic the field has, as the first filter */
        initial?: string;
        /** JSON keys are offered as `extract` paths */
        withExtract?: boolean;
        onpick: (topic: string, extract?: string) => void;
        onclose: () => void;
    }

    let {open, initial = '', withExtract = true, onpick, onclose}: Props = $props();

    let topics = $state<TopicEntry[]>([]);
    let filter = $state('');
    let selected = $state<TopicEntry | undefined>(undefined);

    const shown = $derived.by(() => {
        const needle = filter.trim().toLowerCase();
        return topics.filter((entry) => needle === '' || entry.topic.toLowerCase().includes(needle)).slice(0, 500);
    });
    const paths = $derived(selected === undefined ? [] : jsonPaths(tryJson(selected.payload)));

    async function load(): Promise<void> {
        try {
            topics = await api.topics();
        } catch (error) {
            notices.error(errorMessage(error));
        }
    }

    $effect(() => {
        if (open) {
            filter = initial.split('/').slice(0, 2).join('/');
            selected = undefined;
            void load();
        }
    });

    onMount(() => {
        const release = events.wantMqtt();
        const off = events.on((event) => {
            if (event.type !== 'mqtt' || !open) {
                return;
            }
            const index = topics.findIndex((entry) => entry.topic === event.topic);
            const entry = {topic: event.topic, payload: event.payload, retain: event.retain, ts: event.ts};
            if (index === -1) {
                topics = [...topics, entry].sort((a, b) => a.topic.localeCompare(b.topic));
            } else {
                topics[index] = entry;
            }
            if (selected?.topic === event.topic) {
                selected = entry;
            }
        });
        return () => {
            release();
            off();
        };
    });
</script>

<Dialog {open} title={t('Pick a topic')} width="760px" {onclose} testId="topic-picker">
    <input class="ui-input" placeholder={t('Filter')} bind:value={filter} data-testid="picker-filter" />
    <div class="list">
        <table class="ui-table">
            <thead><tr><th>{t('Topic')}</th><th>{t('Payload')}</th><th>{t('Time')}</th></tr></thead>
            <tbody>
                {#each shown as entry (entry.topic)}
                    <tr
                        class="ui-row-link"
                        class:ui-row-selected={entry.topic === selected?.topic}
                        onclick={() => (selected = entry)}
                        ondblclick={() => onpick(entry.topic)}
                        data-testid="picker-row"
                    >
                        <td><code>{entry.topic}</code></td>
                        <td class="payload"><code>{entry.payload}</code></td>
                        <td class="ui-muted">{formatTime(entry.ts)}</td>
                    </tr>
                {/each}
            </tbody>
        </table>
        {#if shown.length === 0}<div class="ui-empty">{t('No topic seen yet that matches.')}</div>{/if}
    </div>
    {#if selected}
        <div class="detail">
            <div><code>{selected.topic}</code></div>
            <pre class="ui-pre short">{selected.payload}</pre>
            {#if withExtract && paths.length > 0}
                <div class="ui-muted">{t('Click a key to use the topic with that JSON path:')}</div>
                <div class="paths">
                    {#each paths as leaf (leaf.path)}
                        <button type="button" class="ui-button" onclick={() => selected && onpick(selected.topic, leaf.path)} data-testid="picker-path">
                            <code>{leaf.path}</code> <span class="ui-muted">= {formatValue(leaf.value)}</span>
                        </button>
                    {/each}
                </div>
            {/if}
        </div>
    {/if}
    {#snippet buttons()}
        <button type="button" class="ui-button" onclick={onclose}>{t('Cancel')}</button>
        <button
            type="button"
            class="ui-button ui-button-primary"
            disabled={selected === undefined}
            onclick={() => selected && onpick(selected.topic)}
            data-testid="picker-use"
        >
            {t('Use topic')}
        </button>
    {/snippet}
</Dialog>

<style>
    .list {
        max-height: 300px;
        overflow: auto;
        border: 1px solid var(--ui-border-muted);
    }

    .payload {
        max-width: 300px;
    }

    .detail {
        display: flex;
        flex-direction: column;
        gap: 4px;
    }

    .short {
        max-height: 120px;
    }

    .paths {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
    }
</style>

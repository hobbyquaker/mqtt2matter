<script lang="ts">
    import {onMount} from 'svelte';

    import {type TopicEntry, api, errorMessage} from '../lib/api.ts';
    import Checkbox from '../lib/components/Checkbox.svelte';
    import {events} from '../lib/events.svelte.ts';
    import {formatTime, pretty, tryJson} from '../lib/format.ts';
    import {t} from '../lib/i18n.svelte.ts';
    import {notices} from '../lib/notices.svelte.ts';

    interface Message {
        id: number;
        topic: string;
        payload: string;
        retain: boolean;
        ts: number;
    }

    let topics = $state<Map<string, TopicEntry>>(new Map());
    let filter = $state('');
    let selected = $state('');
    let messages = $state<Message[]>([]);
    let paused = $state(false);
    let pubTopic = $state('');
    let pubPayload = $state('');
    let pubRetain = $state(false);
    let next = 1;

    const LIMIT = 300;

    const tree = $derived.by(() => {
        const needle = filter.trim().toLowerCase();
        return [...topics.values()]
            .filter((entry) => needle === '' || entry.topic.toLowerCase().includes(needle))
            .sort((a, b) => a.topic.localeCompare(b.topic));
    });
    const current = $derived(selected === '' ? undefined : topics.get(selected));
    const currentJson = $derived(current === undefined ? undefined : tryJson(current.payload));

    async function load(): Promise<void> {
        try {
            topics = new Map((await api.topics()).map((entry) => [entry.topic, entry]));
        } catch (error) {
            notices.error(errorMessage(error));
        }
    }

    onMount(() => {
        void load();
        const release = events.wantMqtt();
        const off = events.on((event) => {
            if (event.type !== 'mqtt') {
                return;
            }
            const entry = {topic: event.topic, payload: event.payload, retain: event.retain, ts: event.ts};
            topics.set(event.topic, entry);
            topics = new Map(topics);
            if (!paused) {
                messages = [{id: next++, ...entry}, ...messages].slice(0, LIMIT);
            }
        });
        return () => {
            release();
            off();
        };
    });

    async function publish(): Promise<void> {
        try {
            await api.publish(pubTopic, pubPayload, pubRetain);
            notices.info(t('Published to {topic}', {topic: pubTopic}));
        } catch (error) {
            notices.error(errorMessage(error));
        }
    }

    function select(entry: TopicEntry): void {
        selected = entry.topic;
        pubTopic = entry.topic;
        pubPayload = entry.payload;
    }
</script>

<div class="ui-page" data-testid="mqtt-page">
    <div class="ui-split split">
        <section class="ui-section column">
            <div class="ui-section-title">
                {t('Topics')}
                <div class="ui-toolbar-trailing">{t('{count} topics', {count: topics.size})}</div>
            </div>
            <input class="ui-input" placeholder={t('Filter')} bind:value={filter} data-testid="topic-filter" />
            <div class="ui-page-scroll">
                <table class="ui-table">
                    <thead><tr><th>{t('Topic')}</th><th>{t('Payload')}</th><th>{t('Time')}</th></tr></thead>
                    <tbody>
                        {#each tree as entry (entry.topic)}
                            <tr class="ui-row-link" class:ui-row-selected={entry.topic === selected} onclick={() => select(entry)} data-testid="topic-row">
                                <td
                                    ><code>{entry.topic}</code>{#if entry.retain}<span class="ui-badge retain">R</span>{/if}</td
                                >
                                <td class="payload"><code>{entry.payload}</code></td>
                                <td class="ui-muted">{formatTime(entry.ts)}</td>
                            </tr>
                        {/each}
                    </tbody>
                </table>
            </div>
            {#if current}
                <div class="detail">
                    <div class="ui-muted"><code>{current.topic}</code> · {formatTime(current.ts)}{current.retain ? ` · ${t('retained')}` : ''}</div>
                    <pre class="ui-pre">{currentJson === undefined ? current.payload : pretty(currentJson)}</pre>
                </div>
            {/if}
        </section>
        <div class="column right">
            <section class="ui-section">
                <div class="ui-section-title">{t('Publish')}</div>
                <div class="ui-form">
                    <label class="ui-form-label" for="pub-topic">{t('Topic')}</label>
                    <div class="ui-form-field"><input id="pub-topic" class="ui-input ui-mono" bind:value={pubTopic} data-testid="publish-topic" /></div>
                    <label class="ui-form-label" for="pub-payload">{t('Payload')}</label>
                    <div class="ui-form-field">
                        <textarea id="pub-payload" class="ui-textarea" rows="3" bind:value={pubPayload} data-testid="publish-payload"></textarea>
                    </div>
                    <span></span>
                    <div class="ui-form-field">
                        <Checkbox bind:checked={pubRetain} label={t('retain')} />
                        <button type="button" class="ui-button ui-button-primary" disabled={pubTopic === ''} onclick={publish} data-testid="publish"
                            >{t('Publish')}</button
                        >
                    </div>
                </div>
            </section>
            <section class="ui-section column">
                <div class="ui-section-title">
                    {t('Messages')}
                    <div class="ui-toolbar-trailing">
                        <Checkbox bind:checked={paused} label={t('pause')} />
                        <button type="button" class="ui-button" onclick={() => (messages = [])}>{t('Clear')}</button>
                    </div>
                </div>
                <div class="ui-page-scroll">
                    <table class="ui-table">
                        <tbody>
                            {#each messages as message (message.id)}
                                <tr data-testid="message-row">
                                    <td class="ui-muted time">{formatTime(message.ts)}</td>
                                    <td><code>{message.topic}</code></td>
                                    <td class="payload"><code>{message.payload}</code></td>
                                </tr>
                            {/each}
                        </tbody>
                    </table>
                </div>
            </section>
        </div>
    </div>
</div>

<style>
    .split {
        flex: 1 1 auto;
        min-height: 0;
        grid-template-rows: minmax(0, 1fr);
    }

    .column {
        display: flex;
        flex-direction: column;
        min-height: 0;
        gap: 6px;
    }

    .right {
        gap: 10px;
    }

    .right > .column {
        flex: 1 1 auto;
    }

    .payload {
        max-width: 320px;
    }

    .time {
        width: 1%;
    }

    .retain {
        margin-left: 4px;
    }

    .detail {
        flex: 0 0 auto;
        display: flex;
        flex-direction: column;
        gap: 3px;
    }
</style>

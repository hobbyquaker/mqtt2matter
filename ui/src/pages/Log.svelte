<script lang="ts">
    import {onMount, tick} from 'svelte';

    import {type LogEntry, api, errorMessage} from '../lib/api.ts';
    import Checkbox from '../lib/components/Checkbox.svelte';
    import {events} from '../lib/events.svelte.ts';
    import {formatTime} from '../lib/format.ts';
    import {t} from '../lib/i18n.svelte.ts';
    import {notices} from '../lib/notices.svelte.ts';

    let entries = $state<LogEntry[]>([]);
    let filter = $state('');
    let level = $state('debug');
    let follow = $state(true);
    let scroller = $state<HTMLDivElement | undefined>(undefined);

    const ORDER: Record<string, number> = {debug: 0, info: 1, warn: 2, error: 3};
    const LIMIT = 2000;

    const shown = $derived.by(() => {
        const needle = filter.trim().toLowerCase();
        const min = ORDER[level] ?? 0;
        return entries.filter((e) => (ORDER[e.level] ?? 0) >= min && (needle === '' || `${e.scope} ${e.message}`.toLowerCase().includes(needle)));
    });

    async function scrollDown(): Promise<void> {
        await tick();
        if (follow && scroller !== undefined) {
            scroller.scrollTop = scroller.scrollHeight;
        }
    }

    onMount(() => {
        api.log(LIMIT)
            .then((list) => {
                entries = list;
                void scrollDown();
            })
            .catch((error: unknown) => notices.error(errorMessage(error)));
        return events.on((event) => {
            if (event.type === 'log') {
                entries = [...entries, event.entry].slice(-LIMIT);
                void scrollDown();
            }
        });
    });
</script>

<div class="ui-page" data-testid="log-page">
    <div class="ui-toolbar">
        <select class="ui-select level" bind:value={level} data-testid="log-level">
            <option value="debug">debug</option>
            <option value="info">info</option>
            <option value="warn">warn</option>
            <option value="error">error</option>
        </select>
        <input class="ui-input filter" placeholder={t('Filter')} bind:value={filter} />
        <Checkbox bind:checked={follow} label={t('follow')} />
        <div class="ui-toolbar-trailing">{t('{count} lines', {count: shown.length})}</div>
    </div>
    <div class="ui-page-scroll" bind:this={scroller}>
        <table class="ui-table log">
            <tbody>
                {#each shown as entry (entry.id)}
                    <tr class={entry.level} data-testid="log-row">
                        <td class="ui-muted ts">{formatTime(entry.ts)}</td>
                        <td class="level-cell">{entry.level}</td>
                        <td class="ui-muted scope">{entry.scope}</td>
                        <td class="message">{entry.message}</td>
                    </tr>
                {/each}
            </tbody>
        </table>
    </div>
</div>

<style>
    .level {
        width: auto;
    }

    .filter {
        width: 260px;
    }

    .log td {
        height: 22px;
        font-family: var(--ui-font-mono);
    }

    /* the narrow columns keep their width; only the message wraps (a rule on `.log td` itself would
       outrank these and squeeze them to one character) */
    .log td.ts,
    .log td.level-cell,
    .log td.scope {
        width: 1%;
        white-space: nowrap;
    }

    .log td.message {
        white-space: pre-wrap;
        overflow-wrap: anywhere;
    }

    tr.warn .level-cell {
        color: var(--ui-warn);
    }

    tr.error .level-cell,
    tr.error .message {
        color: var(--ui-error);
    }

    tr.debug td {
        color: var(--ui-fg-muted);
    }
</style>

<script lang="ts">
    import {t} from '../i18n.svelte.ts';
    import {VISIBLE_NOTICES, notices} from '../notices.svelte.ts';

    let expanded = $state(false);
    const list = $derived(notices.list);
    const hidden = $derived(Math.max(0, list.length - VISIBLE_NOTICES));
    const shown = $derived(expanded ? list : list.slice(Math.max(0, list.length - VISIBLE_NOTICES)));

    $effect(() => {
        if (hidden === 0 && expanded) {
            expanded = false;
        }
    });
</script>

<!-- the toasts: an error never expires; the older ones collapse into a counter -->
<div class="notices" role="log" aria-live="polite" data-testid="notices">
    {#if hidden > 0}
        <button type="button" class="more" onclick={() => (expanded = !expanded)}>
            {expanded ? t('Show fewer') : t('{count} more', {count: hidden})}
        </button>
    {/if}
    {#each shown as notice (notice.id)}
        <div class="notice" class:warn={notice.level === 'warn'} class:error={notice.level === 'error'} data-testid="notice">
            <span class="text">{notice.message}</span>
            <button type="button" class="close" aria-label={t('Dismiss')} onclick={() => notices.dismiss(notice.id)}>✕</button>
        </div>
    {/each}
</div>

<style>
    .notices {
        position: fixed;
        right: 10px;
        bottom: 10px;
        z-index: 400;
        display: flex;
        flex-direction: column;
        align-items: stretch;
        gap: 6px;
        max-width: 460px;
        max-height: calc(100vh - 20px);
        overflow-y: auto;
    }

    .more {
        align-self: flex-end;
        padding: 2px 8px;
        border: 1px solid var(--ui-border-strong);
        border-radius: var(--ui-radius);
        background: var(--ui-bg);
        color: var(--ui-fg-muted);
        font: inherit;
        font-size: var(--ui-font-size-small);
        cursor: pointer;
    }

    .notice {
        display: flex;
        gap: 8px;
        align-items: flex-start;
        padding: 6px 8px;
        border: 1px solid var(--ui-border-strong);
        border-left-width: 4px;
        border-radius: var(--ui-radius);
        background: var(--ui-bg);
        box-shadow: var(--ui-shadow-toast);
    }

    .warn {
        border-left-color: var(--ui-warn);
    }

    .error {
        border-left-color: var(--ui-error);
    }

    .text {
        flex: 1 1 auto;
        overflow-wrap: anywhere;
    }

    .close {
        border: none;
        background: none;
        cursor: pointer;
        line-height: 1;
        padding: 0 2px;
        color: inherit;
    }
</style>

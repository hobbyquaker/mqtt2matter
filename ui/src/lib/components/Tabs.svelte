<script lang="ts">
    interface Tab {
        id: string;
        label: string;
        /** a status dot beside the label */
        dot?: 'ok' | 'warn' | 'error' | 'none' | undefined;
        badge?: string | undefined;
    }

    interface Props {
        tabs: Tab[];
        active: string;
        label?: string;
        onselect?: ((id: string) => void) | undefined;
    }

    let {tabs, active, label = 'Pages', onselect = undefined}: Props = $props();

    function onKeyDown(event: KeyboardEvent, index: number): void {
        const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
        if (delta === 0) {
            return;
        }
        event.preventDefault();
        const next = tabs[(index + delta + tabs.length) % tabs.length];
        if (next !== undefined) {
            onselect?.(next.id);
            (event.currentTarget as HTMLElement).parentElement?.querySelector<HTMLElement>(`#tab-${next.id}`)?.focus();
        }
    }
</script>

<!--
    Flat tab buttons: a tab is exactly as wide when it is active as when it is not, so the bar
    never moves. The active one is marked by a background, the text colour and an inset underline.
-->
<div class="ui-tabs" role="tablist" aria-label={label}>
    {#each tabs as tab, index (tab.id)}
        <button
            type="button"
            class="ui-tab"
            class:ui-tab-active={tab.id === active}
            role="tab"
            id="tab-{tab.id}"
            aria-selected={tab.id === active}
            tabindex={tab.id === active ? 0 : -1}
            data-testid="tab-{tab.id}"
            onclick={() => onselect?.(tab.id)}
            onkeydown={(event) => onKeyDown(event, index)}
        >
            {#if tab.dot !== undefined && tab.dot !== 'none'}<span class="ui-dot ui-dot-{tab.dot}"></span>{/if}
            <span>{tab.label}</span>
            {#if tab.badge !== undefined && tab.badge !== ''}<span class="ui-tab-badge">{tab.badge}</span>{/if}
        </button>
    {/each}
</div>

<style>
    .ui-tabs {
        display: flex;
        align-self: stretch;
        align-items: stretch;
        gap: 2px;
        margin-bottom: -1px;
        position: relative;
        z-index: 1;
        overflow-x: auto;
        scrollbar-width: none;
    }

    .ui-tab {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 0 12px;
        border: none;
        border-radius: var(--ui-radius) var(--ui-radius) 0 0;
        background: none;
        color: var(--ui-fg-muted);
        font-weight: 500;
        cursor: pointer;
        white-space: nowrap;
    }

    .ui-tab:hover:not(.ui-tab-active) {
        background: var(--ui-control-bg-hover);
        color: var(--ui-fg);
    }

    .ui-tab-active {
        background: var(--ui-accent-bg);
        color: var(--ui-fg);
        box-shadow: inset 0 -2px 0 var(--ui-accent);
    }

    .ui-tab .ui-dot {
        margin-right: 0;
    }

    .ui-tab-badge {
        color: var(--ui-fg-muted);
        font-size: var(--ui-font-size-small);
    }
</style>

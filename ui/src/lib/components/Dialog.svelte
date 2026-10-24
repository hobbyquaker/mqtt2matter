<script lang="ts">
    import type {Snippet} from 'svelte';

    import {t} from '../i18n.svelte.ts';

    interface Props {
        open: boolean;
        title: string;
        width?: string;
        /** ESC and the close button close it; off for a dialog that must be answered */
        closable?: boolean;
        onclose?: (() => void) | undefined;
        children?: Snippet | undefined;
        buttons?: Snippet | undefined;
        testId?: string | undefined;
    }

    let {open, title, width = '560px', closable = true, onclose = undefined, children, buttons, testId}: Props = $props();

    let element = $state<HTMLDialogElement | undefined>(undefined);

    $effect(() => {
        if (element === undefined) {
            return;
        }
        if (open && !element.open) {
            element.showModal();
        } else if (!open && element.open) {
            element.close();
        }
    });

    function cancel(event: Event): void {
        event.preventDefault();
        if (closable) {
            onclose?.();
        }
    }
</script>

<!-- a native <dialog>: the browser handles the focus trap, the backdrop and ESC (oncancel) -->
<dialog
    bind:this={element}
    class="ui-dialog"
    style:width
    oncancel={cancel}
    onclose={() => {
        if (open) {
            onclose?.();
        }
    }}
    data-testid={testId}
>
    <div class="ui-dialog-titlebar">
        <span class="ui-dialog-title">{title}</span>
        {#if closable}
            <button type="button" class="ui-dialog-close" aria-label={t('Close')} onclick={() => onclose?.()}>✕</button>
        {/if}
    </div>
    <div class="ui-dialog-body">
        {#if open && children}{@render children()}{/if}
    </div>
    {#if buttons}
        <div class="ui-dialog-buttons">{@render buttons()}</div>
    {/if}
</dialog>

<style>
    .ui-dialog {
        max-width: calc(100vw - 32px);
        max-height: calc(100vh - 32px);
        padding: 0;
        border: 1px solid var(--ui-border-strong);
        border-radius: var(--ui-radius);
        background: var(--ui-bg);
        color: var(--ui-fg);
        font-family: var(--ui-font);
        font-size: var(--ui-font-size);
        box-shadow: var(--ui-shadow-menu);
    }

    .ui-dialog[open] {
        display: flex;
        flex-direction: column;
    }

    .ui-dialog::backdrop {
        background: var(--ui-backdrop);
    }

    .ui-dialog-titlebar {
        display: flex;
        flex: 0 0 auto;
        align-items: center;
        gap: 8px;
        padding: 4px 6px 4px 10px;
        background: var(--ui-header-bg);
        border-bottom: 1px solid var(--ui-border);
    }

    .ui-dialog-title {
        font-weight: bold;
        flex: 1 1 auto;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .ui-dialog-close {
        border: 1px solid transparent;
        border-radius: var(--ui-radius);
        background: none;
        cursor: pointer;
        line-height: 1;
        padding: 2px 6px;
    }

    .ui-dialog-close:hover {
        border-color: var(--ui-border);
        background: var(--ui-accent-bg);
    }

    .ui-dialog-body {
        display: flex;
        flex-direction: column;
        gap: var(--ui-form-section-gap);
        flex: 1 1 auto;
        min-height: 0;
        padding: 10px;
        overflow: auto;
    }

    .ui-dialog-buttons {
        display: flex;
        flex: 0 0 auto;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 6px;
        padding: 6px 10px;
        border-top: 1px solid var(--ui-border-muted);
        background: var(--ui-bg-sunken);
    }
</style>

<script lang="ts">
    import {dialogs} from '../dialogs.svelte.ts';
    import {t} from '../i18n.svelte.ts';
    import Dialog from './Dialog.svelte';

    let value = $state('');
    let input = $state<HTMLInputElement | undefined>(undefined);

    const pending = $derived(dialogs.pending);
    const matches = $derived(pending?.kind !== 'prompt' || pending.options.pattern === undefined || pending.options.pattern.test(value));
    const problem = $derived(pending?.kind === 'prompt' && matches ? pending.options.validate?.(value) : undefined);
    const valid = $derived(matches && problem === undefined);

    $effect(() => {
        if (pending?.kind === 'prompt') {
            value = pending.options.value ?? '';
            setTimeout(() => input?.focus(), 0);
        }
    });

    function ok(): void {
        if (pending?.kind === 'prompt') {
            if (valid) {
                dialogs.settle(value);
            }
        } else {
            dialogs.settle(true);
        }
    }
</script>

{#if pending}
    <Dialog
        open={true}
        title={pending.options.title ?? (pending.kind === 'prompt' ? t('Input') : t('Confirm'))}
        width="420px"
        onclose={() => dialogs.settle(pending.kind === 'prompt' ? null : false)}
        testId="dialog-{pending.kind}"
    >
        <p class="message">{pending.message}</p>
        {#if pending.kind === 'prompt'}
            <input
                bind:this={input}
                class="ui-input"
                class:ui-invalid={!valid}
                bind:value
                placeholder={pending.options.placeholder ?? ''}
                onkeydown={(event) => {
                    if (event.key === 'Enter') {
                        ok();
                    }
                }}
                data-testid="dialog-input"
            />
            {#if problem !== undefined}<div class="ui-form-help ui-error-text" data-testid="dialog-problem">{problem}</div>{/if}
        {/if}
        {#snippet buttons()}
            <button type="button" class="ui-button" onclick={() => dialogs.settle(pending.kind === 'prompt' ? null : false)}>
                {pending.options.cancel ?? t('Cancel')}
            </button>
            <button
                type="button"
                class="ui-button"
                class:ui-button-primary={!pending.options.danger}
                class:ui-button-danger={pending.options.danger}
                disabled={!valid}
                onclick={ok}
                data-testid="dialog-ok"
            >
                {pending.options.confirm ?? t('OK')}
            </button>
        {/snippet}
    </Dialog>
{/if}

<style>
    .message {
        margin: 0;
        white-space: pre-line;
    }
</style>

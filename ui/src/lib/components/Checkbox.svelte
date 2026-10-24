<script lang="ts">
    interface Props {
        checked: boolean;
        label?: string;
        disabled?: boolean;
        title?: string | undefined;
        onchange?: ((checked: boolean) => void) | undefined;
        testId?: string | undefined;
    }

    let {checked = $bindable(), label = '', disabled = false, title = undefined, onchange = undefined, testId}: Props = $props();
</script>

<label class="ui-check" class:ui-disabled={disabled} {title}>
    <input type="checkbox" bind:checked {disabled} data-testid={testId} onchange={(event) => onchange?.(event.currentTarget.checked)} />
    {#if label !== ''}<span>{label}</span>{/if}
</label>

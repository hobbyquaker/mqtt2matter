<script lang="ts">
    import type {Issue} from '../api.ts';
    import {t} from '../i18n.svelte.ts';

    interface Props {
        issues: Issue[];
        /** shown when there is nothing to show */
        empty?: string | undefined;
    }

    let {issues, empty = undefined}: Props = $props();
</script>

{#if issues.length === 0}
    {#if empty !== undefined}<div class="ui-ok-text">{empty}</div>{/if}
{:else}
    <ul class="issues" data-testid="issues">
        {#each issues as issue, index (index)}
            <li class={issue.level === 'error' ? 'ui-error-text' : 'ui-warn-text'}>
                <span class="ui-badge" class:ui-badge-error={issue.level === 'error'} class:ui-badge-warn={issue.level !== 'error'}>
                    {issue.level === 'error' ? t('error') : t('warning')}
                </span>
                {#if issue.path !== ''}<code>{issue.path}</code>{/if}
                {issue.message}
            </li>
        {/each}
    </ul>
{/if}

<style>
    .issues {
        margin: 0;
        padding: 0;
        list-style: none;
        display: flex;
        flex-direction: column;
        gap: 3px;
        font-size: var(--ui-font-size-grid);
    }

    .issues li {
        display: flex;
        gap: 6px;
        align-items: baseline;
        overflow-wrap: anywhere;
    }
</style>

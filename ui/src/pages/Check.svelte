<script lang="ts">
    import {type CheckResult, api, errorMessage} from '../lib/api.ts';
    import Issues from '../lib/components/Issues.svelte';
    import {t} from '../lib/i18n.svelte.ts';
    import {notices} from '../lib/notices.svelte.ts';
    import {router} from '../lib/router.svelte.ts';

    let result = $state<CheckResult | undefined>(undefined);
    let running = $state(false);

    async function run(): Promise<void> {
        running = true;
        try {
            result = await api.check();
        } catch (error) {
            notices.error(errorMessage(error));
        } finally {
            running = false;
        }
    }
</script>

<div class="ui-page" data-testid="check-page">
    <div class="ui-toolbar">
        <button type="button" class="ui-button ui-button-primary" disabled={running} onclick={run} data-testid="run-check">
            {running ? t('Checking…') : t('Check every device')}
        </button>
        <span class="ui-muted">{t('The strict dry run: every device is built in a throw-away Matter node, nothing goes online.')}</span>
    </div>
    <div class="ui-page-scroll">
        {#if result}
            <div class="verdict" class:ui-ok-text={result.ok} class:ui-error-text={!result.ok} data-testid="check-verdict">
                {result.ok ? t('Every device conforms.') : t('Some devices do not conform.')}
            </div>
            {#each Object.entries(result.devices) as [key, issues] (key)}
                <section class="ui-section">
                    <div class="ui-section-title">
                        <a
                            href={`#/devices/${encodeURIComponent(key)}`}
                            onclick={(event) => {
                                event.preventDefault();
                                router.go('devices', key);
                            }}>{key}</a
                        >
                    </div>
                    <Issues {issues} />
                </section>
            {/each}
        {/if}
    </div>
</div>

<style>
    .verdict {
        font-weight: 600;
        margin-bottom: 8px;
    }

    .ui-section {
        margin-bottom: 8px;
    }
</style>

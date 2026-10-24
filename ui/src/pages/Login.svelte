<script lang="ts">
    import {errorMessage} from '../lib/api.ts';
    import {LANGUAGES, LANGUAGE_LABELS, i18n, t} from '../lib/i18n.svelte.ts';
    import {session} from '../lib/session.svelte.ts';

    let password = $state('');
    let error = $state('');
    let busy = $state(false);

    async function submit(event: SubmitEvent): Promise<void> {
        event.preventDefault();
        if (password === '' || busy) {
            return;
        }
        busy = true;
        error = '';
        try {
            await session.login(password);
            password = '';
        } catch (failure) {
            error = errorMessage(failure);
        } finally {
            busy = false;
        }
    }
</script>

<div class="login" data-testid="login">
    <div class="card ui-section">
        <div class="brand">mqtt2matter</div>
        {#if session.unreachable}
            <p class="ui-error-text">{t('The bridge does not answer.')}</p>
            <div><button type="button" class="ui-button" onclick={() => session.load()}>{t('Try again')}</button></div>
        {:else if session.state?.mode === 'password'}
            <form onsubmit={submit}>
                <label class="ui-form-label" for="login-password">{t('Password')}</label>
                <input
                    id="login-password"
                    class="ui-input"
                    type="password"
                    autocomplete="current-password"
                    bind:value={password}
                    data-testid="login-password"
                />
                {#if error !== ''}<p class="ui-error-text" data-testid="login-error">{error}</p>{/if}
                <button type="submit" class="ui-button ui-button-primary" disabled={password === '' || busy} data-testid="login-submit">{t('Log in')}</button>
            </form>
        {:else if session.state?.mode === 'proxy'}
            <p>{t('This request was not authenticated by the reverse proxy. Open the UI through the proxy.')}</p>
            <div><button type="button" class="ui-button" onclick={() => session.load()}>{t('Try again')}</button></div>
        {/if}
        <select
            class="ui-select language"
            aria-label={t('Language')}
            value={i18n.choice}
            onchange={(event) => i18n.set(event.currentTarget.value as 'de' | 'en' | 'auto')}
        >
            <option value="auto">{t('Browser language')}</option>
            {#each LANGUAGES as language (language)}
                <option value={language}>{LANGUAGE_LABELS[language]}</option>
            {/each}
        </select>
    </div>
</div>

<style>
    .login {
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 100dvh;
        padding: 16px;
        background: var(--ui-bg);
        color: var(--ui-fg);
    }

    .card {
        width: min(340px, 100%);
        gap: 12px;
        background: var(--ui-header-bg);
    }

    .brand {
        font-weight: 700;
        letter-spacing: 1px;
        color: var(--ui-accent);
        text-align: center;
    }

    form {
        display: flex;
        flex-direction: column;
        gap: 8px;
    }

    form .ui-form-label {
        text-align: left;
    }

    p {
        margin: 0;
    }

    .language {
        align-self: center;
        width: auto;
    }
</style>

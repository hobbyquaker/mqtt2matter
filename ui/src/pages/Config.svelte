<script lang="ts">
    import {onMount} from 'svelte';

    import {type ConfigView, api, errorMessage} from '../lib/api.ts';
    import Checkbox from '../lib/components/Checkbox.svelte';
    import {dialogs} from '../lib/dialogs.svelte.ts';
    import {download, isRecord, pretty, tryJson} from '../lib/format.ts';
    import {LANGUAGES, LANGUAGE_LABELS, i18n, t} from '../lib/i18n.svelte.ts';
    import {notices} from '../lib/notices.svelte.ts';
    import {session} from '../lib/session.svelte.ts';
    import {type Theme, getTheme, setTheme} from '../lib/theme.ts';

    let view = $state<ConfigView | undefined>(undefined);
    let text = $state('');
    /** the display settings are the viewer's own, kept in the browser */
    let theme = $state<Theme>(getTheme());
    let importText = $state('');
    let replace = $state(false);
    let saving = $state(false);

    const parsed = $derived(tryJson(text));
    const valid = $derived(isRecord(parsed));
    const importParsed = $derived(tryJson(importText));
    const importDevices = $derived.by(() => {
        if (!isRecord(importParsed)) {
            return undefined;
        }
        const devices = isRecord(importParsed.devices) ? importParsed.devices : importParsed;
        return Object.keys(devices).length > 0 ? devices : undefined;
    });

    // access: who may use this UI
    let accessMode = $state<'none' | 'password' | 'proxy'>('none');
    let newPassword = $state('');
    let repeatPassword = $state('');
    let proxyHeader = $state('X-Remote-User');
    let proxyLogoutUrl = $state('');
    let savingAccess = $state(false);
    const accessLocked = $derived(view?.overridden.some((path) => path.startsWith('server.auth')) ?? false);
    const accessValid = $derived(accessMode !== 'password' || (newPassword === repeatPassword && (newPassword !== '' || session.state?.mode === 'password')));

    function loadAccess(current: ConfigView): void {
        const server = isRecord(current.effective.server) ? current.effective.server : {};
        const auth = isRecord(server.auth) ? server.auth : {};
        accessMode = auth.mode === 'password' || auth.mode === 'proxy' ? auth.mode : 'none';
        proxyHeader = typeof auth.proxyHeader === 'string' ? auth.proxyHeader : 'X-Remote-User';
        proxyLogoutUrl = typeof auth.proxyLogoutUrl === 'string' ? auth.proxyLogoutUrl : '';
        newPassword = '';
        repeatPassword = '';
    }

    async function saveAccess(): Promise<void> {
        if (!accessValid) {
            return;
        }
        const message = {
            none: t('Open the UI to everyone who reaches its port?'),
            password: t('Protect the UI with this password? Other open sessions end.'),
            proxy: t('Trust the {header} header of the reverse proxy? Only the proxy may reach the port then, or anyone can send the header.', {
                header: proxyHeader,
            }),
        }[accessMode];
        if (!(await dialogs.confirm(message, {confirm: t('Save')}))) {
            return;
        }
        savingAccess = true;
        try {
            await api.setAccess({
                mode: accessMode,
                ...(newPassword === '' ? {} : {password: newPassword}),
                ...(accessMode === 'proxy' ? {proxyHeader} : {}),
                ...(accessMode === 'proxy' && proxyLogoutUrl !== '' ? {proxyLogoutUrl} : {}),
            });
            notices.info(t('Access saved; it applies at once.'));
            await session.load();
            await load();
        } catch (error) {
            notices.error(errorMessage(error));
        } finally {
            savingAccess = false;
        }
    }

    async function load(): Promise<void> {
        try {
            view = await api.config();
            text = pretty(view.settings);
            loadAccess(view);
        } catch (error) {
            notices.error(errorMessage(error));
        }
    }

    onMount(() => {
        void load();
    });

    async function save(): Promise<void> {
        if (!valid) {
            return;
        }
        saving = true;
        try {
            await api.saveConfig(parsed);
            notices.warn(t('Settings saved. They apply at the next start of mqtt2matter.'));
            await load();
        } catch (error) {
            notices.error(errorMessage(error));
        } finally {
            saving = false;
        }
    }

    async function exportAll(): Promise<void> {
        try {
            download('mqtt2matter.json', pretty(await api.exportAll()));
        } catch (error) {
            notices.error(errorMessage(error));
        }
    }

    function pickFile(event: Event): void {
        const file = (event.currentTarget as HTMLInputElement).files?.[0];
        if (file === undefined) {
            return;
        }
        file.text().then(
            (content) => {
                importText = content;
            },
            () => notices.error(t('The file could not be read.')),
        );
    }

    async function doImport(): Promise<void> {
        if (importDevices === undefined) {
            return;
        }
        const count = Object.keys(importDevices).length;
        const ok = await dialogs.confirm(
            replace
                ? t('Import {count} devices and delete every other device?', {count})
                : t('Import {count} devices? Existing devices with the same key are replaced.', {count}),
            {confirm: t('Import'), danger: replace},
        );
        if (!ok) {
            return;
        }
        try {
            const result = await api.importDevices(importDevices, replace);
            notices.info(t('{count} devices imported', {count: result.imported}));
            importText = '';
        } catch (error) {
            notices.error(errorMessage(error));
        }
    }
</script>

<div class="ui-page" data-testid="config-page">
    <div class="ui-page-scroll columns">
        <section class="ui-section display" data-testid="display">
            <div class="ui-section-title">
                {t('Display')}
                <span class="ui-faint ui-small">{t('in this browser only')}</span>
            </div>
            <div class="display-row">
                <label class="display-field">
                    <span class="ui-muted">{t('Language')}</span>
                    <select
                        class="ui-select"
                        value={i18n.choice}
                        onchange={(event) => i18n.set(event.currentTarget.value as 'de' | 'en' | 'auto')}
                        data-testid="language"
                    >
                        <option value="auto">{t('Browser language')}</option>
                        {#each LANGUAGES as language (language)}
                            <option value={language}>{LANGUAGE_LABELS[language]}</option>
                        {/each}
                    </select>
                </label>
                <label class="display-field">
                    <span class="ui-muted">{t('Theme')}</span>
                    <select
                        class="ui-select"
                        value={theme}
                        onchange={(event) => {
                            theme = event.currentTarget.value as Theme;
                            setTheme(theme);
                        }}
                        data-testid="theme"
                    >
                        <option value="system">{t('like the system')}</option>
                        <option value="light">{t('light')}</option>
                        <option value="dark">{t('dark')}</option>
                    </select>
                </label>
            </div>
        </section>
        <section class="ui-section">
            <div class="ui-section-title">
                {t('Settings')}
                {#if view}<span class="ui-faint ui-small">{view.path}</span>{/if}
            </div>
            <p class="ui-muted">
                {t(
                    'The top level of the configuration file without the devices: mqtt, storage, log, vendorId, productId, bridges, server, presets. Changes apply at the next start.',
                )}
            </p>
            {#if view && view.overridden.length > 0}
                <p class="ui-warn-text">{t('Set by the environment and not editable here: {paths}', {paths: view.overridden.join(', ')})}</p>
            {/if}
            <textarea class="ui-textarea" rows="18" bind:value={text} spellcheck="false" data-testid="settings-json"></textarea>
            <div class="ui-toolbar">
                <button type="button" class="ui-button ui-button-primary" disabled={!valid || saving} onclick={save} data-testid="save-settings"
                    >{t('Save')}</button
                >
                <button type="button" class="ui-button" onclick={load}>{t('Reload')}</button>
                {#if !valid}<span class="ui-error-text">{t('Not valid JSON')}</span>{/if}
            </div>
        </section>
        <div class="stack">
            <section class="ui-section" data-testid="access">
                <div class="ui-section-title">{t('Access')}</div>
                <p class="ui-muted">{t('Who may use this UI and its API. Without a login, keep the port on a trusted network.')}</p>
                {#if accessLocked}
                    <p class="ui-warn-text">{t('Set by the environment and not editable here: {paths}', {paths: 'server.auth'})}</p>
                {/if}
                <div class="ui-form">
                    <label class="ui-form-label" for="access-mode">{t('Login')}</label>
                    <div class="ui-form-field">
                        <select id="access-mode" class="ui-select" bind:value={accessMode} disabled={accessLocked} data-testid="access-mode">
                            <option value="none">{t('none')}</option>
                            <option value="password">{t('password')}</option>
                            <option value="proxy">{t('reverse proxy')}</option>
                        </select>
                    </div>
                    {#if accessMode === 'password'}
                        <label class="ui-form-label" for="access-password">{t('Password')}</label>
                        <div class="ui-form-field">
                            <input
                                id="access-password"
                                class="ui-input"
                                type="password"
                                autocomplete="new-password"
                                placeholder={session.state?.mode === 'password' ? t('unchanged') : ''}
                                bind:value={newPassword}
                                data-testid="access-password"
                            />
                        </div>
                        <label class="ui-form-label" for="access-repeat">{t('Repeat')}</label>
                        <div class="ui-form-field">
                            <input
                                id="access-repeat"
                                class="ui-input"
                                type="password"
                                autocomplete="new-password"
                                bind:value={repeatPassword}
                                data-testid="access-repeat"
                            />
                        </div>
                        {#if newPassword !== repeatPassword}<div class="ui-form-help ui-error-text">{t('The passwords differ.')}</div>{/if}
                    {:else if accessMode === 'proxy'}
                        <label class="ui-form-label" for="access-header">{t('Header')}</label>
                        <div class="ui-form-field"><input id="access-header" class="ui-input" bind:value={proxyHeader} /></div>
                        <label class="ui-form-label" for="access-logout">{t('Logout URL')}</label>
                        <div class="ui-form-field">
                            <input id="access-logout" class="ui-input" bind:value={proxyLogoutUrl} placeholder="https://…" />
                        </div>
                        <div class="ui-form-help">{t('Optional: where "Log out" goes — the sign-out of the proxy.')}</div>
                    {/if}
                </div>
                <div>
                    <button
                        type="button"
                        class="ui-button ui-button-primary"
                        disabled={accessLocked || !accessValid || savingAccess}
                        onclick={saveAccess}
                        data-testid="save-access">{t('Save')}</button
                    >
                </div>
            </section>
            <section class="ui-section">
                <div class="ui-section-title">{t('Export')}</div>
                <p class="ui-muted">{t('The whole configuration file, as it is on disk. One device exports from the device list.')}</p>
                <div><button type="button" class="ui-button" onclick={exportAll} data-testid="export-all">{t('Download mqtt2matter.json')}</button></div>
            </section>
            <section class="ui-section">
                <div class="ui-section-title">{t('Import')}</div>
                <p class="ui-muted">{t('A configuration file or a devices object; every device is validated before anything is written.')}</p>
                <input type="file" accept="application/json,.json" onchange={pickFile} />
                <textarea class="ui-textarea" rows="8" bind:value={importText} placeholder={'{"devices": {…}}'} spellcheck="false" data-testid="import-json"
                ></textarea>
                <div class="ui-toolbar">
                    <button type="button" class="ui-button ui-button-primary" disabled={importDevices === undefined} onclick={doImport} data-testid="import">
                        {importDevices === undefined ? t('Import') : t('Import {count} devices', {count: Object.keys(importDevices).length})}
                    </button>
                    <Checkbox bind:checked={replace} label={t('replace every device')} />
                </div>
            </section>
        </div>
    </div>
</div>

<style>
    .display {
        grid-column: 1 / -1;
    }

    .display-row {
        display: flex;
        flex-wrap: wrap;
        gap: 8px 20px;
    }

    .display-field {
        display: flex;
        align-items: center;
        gap: 8px;
    }

    .display-field .ui-select {
        width: auto;
    }

    .columns {
        display: grid;
        grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
        gap: 10px;
        align-content: start;
    }

    .stack {
        display: flex;
        flex-direction: column;
        gap: 10px;
    }

    p {
        margin: 0;
    }

    @media (max-width: 900px) {
        .columns {
            grid-template-columns: minmax(0, 1fr);
        }
    }
</style>

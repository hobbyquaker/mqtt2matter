<script lang="ts">
    import {onMount} from 'svelte';

    import {type BridgeInfo, api, errorMessage} from '../lib/api.ts';
    import Icon from '../lib/components/Icon.svelte';
    import QrCode from '../lib/components/QrCode.svelte';
    import {dialogs} from '../lib/dialogs.svelte.ts';
    import {events} from '../lib/events.svelte.ts';
    import {t} from '../lib/i18n.svelte.ts';
    import {notices} from '../lib/notices.svelte.ts';

    let bridges = $state<BridgeInfo[]>([]);
    let busy = $state('');

    async function load(): Promise<void> {
        try {
            bridges = await api.bridges();
        } catch (error) {
            notices.error(errorMessage(error));
        }
    }

    onMount(() => {
        void load();
        const timer = setInterval(() => void load(), 10_000);
        const off = events.on((event) => {
            if (event.type === 'bridges') {
                void load();
            }
        });
        return () => {
            clearInterval(timer);
            off();
        };
    });

    async function window_(bridge: BridgeInfo, open: boolean): Promise<void> {
        busy = bridge.id;
        try {
            await api.commissioning(bridge.id, open, 15);
            notices.info(open ? t('Commissioning window open for 15 minutes') : t('Commissioning window closed'));
            await load();
        } catch (error) {
            notices.error(errorMessage(error));
        } finally {
            busy = '';
        }
    }

    async function removeFabric(bridge: BridgeInfo, fabric: BridgeInfo['fabrics'][number]): Promise<void> {
        const ok = await dialogs.confirm(
            t('Remove fabric {label}? The controller loses the bridge and every device on it.', {label: fabric.label || `#${fabric.index}`}),
            {confirm: t('Remove'), danger: true},
        );
        if (!ok) {
            return;
        }
        try {
            await api.removeFabric(bridge.id, fabric.index);
            await load();
        } catch (error) {
            notices.error(errorMessage(error));
        }
    }

    function windowLabel(status: number): string {
        return status === 0 ? t('closed') : status === 2 ? t('open (basic)') : t('open (enhanced)');
    }

    function formatManualCode(code: string): string {
        return code.length === 11 ? `${code.slice(0, 4)}-${code.slice(4, 7)}-${code.slice(7)}` : code;
    }
</script>

<div class="ui-page" data-testid="bridges-page">
    <div class="ui-page-scroll bridges">
        {#each bridges as bridge (bridge.id)}
            <section class="ui-section bridge" data-testid="bridge" data-id={bridge.id}>
                <div class="ui-section-title">
                    <span class="ui-dot" class:ui-dot-ok={bridge.online} class:ui-dot-error={!bridge.online}></span>
                    {bridge.id}
                    <span class="ui-badge" class:ui-badge-ok={bridge.commissioned} class:ui-badge-warn={!bridge.commissioned}>
                        {bridge.commissioned ? t('commissioned') : t('not commissioned')}
                    </span>
                    <div class="ui-toolbar-trailing">
                        {t('port {port}', {port: bridge.port})} · {t('{count} devices', {count: bridge.devices})}
                    </div>
                </div>
                <div class="ui-split">
                    <div class="pairing">
                        {#if bridge.pairingCodes}
                            <QrCode text={bridge.pairingCodes.qrPairingCode} />
                            <dl class="ui-kv">
                                <dt>{t('Manual pairing code')}</dt>
                                <dd><code class="code" data-testid="manual-code">{formatManualCode(bridge.pairingCodes.manualPairingCode)}</code></dd>
                                <dt>{t('QR payload')}</dt>
                                <dd><code>{bridge.pairingCodes.qrPairingCode}</code></dd>
                            </dl>
                        {:else}
                            <div class="ui-muted">{t('No pairing codes: the bridge is not running.')}</div>
                        {/if}
                        <div class="ui-toolbar">
                            <span class="ui-muted">{t('Commissioning window')}: {windowLabel(bridge.windowStatus)}</span>
                            {#if bridge.windowStatus === 0}
                                <button
                                    type="button"
                                    class="ui-button"
                                    disabled={busy === bridge.id}
                                    onclick={() => window_(bridge, true)}
                                    data-testid="open-window"
                                >
                                    {t('Open for 15 minutes')}
                                </button>
                            {:else}
                                <button
                                    type="button"
                                    class="ui-button"
                                    disabled={busy === bridge.id}
                                    onclick={() => window_(bridge, false)}
                                    data-testid="close-window">{t('Close')}</button
                                >
                            {/if}
                        </div>
                        <p class="ui-faint ui-small">
                            {t(
                                'Pair the bridge from Apple Home, Home Assistant, Google Home or Alexa with the QR code or the manual code. A commissioned bridge needs an open window for a second controller.',
                            )}
                        </p>
                    </div>
                    <div>
                        <h3>{t('Fabrics')}</h3>
                        {#if bridge.fabrics.length === 0}
                            <div class="ui-muted">{t('No controller has paired this bridge yet.')}</div>
                        {:else}
                            <table class="ui-table">
                                <thead>
                                    <tr><th>#</th><th>{t('Label')}</th><th>{t('Vendor')}</th><th>{t('Node id')}</th><th></th></tr>
                                </thead>
                                <tbody>
                                    {#each bridge.fabrics as fabric (fabric.index)}
                                        <tr>
                                            <td>{fabric.index}</td>
                                            <td>{fabric.label}</td>
                                            <td><code>0x{fabric.vendorId.toString(16)}</code></td>
                                            <td><code>{fabric.nodeId}</code></td>
                                            <td class="ui-actions">
                                                <button type="button" class="ui-icon-button" title={t('Remove')} onclick={() => removeFabric(bridge, fabric)}
                                                    ><Icon name="trash" /></button
                                                >
                                            </td>
                                        </tr>
                                    {/each}
                                </tbody>
                            </table>
                        {/if}
                    </div>
                </div>
            </section>
        {/each}
    </div>
</div>

<style>
    .bridges {
        display: flex;
        flex-direction: column;
        gap: 10px;
    }

    .pairing {
        display: flex;
        flex-direction: column;
        gap: 8px;
        align-items: flex-start;
    }

    .code {
        font-size: 16px;
        letter-spacing: 1px;
    }

    p {
        margin: 0;
    }
</style>

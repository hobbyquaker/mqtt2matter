<script lang="ts">
    import {onMount} from 'svelte';

    import {type BridgeInfo, api, errorMessage} from '../lib/api.ts';
    import Icon from '../lib/components/Icon.svelte';
    import QrCode from '../lib/components/QrCode.svelte';
    import {dialogs} from '../lib/dialogs.svelte.ts';
    import {events} from '../lib/events.svelte.ts';
    import {formatDateTime} from '../lib/format.ts';
    import {t} from '../lib/i18n.svelte.ts';
    import {notices} from '../lib/notices.svelte.ts';

    let bridges = $state<BridgeInfo[]>([]);
    let busy = $state('');

    /** the companion fabric Apple Home adds for the iCloud Keychain */
    const APPLE_KEYCHAIN = 0x1384;

    /** an id as hex, upper case, padded: matter.js hands node and fabric ids out as decimal strings */
    function hex(value: string | number, digits: number): string {
        try {
            return BigInt(value).toString(16).toUpperCase().padStart(digits, '0');
        } catch {
            return String(value);
        }
    }

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
                            <ul class="fabrics" data-testid="fabrics">
                                {#each bridge.fabrics as fabric (fabric.index)}
                                    <li class="fabric" data-testid="fabric">
                                        <div class="fabric-head">
                                            <span class="controller" data-testid="fabric-controller">{fabric.vendorName ?? t('Unknown controller')}</span>
                                            {#if fabric.label !== '' && fabric.label !== fabric.vendorName}<span class="ui-muted">“{fabric.label}”</span>{/if}
                                            <span
                                                class="ui-badge"
                                                class:ui-badge-ok={fabric.sessions > 0}
                                                title={t('Sessions of this controller with an active peer, and their subscriptions')}
                                                data-testid="fabric-sessions"
                                                >{fabric.sessions > 0
                                                    ? t('sessions: {sessions} · subscriptions: {subscriptions}', {
                                                          sessions: fabric.sessions,
                                                          subscriptions: fabric.subscriptions,
                                                      })
                                                    : t('no active session')}</span
                                            >
                                            <button type="button" class="ui-icon-button remove" title={t('Remove')} onclick={() => removeFabric(bridge, fabric)}
                                                ><Icon name="trash" /></button
                                            >
                                        </div>
                                        {#if fabric.vendorId === APPLE_KEYCHAIN}
                                            <p class="ui-faint ui-small hint" data-testid="fabric-hint">
                                                {t(
                                                    'Apple adds this fabric next to the Apple Home one when the bridge is paired from Apple Home; removing the bridge in Apple Home removes both.',
                                                )}
                                            </p>
                                        {/if}
                                        <dl class="ui-kv details">
                                            <dt>{t('Vendor id')}</dt>
                                            <dd><code>0x{hex(fabric.vendorId, 4)}</code></dd>
                                            <dt>{t('Fabric')}</dt>
                                            <dd>#{fabric.index} · <code>0x{hex(fabric.fabricId, 16)}</code></dd>
                                            <dt>{t('Bridge node id')}</dt>
                                            <dd><code data-testid="fabric-node-id">0x{hex(fabric.nodeId, 16)}</code></dd>
                                            <dt>{t('Controller node id')}</dt>
                                            <dd><code>0x{hex(fabric.rootNodeId, 16)}</code></dd>
                                            <dt title={t('The first half of the bridge’s operational mDNS name in this fabric')}>
                                                {t('Compressed fabric id')}
                                            </dt>
                                            <dd><code>{fabric.compressedFabricId}</code></dd>
                                            <dt>{t('Last contact')}</dt>
                                            <dd>{fabric.lastInteraction === undefined ? '—' : formatDateTime(fabric.lastInteraction)}</dd>
                                        </dl>
                                    </li>
                                {/each}
                            </ul>
                        {/if}
                    </div>
                </div>
            </section>
        {/each}
    </div>
</div>

<style>
    .fabrics {
        display: flex;
        flex-direction: column;
        gap: 8px;
        margin: 0;
        padding: 0;
        list-style: none;
    }

    .fabric {
        padding: 6px 8px;
        border: 1px solid var(--ui-border-muted);
        border-radius: var(--ui-radius);
    }

    .fabric-head {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
    }

    .controller {
        font-weight: 600;
    }

    .remove {
        margin-left: auto;
    }

    .hint {
        margin: 4px 0 0;
    }

    .details {
        margin-top: 6px;
        font-size: var(--ui-font-size-grid);
    }

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

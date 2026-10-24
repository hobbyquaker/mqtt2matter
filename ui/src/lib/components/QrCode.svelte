<script lang="ts">
    import QRCode from 'qrcode';

    interface Props {
        text: string;
        size?: number;
    }

    let {text, size = 180}: Props = $props();
    let canvas = $state<HTMLCanvasElement | undefined>(undefined);

    $effect(() => {
        if (canvas === undefined || text === '') {
            return;
        }
        void QRCode.toCanvas(canvas, text, {width: size, margin: 1, color: {dark: '#000000', light: '#ffffff'}});
    });
</script>

<canvas bind:this={canvas} class="qr" width={size} height={size} aria-label={text}></canvas>

<style>
    .qr {
        display: block;
        border: 4px solid #ffffff;
        border-radius: var(--ui-radius);
        background: #ffffff;
    }
</style>

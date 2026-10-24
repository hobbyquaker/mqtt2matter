<script lang="ts">
    /* The few icons the tables need, as inline SVG: a font cannot be trusted to have the glyphs. */
    interface Props {
        name: 'pause' | 'play' | 'copy' | 'download' | 'trash' | 'info' | 'close';
        size?: number;
    }

    let {name, size = 14}: Props = $props();

    const PATHS: Record<Props['name'], string> = {
        pause: 'M6 4h3v16H6zM15 4h3v16h-3z',
        play: 'M7 4l12 8-12 8z',
        copy: 'M8 8h12v12H8zM4 4h12v2H6v10H4z',
        download: 'M11 3h2v10.2l3.6-3.6 1.4 1.4-6 6-6-6 1.4-1.4L11 13.2zM4 19h16v2H4z',
        trash: 'M9 3h6v2h5v2H4V5h5zM6 8h12l-1 13H7zM10 10v9h1.5v-9zm2.5 0v9H14v-9z',
        info: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 2a8 8 0 1 1 0 16 8 8 0 0 1 0-16zm-1 3h2v2h-2zm0 4h2v6h-2z',
        close: 'M5.6 4.2 12 10.6l6.4-6.4 1.4 1.4-6.4 6.4 6.4 6.4-1.4 1.4-6.4-6.4-6.4 6.4-1.4-1.4 6.4-6.4-6.4-6.4z',
    };
</script>

<svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d={PATHS[name]} /></svg>

<script lang="ts">
    import {onMount} from 'svelte';

    import {session} from './lib/session.svelte.ts';
    import Login from './pages/Login.svelte';
    import Shell from './Shell.svelte';

    onMount(() => {
        void session.load();
    });
</script>

{#if session.state?.authenticated === true}
    <Shell />
{:else if session.state !== undefined || session.unreachable}
    <Login />
{/if}

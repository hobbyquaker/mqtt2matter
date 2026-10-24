import {mount} from 'svelte';

import App from './App.svelte';
import './app.css';
import {applyTheme} from './lib/theme.ts';

applyTheme();

const target = document.getElementById('app');
if (target === null) {
    throw new Error('no #app');
}

export default mount(App, {target});

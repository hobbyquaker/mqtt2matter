import {test as base} from '@playwright/test';

/** the base URL the global setup chose */
export const test = base.extend({
    baseURL: async ({}, use) => {
        await use(process.env.M2M_BASE_URL ?? 'http://127.0.0.1:0');
    },
});

export {expect} from '@playwright/test';

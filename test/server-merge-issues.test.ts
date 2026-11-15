import {describe, expect, it} from 'vitest';

import {mergeIssues} from '../src/server/server.ts';

describe('mergeIssues', () => {
    it('adds the strict issues once, an error replacing the same warning', () => {
        const live = [
            {level: 'warning' as const, path: 'endpoints[0]', message: 'Light: missing OnOff'},
            {level: 'error' as const, path: 'name', message: 'empty'},
        ];
        const strict = [
            {level: 'error' as const, path: 'name', message: 'empty'},
            {level: 'error' as const, path: 'endpoints[0]', message: 'Light: missing OnOff'},
            {level: 'error' as const, path: 'endpoints', message: 'startUpOnOff 99'},
        ];
        expect(mergeIssues(live, strict)).toEqual([
            {level: 'error', path: 'endpoints[0]', message: 'Light: missing OnOff'},
            {level: 'error', path: 'name', message: 'empty'},
            {level: 'error', path: 'endpoints', message: 'startUpOnOff 99'},
        ]);
    });
});

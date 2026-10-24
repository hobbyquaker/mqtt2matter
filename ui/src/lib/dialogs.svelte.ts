/* The shell's own confirm and prompt dialogs (never `window.confirm`): a promise per question, the
   host component in App.svelte renders the pending one. */

export interface ConfirmOptions {
    title?: string;
    confirm?: string;
    cancel?: string;
    danger?: boolean;
}

export interface PromptOptions extends ConfirmOptions {
    value?: string;
    placeholder?: string;
    /** a pattern the value must match before OK is enabled */
    pattern?: RegExp;
}

export type Pending =
    | {kind: 'confirm'; message: string; options: ConfirmOptions; resolve: (ok: boolean) => void}
    | {kind: 'prompt'; message: string; options: PromptOptions; resolve: (value: string | null) => void};

class Dialogs {
    pending = $state<Pending | undefined>(undefined);

    confirm(message: string, options: ConfirmOptions = {}): Promise<boolean> {
        return new Promise((resolve) => {
            this.pending = {kind: 'confirm', message, options, resolve};
        });
    }

    prompt(message: string, options: PromptOptions = {}): Promise<string | null> {
        return new Promise((resolve) => {
            this.pending = {kind: 'prompt', message, options, resolve};
        });
    }

    /** the host answers */
    settle(value: boolean | string | null): void {
        const pending = this.pending;
        this.pending = undefined;
        if (pending === undefined) {
            return;
        }
        if (pending.kind === 'confirm') {
            pending.resolve(value === true);
        } else {
            pending.resolve(typeof value === 'string' ? value : null);
        }
    }
}

export const dialogs = new Dialogs();

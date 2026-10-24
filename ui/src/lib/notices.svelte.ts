/* The toasts: an error never expires, an info line goes after a while; at most a few on screen. */

export type NoticeLevel = 'info' | 'warn' | 'error';

export interface Notice {
    id: number;
    level: NoticeLevel;
    message: string;
}

export const VISIBLE_NOTICES = 4;

class Notices {
    list = $state<Notice[]>([]);
    private next = 1;

    push(level: NoticeLevel, message: string): number {
        const id = this.next++;
        this.list = [...this.list, {id, level, message}];
        if (level !== 'error') {
            setTimeout(() => {
                this.dismiss(id);
            }, 6000);
        }
        return id;
    }

    info(message: string): void {
        this.push('info', message);
    }

    warn(message: string): void {
        this.push('warn', message);
    }

    error(message: string): void {
        this.push('error', message);
    }

    dismiss(id: number): void {
        this.list = this.list.filter((n) => n.id !== id);
    }
}

export const notices = new Notices();

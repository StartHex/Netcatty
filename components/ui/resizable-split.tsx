import React, { useCallback, useRef, useState } from 'react';
import { cn } from '../../lib/utils';
import { localStorageAdapter } from '@/infrastructure/persistence/localStorageAdapter';

/** Clamp a pane ratio so neither pane can be dragged completely out of view. */
export function clampSplitRatio(ratio: number, minRatio: number, maxRatio: number): number {
    const safe = Number.isFinite(ratio) ? ratio : maxRatio;
    return Math.max(minRatio, Math.min(maxRatio, safe));
}

/** Convert a pointer position inside a vertical container into a top-pane ratio. */
export function ratioFromPointer(
    pointerY: number,
    rectTop: number,
    rectHeight: number,
    minRatio: number,
    maxRatio: number,
): number {
    if (!(rectHeight > 0)) return maxRatio;
    return clampSplitRatio((pointerY - rectTop) / rectHeight, minRatio, maxRatio);
}

export const DEFAULT_SPLIT_RATIO = 0.5;
const MIN_SPLIT_RATIO = 0.15;
const MAX_SPLIT_RATIO = 0.85;
const KEYBOARD_STEP = 0.02;

export function useSplitRatio(
    storageKey: string | undefined,
    defaultRatio = DEFAULT_SPLIT_RATIO,
    minRatio = MIN_SPLIT_RATIO,
    maxRatio = MAX_SPLIT_RATIO,
): readonly [number, (next: number) => void] {
    const [ratio, setRatio] = useState(() => {
        const stored = storageKey ? localStorageAdapter.readNumber(storageKey) : null;
        return clampSplitRatio(stored ?? defaultRatio, minRatio, maxRatio);
    });

    const commit = useCallback(
        (next: number) => {
            setRatio((previous) => {
                const clamped = clampSplitRatio(next, minRatio, maxRatio);
                if (storageKey && Math.abs(clamped - previous) > 0.0005) {
                    localStorageAdapter.writeNumber(storageKey, clamped);
                }
                return clamped;
            });
        },
        [maxRatio, minRatio, storageKey],
    );

    return [ratio, commit] as const;
}

export function beginSplitDrag(
    event: React.PointerEvent<HTMLDivElement>,
    container: HTMLElement | null,
    commit: (ratio: number) => void,
    minRatio = MIN_SPLIT_RATIO,
    maxRatio = MAX_SPLIT_RATIO,
): void {
    if (!container) return;
    event.preventDefault();
    const rect = container.getBoundingClientRect();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    try {
        handle.setPointerCapture(pointerId);
    } catch {
        // Pointer capture is best effort; window listeners still work.
    }
    const onMove = (moveEvent: PointerEvent) => {
        commit(ratioFromPointer(moveEvent.clientY, rect.top, rect.height, minRatio, maxRatio));
    };
    const stop = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', stop);
        window.removeEventListener('pointercancel', stop);
        try {
            handle.releasePointerCapture(pointerId);
        } catch {
            // ignore
        }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
}

export interface SplitHandleProps {
    label: string;
    testId: string;
    ratio: number;
    minRatio?: number;
    maxRatio?: number;
    onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
    onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
    onDoubleClick?: () => void;
}

/** The draggable divider itself, shared by every vertical split in the app. */
export const SplitHandle: React.FC<SplitHandleProps> = ({
    label,
    testId,
    ratio,
    minRatio = MIN_SPLIT_RATIO,
    maxRatio = MAX_SPLIT_RATIO,
    onPointerDown,
    onKeyDown,
    onDoubleClick,
}) => (
    <div
        role="separator"
        aria-orientation="horizontal"
        aria-label={label}
        aria-valuenow={Math.round(ratio * 100)}
        aria-valuemin={Math.round(minRatio * 100)}
        aria-valuemax={Math.round(maxRatio * 100)}
        tabIndex={0}
        data-testid={testId}
        className={cn(
            'group relative flex h-1 shrink-0 cursor-row-resize items-center justify-center',
            'bg-border/60 transition-colors hover:bg-primary/50 focus:outline-none',
            'focus-visible:bg-primary/50 before:absolute before:-top-1.5 before:-bottom-1.5 before:left-0 before:right-0 before:content-[""]',
        )}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        onDoubleClick={onDoubleClick}
    />
);

export interface VerticalSplitProps {
    /** Pane shown above the divider; keeps the ratio-derived height. */
    top: React.ReactNode;
    /** Pane shown below the divider; absorbs the remaining height. */
    bottom: React.ReactNode;
    /** localStorage key that remembers the split; omit for a non-persistent split. */
    storageKey?: string;
    defaultRatio?: number;
    minRatio?: number;
    maxRatio?: number;
    /** Accessible name for the separator, e.g. t('curl.split.resize'). */
    handleLabel: string;
    className?: string;
    topClassName?: string;
    bottomClassName?: string;
    testId?: string;
}

/**
 * Two stacked panes with a draggable divider. Pointer, keyboard (ArrowUp/Down)
 * and double-click-to-reset are supported; the ratio is persisted per storageKey.
 */
export const VerticalSplit: React.FC<VerticalSplitProps> = ({
    top,
    bottom,
    storageKey,
    defaultRatio = DEFAULT_SPLIT_RATIO,
    minRatio = MIN_SPLIT_RATIO,
    maxRatio = MAX_SPLIT_RATIO,
    handleLabel,
    className,
    topClassName,
    bottomClassName,
    testId,
}) => {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const [ratio, setRatio] = useSplitRatio(storageKey, defaultRatio, minRatio, maxRatio);

    const beginDrag = useCallback(
        (event: React.PointerEvent<HTMLDivElement>) => {
            beginSplitDrag(event, containerRef.current, setRatio, minRatio, maxRatio);
        },
        [maxRatio, minRatio, setRatio],
    );

    const onKeyDown = useCallback(
        (event: React.KeyboardEvent<HTMLDivElement>) => {
            if (event.key === 'ArrowUp') {
                event.preventDefault();
                setRatio(ratio - KEYBOARD_STEP);
            } else if (event.key === 'ArrowDown') {
                event.preventDefault();
                setRatio(ratio + KEYBOARD_STEP);
            } else if (event.key === 'Home') {
                event.preventDefault();
                setRatio(defaultRatio);
            }
        },
        [defaultRatio, ratio, setRatio],
    );

    return (
        <div ref={containerRef} className={cn('flex min-h-0 min-w-0 flex-col', className)} data-testid={testId}>
            <div
                className={cn('flex min-h-0 min-w-0 flex-col', topClassName)}
                style={{ flexBasis: `${ratio * 100}%`, flexGrow: 0, flexShrink: 0 }}
            >
                {top}
            </div>
            <SplitHandle
                label={handleLabel}
                testId={testId ? `${testId}-handle` : 'split-handle'}
                ratio={ratio}
                minRatio={minRatio}
                maxRatio={maxRatio}
                onPointerDown={beginDrag}
                onKeyDown={onKeyDown}
                onDoubleClick={() => setRatio(defaultRatio)}
            />
            <div className={cn('flex min-h-0 min-w-0 flex-1 flex-col', bottomClassName)}>{bottom}</div>
        </div>
    );
};

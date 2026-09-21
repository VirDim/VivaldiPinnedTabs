/*
 * Vivaldi 8.2.4133.68
 * Custom auto-hiding scrollbar for vertical tabs.
 *
 * Design goals:
 * - native Vivaldi scrolling stays untouched;
 * - native scrollbar geometry stays untouched;
 * - the native scrollbar is merely made transparent by CSS;
 * - this script draws a visual scrollbar INSIDE the visible tab panel;
 * - it starts below pinned tabs + separator;
 * - it appears while scrolling and fades out afterwards;
 * - it never catches mouse events, so the Vivaldi resize handle keeps working;
 * - workspace/top/bottom toolbars are constrained to the visible tabbar width,
 *   while the scroll container keeps Vivaldi's original hidden scrollbar gutter.
 */

(() => {
    'use strict';

    const BAR_ID = 'oc-vtab-scrollbar';
    const HIDE_DELAY = 750;
    const MIN_THUMB = 28;

    let state = null;
    let rootObserver = null;
    let scheduled = false;

    function directSeparator(strip) {
        for (const child of strip.children) {
            if (child.classList && child.classList.contains('separator')) {
                return child;
            }
        }
        return null;
    }

    function findUi() {
        const tabbar = document.querySelector(
            '#tabs-tabbar-container.left, #tabs-tabbar-container.right'
        );

        if (!tabbar) return null;

        const tabsContainer = tabbar.querySelector('#tabs-container');
        const strip = tabsContainer?.querySelector('.tab-strip.overflow');

        if (!tabsContainer || !strip) return null;

        return {
            tabbar,
            tabsContainer,
            strip,
            separator: directSeparator(strip)
        };
    }

    function makeBar(tabbar) {
        let bar = tabbar.querySelector(`#${BAR_ID}`);

        if (bar) return bar;

        bar = document.createElement('div');
        bar.id = BAR_ID;
        bar.setAttribute('aria-hidden', 'true');

        const thumb = document.createElement('div');
        thumb.id = `${BAR_ID}-thumb`;

        bar.appendChild(thumb);
        tabbar.appendChild(bar);

        return bar;
    }

    function constrainToolbars(s) {
        /*
         * In this Vivaldi build the visible tabbar can be e.g. 282 px wide,
         * while #tabs-container is 12 px wider because Vivaldi keeps its
         * native scrollbar outside the visible panel.
         *
         * Only constrain toolbar rows (Workspace selector / + button etc.)
         * to the visible width. Never constrain .resize or .tab-strip.
         */
        const visibleWidth = s.tabbar.clientWidth;

        s.tabsContainer
            .querySelectorAll(':scope > .toolbar')
            .forEach(toolbar => {
                toolbar.style.width = `${visibleWidth}px`;
                toolbar.style.maxWidth = `${visibleWidth}px`;
                toolbar.style.boxSizing = 'border-box';
            });
    }

    function updateGeometry(s) {
        if (!s.strip.isConnected || !s.tabbar.isConnected) return;

        s.separator = directSeparator(s.strip);

        const tabbarRect = s.tabbar.getBoundingClientRect();
        const stripRect = s.strip.getBoundingClientRect();

        let trackTop;

        if (s.separator) {
            const separatorRect = s.separator.getBoundingClientRect();
            trackTop = separatorRect.bottom - tabbarRect.top;
        } else {
            trackTop = stripRect.top - tabbarRect.top;
        }

        trackTop = Math.max(0, trackTop);

        /*
         * End the custom scrollbar where the actual scroll strip ends,
         * not at the bottom "+" toolbar.
         */
        const trackBottom = Math.min(
            tabbarRect.height,
            stripRect.bottom - tabbarRect.top
        );

        const trackHeight = Math.max(0, trackBottom - trackTop);

        const bar = s.bar;
        const thumb = s.thumb;

        bar.style.top = `${trackTop}px`;
        bar.style.height = `${trackHeight}px`;

        if (s.tabbar.classList.contains('right')) {
            bar.style.left = '2px';
            bar.style.right = 'auto';
        } else {
            bar.style.right = '2px';
            bar.style.left = 'auto';
        }

        const maxScroll = Math.max(
            0,
            s.strip.scrollHeight - s.strip.clientHeight
        );

        if (maxScroll <= 0 || trackHeight <= 0) {
            bar.classList.remove('oc-visible');
            thumb.style.height = '0px';
            return false;
        }

        /*
         * The visible viewport for NORMAL tabs is trackHeight.
         * maxScroll comes from Vivaldi's real scroll container.
         */
        const effectiveContentHeight = trackHeight + maxScroll;

        let thumbHeight =
            trackHeight * (trackHeight / effectiveContentHeight);

        thumbHeight = Math.max(
            MIN_THUMB,
            Math.min(trackHeight, thumbHeight)
        );

        const travel = Math.max(0, trackHeight - thumbHeight);

        const ratio =
            maxScroll > 0
                ? Math.max(
                    0,
                    Math.min(1, s.strip.scrollTop / maxScroll)
                )
                : 0;

        const thumbTop = travel * ratio;

        thumb.style.height = `${thumbHeight}px`;
        thumb.style.transform = `translateY(${thumbTop}px)`;

        constrainToolbars(s);

        return true;
    }

    function showScrollbar(s) {
        if (!updateGeometry(s)) return;

        s.bar.classList.add('oc-visible');

        clearTimeout(s.hideTimer);

        s.hideTimer = setTimeout(() => {
            if (s.bar?.isConnected) {
                s.bar.classList.remove('oc-visible');
            }
        }, HIDE_DELAY);
    }

    function cleanupState() {
        if (!state) return;

        clearTimeout(state.hideTimer);

        state.abort?.abort();
        state.resizeObserver?.disconnect();
        state.stripObserver?.disconnect();

        if (state.bar?.isConnected) {
            state.bar.remove();
        }

        /*
         * Remove only inline styles added by this mod.
         */
        state.tabsContainer
            ?.querySelectorAll(':scope > .toolbar')
            .forEach(toolbar => {
                toolbar.style.removeProperty('width');
                toolbar.style.removeProperty('max-width');
                toolbar.style.removeProperty('box-sizing');
            });

        state = null;
    }

    function attach() {
        scheduled = false;

        const ui = findUi();

        if (!ui) {
            cleanupState();
            return;
        }

        if (
            state &&
            state.tabbar === ui.tabbar &&
            state.strip === ui.strip
        ) {
            state.separator = ui.separator;
            updateGeometry(state);
            return;
        }

        cleanupState();

        const bar = makeBar(ui.tabbar);
        const thumb = bar.querySelector(`#${BAR_ID}-thumb`);

        const abort = new AbortController();

        state = {
            ...ui,
            bar,
            thumb,
            abort,
            hideTimer: null,
            resizeObserver: null,
            stripObserver: null
        };

        const options = {
            passive: true,
            signal: abort.signal
        };

        /*
         * "scroll" moves the thumb.
         * "wheel" makes it visible immediately, even if the user is already
         * at the very top/bottom and scrollTop cannot change further.
         */
        ui.strip.addEventListener(
            'scroll',
            () => showScrollbar(state),
            options
        );

        ui.strip.addEventListener(
            'wheel',
            () => showScrollbar(state),
            options
        );

        /*
         * Also catch wheel events over pinned tabs. Vivaldi can route wheel
         * scrolling from them to the same strip.
         */
        ui.tabbar.addEventListener(
            'wheel',
            () => showScrollbar(state),
            options
        );

        const resizeObserver = new ResizeObserver(() => {
            if (state) updateGeometry(state);
        });

        resizeObserver.observe(ui.tabbar);
        resizeObserver.observe(ui.tabsContainer);
        resizeObserver.observe(ui.strip);

        if (ui.separator) {
            resizeObserver.observe(ui.separator);
        }

        state.resizeObserver = resizeObserver;

        /*
         * Pin/unpin, opening/closing tabs and workspace changes can replace
         * children without replacing the whole strip.
         */
        const stripObserver = new MutationObserver(() => {
            if (!state) return;

            const oldSeparator = state.separator;
            const newSeparator = directSeparator(state.strip);

            if (newSeparator !== oldSeparator) {
                state.separator = newSeparator;

                if (newSeparator) {
                    try {
                        state.resizeObserver.observe(newSeparator);
                    } catch (_) {}
                }
            }

            updateGeometry(state);
        });

        stripObserver.observe(ui.strip, {
            childList: true,
            subtree: false
        });

        state.stripObserver = stripObserver;

        updateGeometry(state);
    }

    function scheduleAttach() {
        if (scheduled) return;

        scheduled = true;

        requestAnimationFrame(attach);
    }

    /*
     * Vivaldi can rebuild its React UI after workspace/layout operations.
     * Reattach if the tabbar/strip node gets replaced.
     */
    function startRootObserver() {
        if (rootObserver) return;

        rootObserver = new MutationObserver(scheduleAttach);

        rootObserver.observe(document.documentElement, {
            childList: true,
            subtree: true
        });
    }

    function start() {
        scheduleAttach();
        startRootObserver();

        /*
         * One delayed pass helps after cold startup where Vivaldi mounts
         * the tab UI a little later.
         */
        setTimeout(scheduleAttach, 500);
        setTimeout(scheduleAttach, 1500);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, {
            once: true
        });
    } else {
        start();
    }
})();

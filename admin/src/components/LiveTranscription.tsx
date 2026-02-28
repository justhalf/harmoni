/**
 * LiveTranscription.tsx — Real-time dual-panel translation viewer for the admin dashboard.
 *
 * Connects to the server via WebSocket (/ws/listen with is_admin=true) and displays
 * synchronized Original + English text panels with live streaming updates.
 *
 * Key design decisions:
 * - createPortal for popover: The outer container uses backdrop-blur-xl which creates
 *   a new stacking context. Without createPortal, the popover would be clipped.
 * - activePopoverIdRef (useRef): Prevents stale closures in scroll/resize handlers.
 *   React state (activePopover) can be stale inside event handlers registered in
 *   useEffect. The ref always holds the latest ID. See Lesson #9 pattern.
 * - isAutoScrolling ref: Distinguishes auto-scroll (from new text) vs manual scroll.
 *   Manual scroll dismisses the popover; auto-scroll simply repositions it.
 * - overflow-hidden on grid: Prevents the Original text box from growing in height
 *   as new streamed text arrives. Both panels scroll internally instead.
 * - SRT export: Uses start_ms/end_ms from Soniox when available, with fallback
 *   timestamp estimation based on text length.
 * - mousedown dismiss: Uses document-level mousedown (not click) to dismiss the
 *   popover before React's synthetic click phase, ensuring instant response.
 */
import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

interface LiveTranscriptionProps {
    sessionToken: string;
}

type FontSize = 'small' | 'regular' | 'large';

interface TextSpan {
    id: string;
    orig: string;
    en: string;
    start_ms?: number;
    end_ms?: number;
    isLineBreak?: boolean;
    isSystemMessage?: boolean;
}

export default function LiveTranscription({ sessionToken }: LiveTranscriptionProps) {
    const [connectionState, setConnectionState] = useState<'idle' | 'connecting' | 'connected' | 'error'>('idle');
    const [hasConnectedOnce, setHasConnectedOnce] = useState(false);
    const [sonioxActive, setSonioxActive] = useState<boolean>(false);
    const [errorMsg, setErrorMsg] = useState<string>('');

    // Display Settings Menu State
    const [isDisplayMenuOpen, setIsDisplayMenuOpen] = useState(false);
    const [fontSize, setFontSize] = useState<FontSize>(() => {
        return (localStorage.getItem('adminFontSize') as FontSize) || 'regular';
    });
    const [showMoreBelow, setShowMoreBelow] = useState(false);
    const [isInitialLoad, setIsInitialLoad] = useState(false);

    // Admin uses dark mode by default, but we can allow toggling it back to light/slate
    const [isDarkMode, setIsDarkMode] = useState<boolean>(() => {
        const saved = localStorage.getItem('adminDarkMode');
        return saved ? JSON.parse(saved) : true;
    });

    useEffect(() => {
        localStorage.setItem('adminFontSize', fontSize);
    }, [fontSize]);

    useEffect(() => {
        localStorage.setItem('adminDarkMode', JSON.stringify(isDarkMode));
        if (isDarkMode) {
            document.documentElement.classList.add('dark');
        } else {
            document.documentElement.classList.remove('dark');
        }
    }, [isDarkMode]);

    const getFontSizeClass = () => {
        switch (fontSize) {
            case 'small': return 'text-base sm:text-lg';
            case 'large': return 'text-2xl sm:text-3xl';
            default: return 'text-xl sm:text-2xl';
        }
    };

    // --- Transcription data state ---
    // spans: finalized text segments with IDs, original text, English text, and timestamps.
    // draftTextEn/draftTextOrig: in-progress text from Soniox (not yet finalized).
    // pendingOrigRef: accumulates original-language tokens that arrive before their
    // corresponding English translation token, ensuring they're paired correctly.
    const [spans, setSpans] = useState<TextSpan[]>([]);
    const [draftTextEn, setDraftTextEn] = useState<string>('');
    const [draftTextOrig, setDraftTextOrig] = useState<string>('');
    const pendingOrigRef = useRef<string>('');

    // --- Popover state ---
    // activePopover: React state for rendering (contains id + orig text).
    // activePopoverIdRef: Mirror ref for use in event handlers that may capture
    //   stale closures (handleScroll, updatePopoverPosition, handleClickOutside).
    //   Both must be kept in sync on every popover open/close/switch.
    // popoverRect: DOMRect of the clicked span, used for positioning the popover.
    const [activePopover, setActivePopover] = useState<{ id: string; orig: string; } | null>(null);
    const activePopoverIdRef = useRef<string | null>(null);
    const [popoverRect, setPopoverRect] = useState<DOMRect | null>(null);

    const wsRef = useRef<WebSocket | null>(null);
    const scrollRefEn = useRef<HTMLDivElement>(null);
    const scrollRefOrig = useRef<HTMLDivElement>(null);

    const isAutoScrolling = useRef(false);
    const scrollTimeoutRef = useRef<number | null>(null);

    const STORAGE_KEY = 'harmoni-transcription-v1';
    const EXPIRY_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

    const displayMenuRef = useRef<HTMLDivElement>(null);
    const mobileMenuRef = useRef<HTMLDivElement>(null);
    const mobileTriggerRef = useRef<HTMLDivElement>(null);
    const shouldAutoScrollRef = useRef(false);

    // Fade-out parameters
    const [topAlpha, setTopAlpha] = useState(1);

    const generateId = () => Math.random().toString(36).substring(2, 11);

    const downloadSrt = (lang: 'en' | 'orig') => {
        if (spans.length === 0) return;

        let srtContent = '';
        let index = 1;

        let fallbackMs = 0; // Fallback for purely visual spans without timestamps (e.g., lines breaks or Soniox skipping them)

        for (const span of spans) {
            if (span.isLineBreak) {
                fallbackMs += 1000;
                continue;
            }

            const text = lang === 'en' ? span.en : span.orig;
            if (!text.trim() || text === '<end>' || span.isSystemMessage) continue;

            const startMs = span.start_ms ?? fallbackMs;
            const endMs = span.end_ms ?? (startMs + Math.max(1000, text.length * 50));

            fallbackMs = endMs + 500;

            const formatTime = (ms: number) => {
                const date = new Date(ms);
                const MathFloorHours = Math.floor(ms / 3600000);
                const UTCHours = String(MathFloorHours).padStart(2, '0');
                const UTCMinutes = String(date.getUTCMinutes()).padStart(2, '0');
                const UTCSeconds = String(date.getUTCSeconds()).padStart(2, '0');
                const UTCMilliseconds = String(date.getUTCMilliseconds()).padStart(3, '0');
                return `${UTCHours}:${UTCMinutes}:${UTCSeconds},${UTCMilliseconds}`;
            };

            srtContent += `${index}\n`;
            srtContent += `${formatTime(startMs)} --> ${formatTime(endMs)}\n`;
            srtContent += `${text}\n\n`;
            index++;
        }

        const blob = new Blob([srtContent], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const datestring = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        a.download = `GPBB_Transcription_${lang}_${datestring}.srt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    const updatePopoverPosition = () => {
        if (!activePopoverIdRef.current) return;
        const el = document.getElementById(`span-${activePopoverIdRef.current}`);
        if (!el) {
            setPopoverRect(null);
            return;
        }

        const rect = el.getBoundingClientRect();
        const container = scrollRefEn.current?.getBoundingClientRect();

        if (container) {
            if (rect.bottom < container.top || rect.top > container.bottom) {
                setPopoverRect(null);
                return;
            }
        }
        setPopoverRect(rect);
    };

    const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
        const target = e.currentTarget;
        const isEn = target === scrollRefEn.current;
        const other = isEn ? scrollRefOrig.current : scrollRefEn.current;

        const { scrollTop, scrollHeight, clientHeight } = target;
        const fadeThreshold = 200; // pixels to full fade

        // We only drive transparency and "more below" from the English box's scroll state
        if (isEn) {
            if (scrollHeight <= clientHeight + 10) {
                setTopAlpha(1.0);
            } else {
                let opacity = 1.0 - (scrollTop / fadeThreshold);
                if (opacity < 0.2) opacity = 0.2;
                else if (opacity > 1.0) opacity = 1.0;
                setTopAlpha(opacity);
            }

            // Hide "more below" if we reached the bottom of English
            if (scrollHeight - scrollTop - clientHeight < 50) {
                setShowMoreBelow(false);
            }
        }

        // Sync scroller for the OTHER box
        if (other && !isAutoScrolling.current) {
            const scrollRatio = scrollTop / (scrollHeight - clientHeight || 1);
            const otherHeight = other.scrollHeight;
            const otherClient = other.clientHeight;
            other.scrollTop = scrollRatio * (otherHeight - otherClient);
        }

        if (activePopoverIdRef.current) {
            if (!isAutoScrolling.current) {
                // Manual user scroll -> dismiss
                activePopoverIdRef.current = null;
                setActivePopover(null);
                setPopoverRect(null);
            } else {
                updatePopoverPosition();
            }
        }
    };

    const scrollToBottom = (behavior: ScrollBehavior = 'smooth') => {
        isAutoScrolling.current = true;
        const scrollOptsEn = { top: scrollRefEn.current?.scrollHeight, behavior };
        const scrollOptsOrig = { top: scrollRefOrig.current?.scrollHeight, behavior };

        scrollRefEn.current?.scrollTo(scrollOptsEn);
        scrollRefOrig.current?.scrollTo(scrollOptsOrig);

        if (scrollTimeoutRef.current) window.clearTimeout(scrollTimeoutRef.current);
        scrollTimeoutRef.current = window.setTimeout(() => {
            isAutoScrolling.current = false;
        }, 350);
    };

    // Auto-scroll effect after render
    useEffect(() => {
        if (shouldAutoScrollRef.current || isInitialLoad) {
            const isInit = isInitialLoad;

            // Synchronously clear flags so they don't leak if the effect re-runs
            shouldAutoScrollRef.current = false;
            if (isInit) setIsInitialLoad(false);

            const timer = setTimeout(() => {
                scrollToBottom(isInit ? 'auto' : 'smooth');
            }, isInit ? 300 : 50);

            return () => clearTimeout(timer);
        }
    }, [spans, draftTextEn, draftTextOrig, isInitialLoad]);

    // Update position whenever activePopover changes, or on window resize
    useEffect(() => {
        const handleResize = () => {
            isAutoScrolling.current = true;
            updatePopoverPosition();
            if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
            scrollTimeoutRef.current = window.setTimeout(() => {
                isAutoScrolling.current = false;
            }, 100);
        };
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, [activePopover]);
    // Tap outside to dismiss
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            const target = e.target as HTMLElement;

            // Handle Popover dismissal
            if (activePopover) {
                const isClickInPopover = target.closest('#translation-popover');
                const isClickOnSpan = target.closest('span[id^="span-"]');
                const isClickInEnBox = scrollRefEn.current?.contains(target);

                if (!isClickInPopover && (!isClickInEnBox || !isClickOnSpan)) {
                    activePopoverIdRef.current = null;
                    setActivePopover(null);
                    setPopoverRect(null);
                }
            }

            // Handle Display Menu dismissal
            if (isDisplayMenuOpen) {
                const inDesktop = displayMenuRef.current?.contains(target);
                const inMobileMenu = mobileMenuRef.current?.contains(target);
                const inMobileTrigger = mobileTriggerRef.current?.contains(target);

                if (!inDesktop && !inMobileMenu && !inMobileTrigger) {
                    setIsDisplayMenuOpen(false);
                }
            }
        };
        // Use mousedown instead of click to trigger before simulated/child bubbling
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [activePopover, isDisplayMenuOpen]);

    // Initial load from localStorage - only runs ONCE when refs are ready
    useEffect(() => {
        if (!scrollRefEn.current) return;
        if (isInitialLoad) return; // Only do this once

        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
            try {
                const { expiry, lastSaved, spans: savedSpans } = JSON.parse(saved);
                if (Date.now() < expiry) {
                    const filteredSpans = savedSpans.filter((s: TextSpan) => !s.isSystemMessage);

                    if (filteredSpans.length > 0) {
                        const savedDate = new Date(lastSaved || Date.now());
                        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
                        const dateStr = `${savedDate.getDate()} ${months[savedDate.getMonth()]} ${savedDate.getFullYear()}`;
                        const timeStr = `${String(savedDate.getHours()).padStart(2, '0')}:${String(savedDate.getMinutes()).padStart(2, '0')}`;

                        const indicatorSpan: TextSpan = {
                            id: `system-${Date.now()}`,
                            orig: `loaded data from ${dateStr}, ${timeStr}`,
                            en: `loaded data from ${dateStr}, ${timeStr}`,
                            isSystemMessage: true
                        };
                        setSpans([...filteredSpans, indicatorSpan]);
                        setIsInitialLoad(true);
                    }
                } else {
                    localStorage.removeItem(STORAGE_KEY);
                }
            } catch (e) {
                console.error("Failed to parse saved transcription", e);
                localStorage.removeItem(STORAGE_KEY);
            }
        }
    }, [sessionToken]);

    // Save to localStorage on change
    useEffect(() => {
        if (spans.length === 0) return;
        // Don't save if it's only the system message
        const realSpans = spans.filter(s => !s.isSystemMessage);
        if (realSpans.length === 0) return;

        const data = {
            expiry: Date.now() + EXPIRY_MS,
            lastSaved: Date.now(),
            spans: realSpans
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    }, [spans]);
    const [reconnectTrigger, setReconnectTrigger] = useState(0);
    const reconnectTimeoutRef = useRef<number | null>(null);

    // Auto-scroll to bottom as new text streams in
    useEffect(() => {
        if (scrollRefEn.current) {
            isAutoScrolling.current = true;
            scrollRefEn.current.scrollTop = scrollRefEn.current.scrollHeight;

            // Allow DOM repaint to settle before calculating offset rect
            requestAnimationFrame(() => {
                updatePopoverPosition();

                if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
                scrollTimeoutRef.current = window.setTimeout(() => {
                    isAutoScrolling.current = false;
                }, 100);
            });
        }
    }, [spans, draftTextEn, draftTextOrig]);

    useEffect(() => {
        if (!sessionToken) return;

        setConnectionState('connecting');
        const wsHost = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${wsHost}//${window.location.host}/ws/listen`;
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
            ws.send(JSON.stringify({ token: sessionToken, is_admin: true }));
            setConnectionState('connected');
            setHasConnectedOnce(true);
            setErrorMsg('');
        };

        ws.onmessage = (event) => {
            const wasAtBottom = scrollRefEn.current
                ? (isAutoScrolling.current || scrollRefEn.current.scrollHeight - scrollRefEn.current.scrollTop - scrollRefEn.current.clientHeight < 100)
                : true;

            try {
                const payload = JSON.parse(event.data);

                // Handle server-push status updates
                if (payload.type === 'status') {
                    setSonioxActive(payload.soniox_active ?? false);
                    return;
                }

                if (payload.tokens && Array.isArray(payload.tokens)) {
                    // Separate containers for this chunk tick
                    const incomingSpans: TextSpan[] = [];
                    let newDraftOrig = '';
                    let newDraftEn = '';
                    let currentSpanEn = '';
                    let minStartMs: number | undefined = undefined;
                    let maxEndMs: number | undefined = undefined;

                    payload.tokens.forEach((token: any) => {
                        const isTranslation = token.translation_status === 'translation' || token.translation_status === 'none';
                        const isOriginal = token.translation_status === 'original' || token.translation_status === 'none' || token.translation_status === undefined;

                        if (token.is_final) {
                            if (token.start_ms !== undefined && token.start_ms !== null) {
                                minStartMs = minStartMs === undefined ? token.start_ms : Math.min(minStartMs, token.start_ms);
                            }
                            if (token.end_ms !== undefined && token.end_ms !== null) {
                                maxEndMs = maxEndMs === undefined ? token.end_ms : Math.max(maxEndMs, token.end_ms);
                            }
                        }

                        if (token.text === '<end>') {
                            if (token.is_final) {
                                if (currentSpanEn || pendingOrigRef.current) {
                                    incomingSpans.push({
                                        id: generateId(),
                                        en: currentSpanEn,
                                        orig: pendingOrigRef.current,
                                        start_ms: minStartMs,
                                        end_ms: maxEndMs
                                    });
                                    currentSpanEn = '';
                                    pendingOrigRef.current = '';
                                    minStartMs = undefined;
                                    maxEndMs = undefined;
                                }
                                incomingSpans.push({ id: generateId(), en: '', orig: '', isLineBreak: true });
                            }
                            return;
                        }

                        if (token.is_final) {
                            if (isTranslation) {
                                currentSpanEn += token.text;
                            }
                            if (isOriginal) {
                                pendingOrigRef.current += token.text;
                            }
                        } else {
                            if (isTranslation) newDraftEn += token.text;
                            if (isOriginal) newDraftOrig += token.text;
                        }
                    });

                    // Flush any remaining English text at the end of the frame
                    if (currentSpanEn) {
                        incomingSpans.push({
                            id: generateId(),
                            en: currentSpanEn,
                            orig: pendingOrigRef.current,
                            start_ms: minStartMs,
                            end_ms: maxEndMs
                        });
                        pendingOrigRef.current = '';
                    }

                    // Update UI states
                    setDraftTextOrig(newDraftOrig);

                    if (incomingSpans.length > 0) {
                        setSpans(prev => {
                            const newSpans = [...prev];

                            incomingSpans.forEach(newSpan => {
                                if (newSpans.length === 0) {
                                    newSpans.push(newSpan);
                                    return;
                                }

                                const last = newSpans[newSpans.length - 1];

                                if (!newSpan.isLineBreak && !last.isLineBreak &&
                                    ((last.orig === newSpan.orig && newSpan.orig !== '') ||
                                        (last.orig === '' && newSpan.orig === ''))) {

                                    newSpans[newSpans.length - 1] = {
                                        ...last,
                                        en: last.en + newSpan.en,
                                        end_ms: newSpan.end_ms ?? last.end_ms
                                    };
                                } else {
                                    newSpans.push(newSpan);
                                }
                            });

                            return newSpans;
                        });
                    }

                    setDraftTextEn(newDraftEn);

                    // Handle auto-scroll or "more below" indicator
                    if (wasAtBottom) {
                        shouldAutoScrollRef.current = true;
                    } else if (newDraftEn || incomingSpans.length > 0) {
                        setShowMoreBelow(true);
                    }
                }
            } catch (err) {
                console.error("Failed to parse token payload", err);
            }
        };

        ws.onclose = (event) => {
            setConnectionState('error');
            if (event.code === 1008) {
                setErrorMsg('Invalid session token. You have been disconnected.');
            } else {
                // setErrorMsg('Lost connection. Reconnecting in 3s...');
                // Auto-reconnect
                reconnectTimeoutRef.current = window.setTimeout(() => {
                    setReconnectTrigger(prev => prev + 1);
                }, 3000);
            }
        };

        ws.onerror = (error) => {
            console.error("WebSocket Error:", error);
        };

        return () => {
            ws.onclose = null;
            ws.onerror = null;
            ws.close();
            if (reconnectTimeoutRef.current) {
                clearTimeout(reconnectTimeoutRef.current);
            }
        };
    }, [sessionToken, reconnectTrigger]);

    return (
        <div
            className={`flex flex-col p-4 sm:p-8 rounded-2xl shadow-xl border border-slate-700/50 h-[calc(100dvh-1rem)] sm:h-[calc(100dvh-2rem)] transition-colors duration-200 ${isDarkMode ? 'bg-slate-900/90 text-slate-100 backdrop-blur-xl' : 'bg-slate-50/90 text-slate-900 border-slate-300 backdrop-blur-xl'}`}
            onClick={() => setIsDisplayMenuOpen(false)}
        >
            {/* Header Strip */}
            <div className={`flex justify-between items-center mb-6 pb-4 shrink-0 border-b ${isDarkMode ? 'border-slate-700/50' : 'border-slate-300'}`}>
                <div className="flex items-center space-x-4">
                    <h3 className={`text-xl font-bold tracking-tight ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>
                        <span className="hidden sm:inline">Live Transcription Monitor</span>
                        <span className="sm:inline hidden"></span><span className="sm:hidden">Monitor</span>
                    </h3>

                    {/* Desktop Center Menu Strip */}
                    <div
                        ref={displayMenuRef}
                        className={`hidden sm:flex items-center rounded-lg shadow-sm mx-4 relative transition-colors border ${isDarkMode ? 'border-slate-700/50 bg-slate-800/50' : 'border-slate-300 bg-white'}`}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <button
                            disabled
                            onClick={(e) => { e.stopPropagation(); }}
                            className={`rounded-l-lg px-3 py-1.5 flex flex-row items-center justify-center transition-colors border-r focus:outline-none opacity-50 cursor-not-allowed ${isDarkMode ? 'border-slate-700/50 text-slate-400' : 'border-slate-300 text-slate-500'}`}
                        >
                            <svg className="w-4 h-4 mr-1.5" fill="none" viewBox="-2 -2 28 28" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12V9a9 9 0 00-18 0v3m0 0a3 3 0 00-3 3v2a3 3 0 003 3h2a1 1 0 001-1v-6a1 1 0 00-1-1H3m18 0a3 3 0 013 3v2a3 3 0 01-3 3h-2a1 1 0 01-1-1v-6a1 1 0 011-1h2z" /></svg>
                            <span className="text-sm font-medium">Listen</span>
                        </button>
                        <button
                            onClick={(e) => { e.stopPropagation(); setIsDisplayMenuOpen(!isDisplayMenuOpen); }}
                            className={`px-3 py-1.5 flex flex-row items-center justify-center transition-colors border-r focus:outline-none ${isDarkMode ? 'border-slate-700/50 hover:bg-slate-700 hover:text-white' : 'border-slate-300 hover:bg-slate-100 hover:text-slate-900'} ${isDisplayMenuOpen ? (isDarkMode ? 'bg-slate-700 text-white' : 'bg-slate-100 text-slate-900') : (isDarkMode ? 'text-slate-400' : 'text-slate-600')}`}
                        >
                            <svg className="w-4 h-4 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                            <span className="text-sm font-medium">Options</span>
                        </button>
                        <button
                            onClick={() => {
                                setSpans([]);
                                setDraftTextEn('');
                                setDraftTextOrig('');
                                pendingOrigRef.current = '';
                            }}
                            className={`rounded-r-lg px-3 py-1.5 flex flex-row items-center justify-center transition-colors focus:outline-none ${isDarkMode ? 'text-slate-300 hover:text-white hover:bg-slate-700/50' : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'}`}
                        >
                            <svg className="w-4 h-4 mr-1.5 text-rose-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                            <span className="text-sm font-medium">Clear</span>
                        </button>

                        {/* Desktop Display Pull-down */}
                        {isDisplayMenuOpen && (
                            <div
                                className={`absolute top-full left-1/2 -translate-x-1/2 mt-2 w-72 rounded-xl shadow-xl border z-50 p-4 ${isDarkMode ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}
                                onClick={(e) => e.stopPropagation()}
                            >
                                <h3 className={`text-sm font-bold mb-4 uppercase tracking-wider ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>Display Settings</h3>

                                <div className="mb-4">
                                    <label className={`text-xs font-semibold mb-2 block ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>Text Size</label>
                                    <div className={`flex rounded-lg p-1 ${isDarkMode ? 'bg-slate-900' : 'bg-slate-100'}`}>
                                        <button
                                            onClick={() => setFontSize('small')}
                                            className={`flex-1 py-1.5 text-sm font-medium rounded-md transition-colors ${fontSize === 'small' ? (isDarkMode ? 'bg-slate-700 shadow text-white' : 'bg-white shadow text-slate-900') : (isDarkMode ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-700')}`}
                                        >
                                            Small
                                        </button>
                                        <button
                                            onClick={() => setFontSize('regular')}
                                            className={`flex-1 py-1.5 text-sm font-medium rounded-md transition-colors ${fontSize === 'regular' ? (isDarkMode ? 'bg-slate-700 shadow text-white' : 'bg-white shadow text-slate-900') : (isDarkMode ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-700')}`}
                                        >
                                            Regular
                                        </button>
                                        <button
                                            onClick={() => setFontSize('large')}
                                            className={`flex-1 py-1.5 text-sm font-medium rounded-md transition-colors ${fontSize === 'large' ? (isDarkMode ? 'bg-slate-700 shadow text-white' : 'bg-white shadow text-slate-900') : (isDarkMode ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-700')}`}
                                        >
                                            Large
                                        </button>
                                    </div>
                                </div>

                                <div className="mb-4">
                                    <label className={`text-xs font-semibold mb-2 block ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>Export Settings</label>
                                    <div className="space-y-2">
                                        <button
                                            onClick={() => downloadSrt('orig')}
                                            className={`w-full py-2 px-3 text-sm font-medium rounded-lg transition-colors flex items-center justify-center ${isDarkMode ? 'bg-slate-700 hover:bg-slate-600 text-slate-200' : 'bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200'}`}
                                        >
                                            <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                                            Download Original (.srt)
                                        </button>
                                        <button
                                            onClick={() => downloadSrt('en')}
                                            className={`w-full py-2 px-3 text-sm font-medium rounded-lg transition-colors flex items-center justify-center ${isDarkMode ? 'bg-slate-700 hover:bg-slate-600 text-slate-200' : 'bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200'}`}
                                        >
                                            <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                                            Download Translation (.srt)
                                        </button>
                                    </div>
                                </div>

                                <div className={`flex items-center justify-between pt-2 border-t ${isDarkMode ? 'border-slate-700' : 'border-slate-200'}`}>
                                    <div className="flex items-center space-x-2">
                                        {isDarkMode ? (
                                            <svg className="w-5 h-5 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" /></svg>
                                        ) : (
                                            <svg className="w-5 h-5 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" /></svg>
                                        )}
                                        <span className={`text-sm font-medium ${isDarkMode ? 'text-slate-300' : 'text-slate-700'}`}>Dark Mode</span>
                                    </div>
                                    <button
                                        onClick={() => setIsDarkMode(!isDarkMode)}
                                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${isDarkMode ? 'bg-indigo-500' : 'bg-slate-300'}`}
                                    >
                                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${isDarkMode ? 'translate-x-6' : 'translate-x-1'}`} />
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
                <div className="flex items-center space-x-2 whitespace-nowrap shrink-0">
                    <span className={`text-sm ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>Status:</span>
                    {connectionState === 'connecting' && !hasConnectedOnce && <span className="text-yellow-500 font-medium tracking-wide select-none">Connecting...</span>}
                    {connectionState === 'connected' && sonioxActive && (
                        <span
                            className="relative group cursor-default text-emerald-500 font-medium tracking-wide select-none flex items-center gap-1.5"
                            style={{ WebkitTapHighlightColor: 'transparent', touchAction: 'manipulation' }}
                            onTouchStart={() => { }}
                        >
                            <span className="relative flex h-2.5 w-2.5 shrink-0">
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
                            </span>
                            <span>Live</span>
                            <span className={`absolute top-full right-0 mt-3 px-3 py-1.5 text-xs rounded-lg whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none shadow-lg z-50 ${isDarkMode ? 'bg-slate-700 text-white' : 'bg-white text-slate-900 border border-slate-200'}`}>
                                Translation streaming is live.
                                <div className={`absolute -top-[5px] right-4 w-2.5 h-2.5 rotate-45 border-t border-l ${isDarkMode ? 'bg-slate-700 border-slate-700' : 'bg-white border-slate-200'}`}></div>
                            </span>
                        </span>
                    )}
                    {connectionState === 'connected' && !sonioxActive && (
                        <span
                            className="relative group cursor-default text-yellow-500 font-medium tracking-wide select-none flex items-center"
                            style={{ WebkitTapHighlightColor: 'transparent', touchAction: 'manipulation' }}
                            onTouchStart={() => { }}
                        >
                            <span>● Stand By</span>
                            <span className={`absolute top-full right-0 mt-3 px-3 py-1.5 text-xs rounded-lg whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none shadow-lg z-50 ${isDarkMode ? 'bg-slate-700 text-white' : 'bg-white text-slate-900 border border-slate-200'}`}>
                                Wait for translation streaming to be activated.
                                <div className={`absolute -top-[5px] right-4 w-2.5 h-2.5 rotate-45 border-t border-l ${isDarkMode ? 'bg-slate-700 border-slate-700' : 'bg-white border-slate-200'}`}></div>
                            </span>
                        </span>
                    )}
                    {(connectionState === 'idle' || connectionState === 'error' || (connectionState === 'connecting' && hasConnectedOnce)) && (
                        <span
                            className="relative group cursor-default text-rose-500 font-medium tracking-wide select-none flex items-center"
                            style={{ WebkitTapHighlightColor: 'transparent', touchAction: 'manipulation' }}
                            onTouchStart={() => { }}
                        >
                            <span>Offline</span>
                            <span className={`absolute top-full right-0 mt-3 px-3 py-1.5 text-xs rounded-lg whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none shadow-lg z-50 ${isDarkMode ? 'bg-slate-700 text-white' : 'bg-white text-slate-900 border border-slate-200'}`}>
                                The server is not running. Check back later!
                                <div className={`absolute -top-[5px] right-4 w-2.5 h-2.5 rotate-45 border-t border-l ${isDarkMode ? 'bg-slate-700 border-slate-700' : 'bg-white border-slate-200'}`}></div>
                            </span>
                        </span>
                    )}
                    {errorMsg && <span className="text-rose-500 text-xs ml-2 select-none">({errorMsg})</span>}
                </div>
            </div>

            {/* Translation Viewer Container */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 flex-1 min-h-0 overflow-hidden">
                {/* Indonesian Box */}
                <div className={`flex flex-col min-h-0 rounded-xl p-4 sm:p-6 border shadow-inner transition-colors duration-200 ${isDarkMode ? 'bg-slate-900/50 border-slate-700/50' : 'bg-white border-slate-200'}`}>
                    <div className={`text-sm font-semibold mb-4 border-b pb-2 text-center shrink-0 select-none ${isDarkMode ? 'text-slate-400 border-slate-700/50' : 'text-slate-500 border-slate-200'}`}>
                        Original
                    </div>

                    <div
                        ref={scrollRefOrig}
                        onScroll={handleScroll}
                        className={`overflow-y-auto overflow-x-hidden leading-relaxed font-sans scrollbar-thin scrollbar-thumb-slate-600 scrollbar-track-transparent pr-2 flex-1 transition-colors duration-200 ${getFontSizeClass()} ${isDarkMode ? 'text-slate-200' : 'text-slate-800'}`}
                        style={{
                            WebkitMaskImage: `linear-gradient(to bottom, rgba(0,0,0,${topAlpha.toFixed(2)}) 0%, rgba(0,0,0,1) 30%)`,
                            maskImage: `linear-gradient(to bottom, rgba(0,0,0,${topAlpha.toFixed(2)}) 0%, rgba(0,0,0,1) 30%)`,
                            WebkitMaskSize: '100% 100%',
                            maskSize: '100% 100%',
                            WebkitMaskRepeat: 'no-repeat',
                            maskRepeat: 'no-repeat',
                        }}
                    >
                        {spans.length === 0 && draftTextOrig === '' ? (
                            <div className={`italic mt-4 text-center ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`}>
                                The original speech will appear here...
                            </div>
                        ) : (
                            <>
                                {(() => {
                                    const systemIdx = spans.findIndex(s => s.isSystemMessage);
                                    if (systemIdx === -1) {
                                        return (
                                            <p>
                                                {spans.map((span, index) => {
                                                    if (span.isLineBreak) {
                                                        if (index === 0 || spans[index - 1]?.isLineBreak) return null;
                                                        return <div key={`${span.id}-id`} className="h-4 sm:h-6 w-full shrink-0"></div>;
                                                    }
                                                    return <span key={`${span.id}-orig`} className="relative transition-colors">{span.orig}</span>;
                                                })}
                                                {draftTextOrig && <span className={`transition-opacity duration-200 ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`}>{draftTextOrig}</span>}
                                            </p>
                                        );
                                    }

                                    const oldSpans = spans.slice(0, systemIdx);
                                    const systemSpan = spans[systemIdx];
                                    const newSpans = spans.slice(systemIdx + 1);

                                    return (
                                        <>
                                            <p>
                                                {oldSpans.map((span, index) => {
                                                    if (span.isLineBreak) {
                                                        if (index === 0 || spans[index - 1]?.isLineBreak) return null;
                                                        return <div key={`${span.id}-id`} className="h-4 sm:h-6 w-full shrink-0"></div>;
                                                    }
                                                    return <span key={`${span.id}-orig`} className="relative transition-colors">{span.orig}</span>;
                                                })}
                                            </p>
                                            <div key={systemSpan.id} className="w-full flex items-center justify-center gap-2 sm:gap-4 mt-[3px] mb-3 opacity-90 select-none text-center">
                                                <div className="h-[1px] w-4 sm:w-8 bg-slate-200 dark:bg-slate-700/50"></div>
                                                <span className="text-[10px] sm:text-[11px] font-medium italic tracking-widest text-slate-500 dark:text-slate-400 whitespace-nowrap">{systemSpan.orig}</span>
                                                <div className="h-[1px] w-4 sm:w-8 bg-slate-200 dark:bg-slate-700/50"></div>
                                            </div>
                                            <p>
                                                {newSpans.map((span, index) => {
                                                    if (span.isLineBreak) {
                                                        // index is relative to newSpans here, but checking local index is usually fine for formatting
                                                        if (index === 0 || newSpans[index - 1]?.isLineBreak) return null;
                                                        return <div key={`${span.id}-id`} className="h-4 sm:h-6 w-full shrink-0"></div>;
                                                    }
                                                    return <span key={`${span.id}-orig`} className="relative transition-colors">{span.orig}</span>;
                                                })}
                                                {draftTextOrig && <span className={`transition-opacity duration-200 ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`}>{draftTextOrig}</span>}
                                            </p>
                                        </>
                                    );
                                })()}
                            </>
                        )}
                    </div>
                </div>

                {/* English Box */}
                <div className={`flex flex-col min-h-0 rounded-xl p-4 sm:p-6 border shadow-inner transition-colors duration-200 ${isDarkMode ? 'bg-slate-900/50 border-slate-700/50' : 'bg-white border-slate-200'}`}>
                    <div className={`text-sm font-semibold mb-4 border-b pb-2 text-center shrink-0 select-none ${isDarkMode ? 'text-slate-400 border-slate-700/50' : 'text-slate-500 border-slate-200'}`}>
                        English
                    </div>

                    <div
                        ref={scrollRefEn}
                        onScroll={handleScroll}
                        className={`overflow-y-auto overflow-x-hidden leading-relaxed font-sans scrollbar-thin scrollbar-thumb-slate-600 scrollbar-track-transparent pr-2 flex-1 relative transition-colors duration-200 ${getFontSizeClass()} ${isDarkMode ? 'text-slate-200' : 'text-slate-800'}`}
                        style={{
                            WebkitMaskImage: `linear-gradient(to bottom, rgba(0,0,0,${topAlpha.toFixed(2)}) 0%, rgba(0,0,0,1) 30%)`,
                            maskImage: `linear-gradient(to bottom, rgba(0,0,0,${topAlpha.toFixed(2)}) 0%, rgba(0,0,0,1) 30%)`,
                            WebkitMaskSize: '100% 100%',
                            maskSize: '100% 100%',
                            WebkitMaskRepeat: 'no-repeat',
                            maskRepeat: 'no-repeat',
                        }}
                    >
                        {spans.length === 0 && draftTextEn === '' ? (
                            <div className={`italic mt-4 text-center ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`}>
                                Waiting for the speaker to begin...
                            </div>
                        ) : (
                            <>
                                {(() => {
                                    const systemIdx = spans.findIndex(s => s.isSystemMessage);
                                    if (systemIdx === -1) {
                                        return (
                                            <p>
                                                {spans.map((span, index) => {
                                                    if (span.isLineBreak) {
                                                        if (index === 0 || spans[index - 1]?.isLineBreak) return null;
                                                        return <div key={span.id} className="h-4 sm:h-6 w-full shrink-0"></div>;
                                                    }
                                                    return (
                                                        <span
                                                            key={span.id} id={`span-${span.id}`}
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                if (span.orig.trim() && span.orig !== '<end>') {
                                                                    if (activePopover?.id === span.id) {
                                                                        activePopoverIdRef.current = null;
                                                                        setActivePopover(null);
                                                                        setPopoverRect(null);
                                                                    } else {
                                                                        activePopoverIdRef.current = span.id;
                                                                        setActivePopover({ id: span.id, orig: span.orig });
                                                                        setPopoverRect(e.currentTarget.getBoundingClientRect());
                                                                    }
                                                                }
                                                            }}
                                                            className={`relative transition-colors rounded ${span.orig.trim() && span.orig !== '<end>' ? (isDarkMode ? 'cursor-pointer hover:bg-slate-700' : 'cursor-pointer hover:bg-slate-200') : ''} ${activePopover?.id === span.id ? (isDarkMode ? 'bg-indigo-900/50' : 'bg-indigo-100') : ''}`}
                                                        >
                                                            {span.en}
                                                        </span>
                                                    );
                                                })}
                                                {draftTextEn && <span className={`transition-opacity duration-200 ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`}>{draftTextEn}</span>}
                                            </p>
                                        );
                                    }

                                    const oldSpans = spans.slice(0, systemIdx);
                                    const systemSpan = spans[systemIdx];
                                    const newSpans = spans.slice(systemIdx + 1);

                                    return (
                                        <>
                                            <p>
                                                {oldSpans.map((span, index) => {
                                                    if (span.isLineBreak) {
                                                        if (index === 0 || spans[index - 1]?.isLineBreak) return null;
                                                        return <div key={span.id} className="h-4 sm:h-6 w-full shrink-0"></div>;
                                                    }
                                                    return (
                                                        <span
                                                            key={span.id} id={`span-${span.id}`}
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                if (span.orig.trim() && span.orig !== '<end>') {
                                                                    if (activePopover?.id === span.id) {
                                                                        activePopoverIdRef.current = null;
                                                                        setActivePopover(null);
                                                                        setPopoverRect(null);
                                                                    } else {
                                                                        activePopoverIdRef.current = span.id;
                                                                        setActivePopover({ id: span.id, orig: span.orig });
                                                                        setPopoverRect(e.currentTarget.getBoundingClientRect());
                                                                    }
                                                                }
                                                            }}
                                                            className={`relative transition-colors rounded ${span.orig.trim() && span.orig !== '<end>' ? (isDarkMode ? 'cursor-pointer hover:bg-slate-700' : 'cursor-pointer hover:bg-slate-200') : ''} ${activePopover?.id === span.id ? (isDarkMode ? 'bg-indigo-900/50' : 'bg-indigo-100') : ''}`}
                                                        >
                                                            {span.en}
                                                        </span>
                                                    );
                                                })}
                                            </p>
                                            <div key={systemSpan.id} className="w-full flex items-center justify-center gap-2 sm:gap-4 mt-[3px] mb-3 opacity-90 select-none text-center">
                                                <div className="h-[1px] w-4 sm:w-8 bg-slate-200 dark:bg-slate-700/50"></div>
                                                <span className="text-[10px] sm:text-[11px] font-medium italic tracking-widest text-slate-500 dark:text-slate-400 whitespace-nowrap">{systemSpan.en}</span>
                                                <div className="h-[1px] w-4 sm:w-8 bg-slate-200 dark:bg-slate-700/50"></div>
                                            </div>
                                            <p>
                                                {newSpans.map((span, index) => {
                                                    if (span.isLineBreak) {
                                                        if (index === 0 || newSpans[index - 1]?.isLineBreak) return null;
                                                        return <div key={span.id} className="h-4 sm:h-6 w-full shrink-0"></div>;
                                                    }
                                                    return (
                                                        <span
                                                            key={span.id} id={`span-${span.id}`}
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                if (span.orig.trim() && span.orig !== '<end>') {
                                                                    if (activePopover?.id === span.id) {
                                                                        activePopoverIdRef.current = null;
                                                                        setActivePopover(null);
                                                                        setPopoverRect(null);
                                                                    } else {
                                                                        activePopoverIdRef.current = span.id;
                                                                        setActivePopover({ id: span.id, orig: span.orig });
                                                                        setPopoverRect(e.currentTarget.getBoundingClientRect());
                                                                    }
                                                                }
                                                            }}
                                                            className={`relative transition-colors rounded ${span.orig.trim() && span.orig !== '<end>' ? (isDarkMode ? 'cursor-pointer hover:bg-slate-700' : 'cursor-pointer hover:bg-slate-200') : ''} ${activePopover?.id === span.id ? (isDarkMode ? 'bg-indigo-900/50' : 'bg-indigo-100') : ''}`}
                                                        >
                                                            {span.en}
                                                        </span>
                                                    );
                                                })}
                                                {draftTextEn && <span className={`transition-opacity duration-200 ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`}>{draftTextEn}</span>}
                                            </p>
                                        </>
                                    );
                                })()}
                            </>
                        )}
                    </div>

                    {/* Floating "More Below" indicator */}
                    {showMoreBelow && (
                        <div
                            className="absolute bottom-6 left-1/2 -translate-x-1/2 z-40 transition-all duration-300 animate-bounce"
                        >
                            <button
                                onClick={() => scrollToBottom('smooth')}
                                className={`flex items-center space-x-2 px-4 py-2 rounded-full shadow-lg border transition-all ${isDarkMode ? 'bg-indigo-600 border-indigo-500 text-white hover:bg-indigo-500' : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'}`}
                            >
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                                </svg>
                                <span className="text-xs font-bold uppercase tracking-wider">More Below</span>
                            </button>
                        </div>
                    )}
                </div>
            </div>

            {/* Fixed Overlay Popover */}
            {(function renderPopover() {
                if (!activePopover || !popoverRect) return null;

                const rect = popoverRect;
                const { orig } = activePopover;
                // Auto-flip tracking: if we're near the bottom of the screen, flip above
                const spaceBelow = window.innerHeight - rect.bottom;
                const isBottomHalf = spaceBelow < 150 && rect.top > 150;

                // Exact screen dimension tracking for X clamping
                const centerX = rect.left + rect.width / 2;
                const popoverWidth = Math.min(window.innerWidth * 0.85, 320);

                let leftPos = centerX - popoverWidth / 2;
                const padding = 16;
                // Force the box to stay fully on-screen
                if (leftPos < padding) leftPos = padding;
                if (leftPos + popoverWidth > window.innerWidth - padding) leftPos = window.innerWidth - popoverWidth - padding;

                // Ensure triangle precisely targets the word center regardless of box clamp
                const pointerLeft = centerX - leftPos;

                return createPortal(
                    <div
                        key={activePopover.id}
                        id="translation-popover"
                        className={`fixed z-[100] p-3 text-sm rounded-lg shadow-2xl cursor-auto font-normal leading-snug ${isDarkMode ? 'bg-slate-100 text-slate-900' : 'bg-slate-800 text-white'}`}
                        style={{
                            width: popoverWidth,
                            left: leftPos,
                            ...(isBottomHalf ? {
                                bottom: window.innerHeight - rect.top + 8
                            } : {
                                top: rect.bottom + 8
                            })
                        }}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <span className={`block font-semibold mb-1 text-[10px] uppercase tracking-wider ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`}>Original</span>
                        {orig}
                        <span
                            className={`absolute border-[6px] border-transparent ${isBottomHalf ? (isDarkMode ? 'top-full border-t-slate-100' : 'top-full border-t-slate-800') : (isDarkMode ? 'bottom-full border-b-slate-100' : 'bottom-full border-b-slate-800')}`}
                            style={{ left: Math.max(8, Math.min(pointerLeft - 6, popoverWidth - 20)) }}
                        ></span>
                    </div>,
                    document.body
                );
            })()}

            {/* Mobile Bottom Navigation Bar / Display Dropdown combo */}
            {isDisplayMenuOpen && (
                <div
                    ref={mobileMenuRef}
                    className={`sm:hidden fixed bottom-16 left-2 right-2 rounded-xl shadow-[0_-4px_16px_rgba(0,0,0,0.15)] border z-50 p-4 ${isDarkMode ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}
                    onClick={(e) => e.stopPropagation()}
                >
                    <h3 className={`text-sm font-bold mb-4 uppercase tracking-wider ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>Display Settings</h3>

                    <div className="mb-4">
                        <label className={`text-xs font-semibold mb-2 block ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>Text Size</label>
                        <div className={`flex rounded-lg p-1 ${isDarkMode ? 'bg-slate-900' : 'bg-slate-100'}`}>
                            <button
                                onClick={() => setFontSize('small')}
                                className={`flex-1 py-1.5 text-sm font-medium rounded-md transition-colors ${fontSize === 'small' ? (isDarkMode ? 'bg-slate-700 shadow text-white' : 'bg-white shadow text-slate-900') : (isDarkMode ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-700')}`}
                            >
                                Small
                            </button>
                            <button
                                onClick={() => setFontSize('regular')}
                                className={`flex-1 py-1.5 text-sm font-medium rounded-md transition-colors ${fontSize === 'regular' ? (isDarkMode ? 'bg-slate-700 shadow text-white' : 'bg-white shadow text-slate-900') : (isDarkMode ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-700')}`}
                            >
                                Regular
                            </button>
                            <button
                                onClick={() => setFontSize('large')}
                                className={`flex-1 py-1.5 text-sm font-medium rounded-md transition-colors ${fontSize === 'large' ? (isDarkMode ? 'bg-slate-700 shadow text-white' : 'bg-white shadow text-slate-900') : (isDarkMode ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-700')}`}
                            >
                                Large
                            </button>
                        </div>
                    </div>

                    <div className="mb-4">
                        <label className={`text-xs font-semibold mb-2 block ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>Export Settings</label>
                        <div className="space-y-2">
                            <button
                                onClick={() => downloadSrt('orig')}
                                className={`w-full py-2.5 px-3 text-sm font-medium rounded-lg transition-colors flex items-center justify-center ${isDarkMode ? 'bg-slate-700 hover:bg-slate-600 text-slate-200' : 'bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200'}`}
                            >
                                <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                                Download Original (.srt)
                            </button>
                            <button
                                onClick={() => downloadSrt('en')}
                                className={`w-full py-2.5 px-3 text-sm font-medium rounded-lg transition-colors flex items-center justify-center ${isDarkMode ? 'bg-slate-700 hover:bg-slate-600 text-slate-200' : 'bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200'}`}
                            >
                                <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                                Download Translation (.srt)
                            </button>
                        </div>
                    </div>

                    <div className={`flex items-center justify-between pt-2 border-t ${isDarkMode ? 'border-slate-700' : 'border-slate-200'}`}>
                        <div className="flex items-center space-x-2">
                            {isDarkMode ? (
                                <svg className="w-5 h-5 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" /></svg>
                            ) : (
                                <svg className="w-5 h-5 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" /></svg>
                            )}
                            <span className={`text-sm font-medium ${isDarkMode ? 'text-slate-300' : 'text-slate-700'}`}>Dark Mode</span>
                        </div>
                        <button
                            onClick={() => setIsDarkMode(!isDarkMode)}
                            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${isDarkMode ? 'bg-indigo-500' : 'bg-slate-300'}`}
                        >
                            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${isDarkMode ? 'translate-x-6' : 'translate-x-1'}`} />
                        </button>
                    </div>
                </div>
            )}

            <div
                ref={mobileTriggerRef}
                className={`sm:hidden shrink-0 mt-1 flex justify-around items-center z-40 border-t ${isDarkMode ? 'border-slate-700/50' : 'border-slate-300'}`}
            >
                <button
                    disabled
                    onClick={(e) => { e.stopPropagation(); }}
                    className={`px-2 py-1 flex flex-col items-center justify-center focus:outline-none transition-colors text-slate-400 opacity-50 cursor-not-allowed`}
                >
                    <svg className="w-5 h-5 mb-0.5" fill="none" viewBox="-2 -2 28 28" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12V9a9 9 0 00-18 0v3m0 0a3 3 0 00-3 3v2a3 3 0 003 3h2a1 1 0 001-1v-6a1 1 0 00-1-1H3m18 0a3 3 0 013 3v2a3 3 0 01-3 3h-2a1 1 0 01-1-1v-6a1 1 0 011-1h2z" /></svg>
                    <span className="text-[10px] font-medium">Listen</span>
                </button>
                <button
                    onClick={(e) => { e.stopPropagation(); setIsDisplayMenuOpen(!isDisplayMenuOpen); }}
                    className={`px-2 py-1 flex flex-col items-center justify-center focus:outline-none transition-colors ${isDisplayMenuOpen ? (isDarkMode ? 'text-indigo-400' : 'text-indigo-600') : (isDarkMode ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-700')}`}
                >
                    <svg className="w-5 h-5 mb-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                    <span className="text-[10px] font-medium">Options</span>
                </button>
                <button
                    onClick={() => {
                        setSpans([]);
                        setDraftTextEn('');
                        setDraftTextOrig('');
                        pendingOrigRef.current = '';
                    }}
                    className="px-2 py-1 flex flex-col items-center justify-center text-rose-400 hover:text-rose-300 focus:outline-none transition-colors"
                >
                    <svg className="w-5 h-5 mb-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                    <span className="text-[10px] font-medium">Clear</span>
                </button>
            </div>
        </div>
    );
}

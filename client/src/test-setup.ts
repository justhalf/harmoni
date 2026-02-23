import '@testing-library/jest-dom';

// jsdom doesn't implement window.matchMedia — mock it for components
// that check prefers-color-scheme (e.g., App.tsx dark mode initializer).
Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => { },
        removeListener: () => { },
        addEventListener: () => { },
        removeEventListener: () => { },
        dispatchEvent: () => false,
    }),
});

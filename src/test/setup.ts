import "@testing-library/jest-dom/vitest";

// jsdom does not implement matchMedia; app-store reads it at module eval to pick
// the initial theme. Provide a standard no-op shim so store/component tests can
// import the app without throwing.
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

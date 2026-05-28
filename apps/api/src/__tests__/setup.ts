const DEBUG_PREFIXES = [
  "[InputRealism]",
  "[PointerState]",
  "[PointerDebugOverlay]",
  "[PointerProfile]",
  "[PointerNav]",
  "[PointerFocus]",
  "[CdpInjection]",
  "[TaskBrowser]",
  "[InjectionLifecycle]",
  "[AuthLifecycle]",
  "[CdpTargetSelection]",
];

const _origLog = console.log;
console.log = (...args: unknown[]): void => {
  if (typeof args[0] === "string" && DEBUG_PREFIXES.some((p) => (args[0] as string).startsWith(p))) {
    return;
  }
  _origLog(...args);
};

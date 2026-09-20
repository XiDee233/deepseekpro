// Replaced by Vite for every browser build; tests/source execution are explicit.
declare const __DPP_BUILD_ID__: string;
export const DIAGNOSTIC_BUILD_ID = typeof __DPP_BUILD_ID__ === 'string'
  ? __DPP_BUILD_ID__ : 'unbundled';

/**
 * Lightweight startup-phase timing, enabled by setting TAD_STARTUP_PROF
 * in the environment. Times are process uptime, so they include Electron
 * boot and module loading before our code runs.
 */
export const profLog = (phase: string) => {
  // bracket access so webpack DefinePlugin doesn't constant-fold process.env
  if ((process as any)["env"]["TAD_STARTUP_PROF"]) {
    console.log(
      `[startup] ${phase}: ${(process.uptime() * 1000).toFixed(0)}ms`
    );
  }
};

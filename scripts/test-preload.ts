/**
 * Runs before any test module is imported.
 *
 * Ink asks `is-in-ci` whether it is running in CI, at import time, and when the
 * answer is yes it stops rendering incrementally: frames are written only at
 * unmount. The TUI tests drive a mounted app and read what is on screen, so on a
 * CI runner every one of them saw an empty buffer while passing locally.
 *
 * Clearing the variable here, before the first import, makes the renderer behave
 * the same everywhere. Nothing in earshot itself reads CI; only the renderer
 * under test does.
 */
delete process.env.CI;
delete process.env.CONTINUOUS_INTEGRATION;
delete process.env.GITHUB_ACTIONS;

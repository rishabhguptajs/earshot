/**
 * Runs the real CLI entry point (`main`) as a subprocess, the way the
 * published `earshot` bin does. A direct call to `main()` in-process would
 * share this test runner's stdin, which is exactly the thing under test here -
 * whether the command ever reads it.
 */
import { main } from '../../src/index.ts';

process.exit(await main(process.argv.slice(2)));

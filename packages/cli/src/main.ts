import { main } from './index.ts';

const code = await main();
process.exitCode = code;

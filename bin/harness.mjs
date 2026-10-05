#!/usr/bin/env node
// Runs core/cli.ts through tsx: no build step, so a dropped-in plugin loads on the next run.
import { register } from 'tsx/esm/api';

register();
const { main } = await import('../core/cli.ts');
process.exitCode = await main(process.argv.slice(2));

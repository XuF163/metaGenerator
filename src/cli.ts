#!/usr/bin/env node
/**
 * metaGenerator CLI entry.
 *
 * Design goals:
 * - Keep dependencies minimal (Node built-ins only for MVP).
 * - Provide stable, scriptable CLI for CI/cron.
 * - Keep commands modular so generation logic can grow without turning into a monolith.
 */

import { runCli } from './main.js'

await runCli(process.argv)


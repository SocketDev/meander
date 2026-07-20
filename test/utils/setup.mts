/**
 * @file Vitest setup: silence noisy env/debug channels.
 */

import process from 'node:process'

process.env['DEBUG'] = ''
delete process.env['NODE_DEBUG']

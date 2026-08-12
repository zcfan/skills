#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const repositoryRoot = path.resolve(__dirname, '..');
const source = path.join(repositoryRoot, 'skills', 'playwright-shared-auth-setup', 'scripts', 'shared_auth_common.cjs');
const targets = [
  path.join(repositoryRoot, 'skills', 'playwright-shared-auth-login', 'scripts', 'shared_auth_common.cjs'),
  path.join(repositoryRoot, 'skills', 'playwright-shared-auth-launch', 'scripts', 'shared_auth_common.cjs'),
];

for (const target of targets) fs.copyFileSync(source, target);
console.log(`Synced ${targets.length} shared helper copies.`);

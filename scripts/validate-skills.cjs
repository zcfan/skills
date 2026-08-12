#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repositoryRoot = path.resolve(__dirname, '..');
const skillsRoot = path.join(repositoryRoot, 'skills');
const failures = [];

function fail(message) {
  failures.push(message);
}

function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return JSON.parse(trimmed);
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replace(/''/g, "'");
  return trimmed;
}

function frontmatterFor(skillFile) {
  const content = fs.readFileSync(skillFile, 'utf8');
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    fail(`${skillFile}: missing or malformed YAML frontmatter`);
    return null;
  }
  const values = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line || /^\s/.test(line)) continue;
    const entry = line.match(/^([a-zA-Z0-9-]+):\s*(.*)$/);
    if (!entry) {
      fail(`${skillFile}: unsupported frontmatter line: ${line}`);
      continue;
    }
    values[entry[1]] = unquote(entry[2]);
  }
  return values;
}

function validateNoSymlinks(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) {
      fail(`${target}: skills must be self-contained; symlinks are not allowed`);
    } else if (stat.isDirectory()) {
      validateNoSymlinks(target);
    }
  }
}

function validateOpenAiYaml(skillDir, skillName) {
  const metadataFile = path.join(skillDir, 'agents', 'openai.yaml');
  if (!fs.existsSync(metadataFile)) return;
  const content = fs.readFileSync(metadataFile, 'utf8');
  const fields = {};
  for (const field of ['display_name', 'short_description', 'default_prompt']) {
    const match = content.match(new RegExp(`^\\s{2}${field}:\\s*("(?:[^"\\\\]|\\\\.)*")\\s*$`, 'm'));
    if (!match) {
      fail(`${metadataFile}: ${field} must be present and double-quoted`);
      continue;
    }
    fields[field] = JSON.parse(match[1]);
  }
  if (fields.short_description && (fields.short_description.length < 25 || fields.short_description.length > 64)) {
    fail(`${metadataFile}: short_description must contain 25-64 characters`);
  }
  if (fields.default_prompt && !fields.default_prompt.includes(`$${skillName}`)) {
    fail(`${metadataFile}: default_prompt must mention $${skillName}`);
  }
}

function validateScripts(skillDir) {
  const scriptsDir = path.join(skillDir, 'scripts');
  if (!fs.existsSync(scriptsDir)) return;
  for (const entry of fs.readdirSync(scriptsDir)) {
    if (!entry.endsWith('.cjs')) continue;
    const script = path.join(scriptsDir, entry);
    const result = spawnSync(process.execPath, ['--check', script], { encoding: 'utf8' });
    if (result.status !== 0) fail(`${script}: ${String(result.stderr || result.stdout).trim()}`);
  }
}

const skillDirectories = fs.readdirSync(skillsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

for (const skillName of skillDirectories) {
  const skillDir = path.join(skillsRoot, skillName);
  const skillFile = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillFile)) {
    fail(`${skillDir}: SKILL.md is required`);
    continue;
  }
  const frontmatter = frontmatterFor(skillFile);
  if (frontmatter) {
    const allowed = new Set(['name', 'description']);
    for (const key of Object.keys(frontmatter)) {
      if (!allowed.has(key)) fail(`${skillFile}: unexpected frontmatter key ${key}`);
    }
    if (frontmatter.name !== skillName) fail(`${skillFile}: name must match directory ${skillName}`);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(frontmatter.name || '') || frontmatter.name.length > 64) {
      fail(`${skillFile}: name must be kebab-case and at most 64 characters`);
    }
    if (!frontmatter.description || frontmatter.description.length > 1024 || /[<>]/.test(frontmatter.description)) {
      fail(`${skillFile}: description is required, at most 1024 characters, and cannot contain angle brackets`);
    }
  }
  validateNoSymlinks(skillDir);
  validateOpenAiYaml(skillDir, skillName);
  validateScripts(skillDir);
}

if (failures.length) {
  for (const failure of failures) console.error(`ERROR ${failure}`);
  process.exit(1);
}

console.log(`Validated ${skillDirectories.length} skills.`);

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { assert, atomic } from '../src/shared.mjs';
import { locations, locked, readManifest, saveManifest, stat, safePath, skillLinks, hookCommand,
  hookPositions, readConfig, writeConfig, matches, quote, upgradeManifest, recordDirectories,
  parentPaths, removeEmptyDirectories } from './install-state.mjs';

const engines = ['claude', 'codex'];
const components = ['tracking', 'harness'];
const validateEngine = engine => assert(engines.includes(engine), '지원하지 않는 에이전트입니다.');
const validateComponent = component => assert(components.includes(component), '지원하지 않는 연결 기능입니다.');
const engineLinks = (loc, receipt, engine) => skillLinks(loc, receipt.skills, receipt.trees[1].path)
  .filter(link => engine === 'claude' ? link.path.startsWith(path.join(loc.home, '.claude') + path.sep)
    : !link.path.startsWith(path.join(loc.home, '.claude') + path.sep));
const ownsLink = (loc, engine, link) => engine === 'claude'
  ? link.path.startsWith(path.join(loc.home, '.claude') + path.sep)
  : !link.path.startsWith(path.join(loc.home, '.claude') + path.sep);

function assertArtifacts(loc, receipt, component) {
  const runtime = receipt.trees[1].path;
  const files = [path.join(runtime, 'node'), ...(component === 'tracking' ? [path.join(runtime, 'harness/src/hook.mjs')]
    : receipt.skills.map(skill => path.join(runtime, 'harness/skills', skill, 'SKILL.md')))];
  for (const file of files) {
    safePath(loc.home, file);
    assert(stat(file)?.isFile(), `설치된 WorkLog 실행 파일 또는 스킬을 찾을 수 없습니다: ${file}`);
  }
}

const provenLink = (link, info) => link.pending !== true
  && (!link.identity || (info?.dev === link.identity.dev && info?.ino === link.identity.ino));

function referencesInstall(value, receipt) {
  const runtime = receipt.trees[1].path;
  const references = [`WORKLOG_INSTALL_ID=${quote(receipt.id)}`, quote(path.join(runtime, 'node')), quote(path.join(runtime, 'harness/src/hook.mjs'))];
  const visit = value => typeof value === 'string' ? references.some(ref => value.includes(ref))
    : value && typeof value === 'object' ? Object.values(value).some(visit) : false;
  return visit(value);
}

function componentConnection(loc, receipt, engine, component) {
  const record = receipt?.hooks.find(hook => hook.engine === engine);
  const links = receipt?.links.filter(link => ownsLink(loc, engine, link)) || [];
  const paths = component === 'tracking' ? (record ? [record.path] : []) : links.map(link => link.path);
  if (!paths.length) return { state: 'disconnected', message: '연결되지 않았습니다.', paths: [] };
  try {
    assertArtifacts(loc, receipt, component);
    if (component === 'tracking') {
      assert(record.entries.length, '이력 수집 연결이 완료되지 않았습니다. 다시 연결하거나 해제하세요.');
      const { value } = readConfig(loc, record.path);
      assert(record.entries.every(entry => hookPositions(value, entry).length === 1), 'WorkLog 훅이 누락되었거나 변경되었습니다.');
      return { state: 'connected', connected_at: record.connected_at || null, message: value.disableAllHooks === true
        ? '이력 수집 훅이 연결되었습니다. 사용자 설정에서 모든 훅을 비활성화해 활동 수집은 중지되어 있습니다.'
        : '이력 수집 훅이 연결되었습니다.', paths };
    }
    assert(links.length === engineLinks(loc, receipt, engine).length, '하네스 위임 연결이 완료되지 않았습니다. 다시 연결하거나 해제하세요.');
    for (const link of links) {
      safePath(loc.home, link.path, { symlink: true }); const info = stat(link.path);
      assert(matches(link.path, { ...link, kind: 'symlink' })
        && provenLink(link, info), `스킬 연결이 누락되었거나 소유를 확인할 수 없습니다: ${link.path}`);
    }
    return { state: 'connected', message: '하네스 위임 스킬이 연결되었습니다.', paths };
  } catch (error) { return { state: 'needs_attention', message: error.message, paths }; }
}

function connection(loc, receipt, engine) {
  const tracking = componentConnection(loc, receipt, engine, 'tracking');
  const harness = componentConnection(loc, receipt, engine, 'harness');
  // Legacy consumers use the top-level state to decide whether hooks are installed.
  return { engine, ...tracking, tracking, harness };
}

function snapshot(loc, receipt) {
  return { available: receipt?.state === 'installed', connections: engines.map(engine => connection(loc, receipt, engine)) };
}

export function getAgentConnections({ homeDir = os.homedir() } = {}) {
  const loc = locations(homeDir);
  try { return snapshot(loc, readManifest(loc)); }
  catch (error) {
    const failed = () => ({ state: 'needs_attention', message: error.message, paths: [] });
    return { available: false, connections: engines.map(engine => ({ engine, ...failed(), tracking: failed(), harness: failed() })) };
  }
}

// Caller holds installation.lock. Uninstall uses the same exact ownership checks.
export function removeAgentConnectionComponent(loc, receipt, engine, component, removed, preserved) {
  validateEngine(engine); validateComponent(component); upgradeManifest(receipt);
  const config = component === 'tracking' && receipt.hooks.find(hook => hook.engine === engine);
  if (config) {
    try {
      const { raw, value } = readConfig(loc, config.path), changed = [];
      if (raw !== null) {
        for (const entry of config.entries) {
          const found = hookPositions(value, entry);
          if (found.length !== 1) continue;
          const { g, h } = found[0], groups = value.hooks[entry.event], group = groups[g];
          group.hooks.splice(h, 1);
          if (!group.hooks.length) groups.splice(g, 1);
          if (!groups.length && !entry.eventExisted) delete value.hooks[entry.event];
          changed.push({ kind: 'hook', path: config.path, event: entry.event });
        }
        if (value.hooks && !Object.keys(value.hooks).length && !config.hooksExisted) delete value.hooks;
        if (receipt.created_configs.includes(config.path) && !Object.keys(value).length) {
          safePath(loc.home, config.path);
          assert(fs.readFileSync(config.path, 'utf8') === raw, '설정이 동시에 변경되어 보존했습니다.');
          fs.unlinkSync(config.path); removed.push({ kind: 'empty_config', path: config.path });
        } else if (changed.length) writeConfig(loc, config.path, raw, value);
        removed.push(...changed);
        assert(!referencesInstall(value, receipt), '변경되었거나 중복된 WorkLog 훅을 보존했습니다. 연결된 실행 파일도 유지합니다.');
      }
      receipt.hooks = receipt.hooks.filter(hook => hook !== config);
      receipt.created_configs = receipt.created_configs.filter(file => file !== config.path);
    } catch (error) { preserved.push({ path: config.path, reason: error.message }); }
    saveManifest(loc, receipt);
  }
  for (const link of component === 'harness' ? [...receipt.links].filter(link => ownsLink(loc, engine, link)) : []) {
    try {
      safePath(loc.home, link.path, { symlink: true }); const info = stat(link.path);
      if (info) {
        assert(matches(link.path, { ...link, kind: 'symlink' })
          && provenLink(link, info), '연결 대상 또는 소유를 확인할 수 없어 지시문 경로를 보존했습니다.');
        fs.unlinkSync(link.path); removed.push({ kind: 'symlink', path: link.path });
      }
      receipt.links = receipt.links.filter(value => value !== link);
    } catch (error) { preserved.push({ path: link.path, reason: error.message }); }
    saveManifest(loc, receipt);
  }
  const targets = component === 'tracking' ? [loc.configs[engine]] : engineLinks(loc, receipt, engine).map(link => link.path);
  const dirs = new Set(targets.flatMap(target => parentPaths(loc.home, target)));
  removeEmptyDirectories(loc, receipt, removed, receipt.created_directories.filter(dir => dirs.has(dir)));
  saveManifest(loc, receipt);
}

export function removeAgentConnection(loc, receipt, engine, removed, preserved) {
  for (const component of components) removeAgentConnectionComponent(loc, receipt, engine, component, removed, preserved);
}

function disconnect(engine, selected, { homeDir = os.homedir() } = {}) {
  validateEngine(engine);
  return locked(homeDir, loc => {
    const receipt = readManifest(loc);
    assert(receipt?.state === 'installed', '설치가 완료된 WorkLog에서 에이전트 연결을 변경할 수 있습니다.');
    const preserved = [];
    for (const component of selected) removeAgentConnectionComponent(loc, receipt, engine, component, [], preserved);
    assert(!preserved.length, preserved.map(item => item.reason).join('\n'));
    return snapshot(loc, receipt);
  });
}

function connect(engine, selected, { homeDir = os.homedir() } = {}) {
  validateEngine(engine);
  return locked(homeDir, loc => {
    const receipt = readManifest(loc);
    assert(receipt?.state === 'installed', '설치가 완료된 WorkLog에서 에이전트를 연결할 수 있습니다.');
    for (const component of selected) assertArtifacts(loc, receipt, component);
    const current = connection(loc, receipt, engine);
    const missing = selected.filter(component => current[component].state !== 'connected');
    if (!missing.length) return snapshot(loc, receipt);
    for (const component of missing) {
      if (current[component].state === 'needs_attention') {
        const preserved = []; removeAgentConnectionComponent(loc, receipt, engine, component, [], preserved);
        assert(!preserved.length, preserved.map(item => item.reason).join('\n'));
      }
    }
    // Validate every requested component before creating either. The legacy combined
    // operation keeps its preflight behavior while scoped operations stay independent.
    const links = missing.includes('harness') ? engineLinks(loc, receipt, engine).map(link => ({ ...link, pending: true })) : [];
    for (const link of links) {
      safePath(loc.home, link.path, { symlink: true });
      assert(!stat(link.path), `사용자가 소유한 스킬 경로를 덮어쓰지 않습니다: ${link.path}`);
    }
    let config;
    if (missing.includes('tracking')) {
      const target = loc.configs[engine], { raw, value } = readConfig(loc, target);
      assert(!referencesInstall(value, receipt), '소유 기록이 없는 WorkLog 훅이 있습니다. 기존 설정을 보존했습니다.');
      const record = { engine, path: target, hooksExisted: value.hooks !== undefined, entries: [], connected_at: new Date().toISOString() };
      value.hooks ||= {};
      const events = ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd', 'PreToolUse', 'PostToolUse'];
      if (engine === 'claude') events.push('PostToolUseFailure', 'StopFailure');
      for (const event of events) {
        const eventExisted = value.hooks[event] !== undefined;
        if (!eventExisted) value.hooks[event] = [];
        assert(Array.isArray(value.hooks[event]), `${engine} ${event} 설정 형식을 확인하세요.`);
        const hook = { type: 'command', command: hookCommand(loc, receipt.trees[1].path, receipt.id, engine), timeout: 2 };
        record.entries.push({ event, eventExisted, qualifiers: {}, hook });
        value.hooks[event].push({ hooks: [hook] });
      }
      config = { target, raw, value, record };
    }
    upgradeManifest(receipt);
    recordDirectories(loc, receipt, [...(config ? [config.target] : []), ...links.map(link => link.path)]);
    if (config?.raw === null) receipt.created_configs.push(config.target);
    if (config) receipt.hooks.push(config.record);
    receipt.links.push(...links);
    saveManifest(loc, receipt); // Durable intent precedes any agent configuration or link mutation.
    readManifest(loc);
    if (config) {
      if (config.raw !== null) {
        const backup = path.join(loc.data, 'install-backups', receipt.id, `${engine}-${crypto.randomUUID()}.json`);
        safePath(loc.home, backup); atomic(backup, config.raw);
      }
      writeConfig(loc, config.target, config.raw, config.value);
    }
    for (const link of links) {
      safePath(loc.home, link.path, { symlink: true });
      fs.mkdirSync(path.dirname(link.path), { recursive: true, mode: 0o700 }); fs.symlinkSync(link.target, link.path);
      const info = stat(link.path); link.identity = { dev: info.dev, ino: info.ino }; link.pending = false; saveManifest(loc, receipt);
    }
    return snapshot(loc, receipt);
  });
}

export const connectAgent = (engine, options) => connect(engine, components, options);
export const disconnectAgent = (engine, options) => disconnect(engine, components, options);

export function connectAgentComponent(engine, component, options) {
  validateComponent(component);
  return connect(engine, [component], options);
}

export function disconnectAgentComponent(engine, component, options) {
  validateComponent(component);
  return disconnect(engine, [component], options);
}

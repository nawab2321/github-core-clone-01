import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

const jsonType = 'application/json; charset=utf-8';
const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const repos = new Map();
let requestNumber = 0;

function send(res, status, value, headers = {}) {
  const body = value === null ? '' : `${JSON.stringify(value)}\n`;
  res.writeHead(status, {
    'content-type': jsonType,
    'content-length': Buffer.byteLength(body),
    'x-github-request-id': `forge${(++requestNumber).toString(36)}`,
    ...headers,
  });
  res.end(body);
}

function fail(res, status, message) {
  send(res, status, { message });
}

function authorized(req) {
  return Boolean(token) && req.headers.authorization === `Bearer ${token}`;
}

async function readBody(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 8 * 1024 * 1024) throw new Error('request body too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function stableId(value) {
  return createHash('sha1').update(value).digest('hex');
}

function repoKey(owner, name) {
  return `${owner.toLowerCase()}/${name.toLowerCase()}`;
}

function objectHash(type, data) {
  return createHash('sha1').update(`${type} ${data.length}\0`).update(data).digest('hex');
}

function putObject(repo, type, data) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const oid = objectHash(type, bytes);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data: bytes });
  return oid;
}

function getObject(repo, oid, type) {
  const object = repo.objects.get(oid);
  return object && (!type || object.type === type) ? object : null;
}

function parseCommit(repo, oid) {
  const object = getObject(repo, oid, 'commit');
  if (!object) return null;
  const text = object.data.toString('utf8');
  const split = text.indexOf('\n\n');
  const headers = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2).replace(/\n$/, '');
  const tree = /^tree ([0-9a-f]{40})$/m.exec(headers)?.[1] ?? '';
  const parents = [...headers.matchAll(/^parent ([0-9a-f]{40})$/gm)].map((m) => m[1]);
  return { oid, tree, parents, message, headers };
}

function parseTree(repo, oid) {
  const object = getObject(repo, oid, 'tree');
  if (!object) return [];
  const entries = [];
  let offset = 0;
  while (offset < object.data.length) {
    const space = object.data.indexOf(0x20, offset);
    const nul = object.data.indexOf(0, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > object.data.length) break;
    const mode = object.data.subarray(offset, space).toString('ascii');
    const name = object.data.subarray(space + 1, nul).toString('utf8');
    const oidValue = object.data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid: oidValue });
    offset = nul + 21;
  }
  return entries;
}

function treeBytes(entries) {
  const ordered = [...entries].sort((a, b) => {
    const left = a.name + (a.mode === '40000' || a.mode === '040000' ? '/' : '');
    const right = b.name + (b.mode === '40000' || b.mode === '040000' ? '/' : '');
    return Buffer.compare(Buffer.from(left), Buffer.from(right));
  });
  return Buffer.concat(ordered.flatMap((entry) => [
    Buffer.from(`${entry.mode === '040000' ? '40000' : entry.mode} ${entry.name}\0`),
    Buffer.from(entry.oid, 'hex'),
  ]));
}

function filesAt(repo, treeOid, prefix = '', result = new Map()) {
  for (const entry of parseTree(repo, treeOid)) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.mode === '40000' || entry.mode === '040000') filesAt(repo, entry.oid, name, result);
    else {
      const object = getObject(repo, entry.oid, 'blob');
      if (object) result.set(name, { oid: entry.oid, data: object.data, mode: entry.mode });
    }
  }
  return result;
}

function makeTree(repo, files) {
  const root = { files: new Map(), dirs: new Map() };
  for (const [path, file] of files) {
    const parts = path.split('/').filter(Boolean);
    if (!parts.length) continue;
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.dirs.has(part)) node.dirs.set(part, { files: new Map(), dirs: new Map() });
      node = node.dirs.get(part);
    }
    node.files.set(parts.at(-1), file);
  }
  function build(node) {
    const entries = [];
    for (const [name, file] of node.files) {
      const oid = file.oid ?? putObject(repo, 'blob', file.data);
      entries.push({ mode: file.mode ?? '100644', name, oid });
    }
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(repo, 'tree', treeBytes(entries));
  }
  return build(root);
}

function makeCommit(repo, tree, parents, message) {
  const lines = [`tree ${tree}`, ...parents.map((parent) => `parent ${parent}`),
    'author Forge <forge@example.invalid> 1760000000 +0000',
    'committer Forge <forge@example.invalid> 1760000000 +0000', '', message || 'update'];
  return putObject(repo, 'commit', Buffer.from(`${lines.join('\n')}\n`));
}

function tip(repo, branch = repo.defaultBranch) {
  return repo.refs.get(`refs/heads/${branch}`) ?? '';
}

function snapshot(repo, commitOid) {
  const commit = parseCommit(repo, commitOid);
  return commit ? filesAt(repo, commit.tree) : new Map();
}

function newRepo(owner, name, input = {}) {
  return {
    id: ++repoSequence,
    owner,
    name,
    description: input.description ?? '',
    private: Boolean(input.private),
    defaultBranch: input.default_branch ?? input.defaultBranch ?? 'main',
    createdAt: fixedTime,
    refs: new Map(),
    objects: new Map(),
    issues: [],
    labels: new Map(),
    pulls: [],
    nextIssue: 1,
    nextPull: 1,
    nextComment: 1,
  };
}

const fixedTime = '2026-01-01T00:00:00Z';
let repoSequence = 0;

function repoObject(repo) {
  const owner = { login: repo.owner, id: 1000, type: 'User', site_admin: false };
  return {
    id: repo.id,
    node_id: Buffer.from(`Repository:${repo.owner}/${repo.name}`).toString('base64'),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner,
    private: repo.private,
    description: repo.description,
    fork: false,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    pushed_at: repo.createdAt,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_wiki: false,
    permissions: { admin: true, push: true, pull: true },
  };
}

function repoFor(owner, name) {
  if (owner.toLowerCase() !== login.toLowerCase()) return null;
  return repos.get(repoKey(owner, name)) ?? null;
}

function blobAt(repo, commitOid, path) {
  return snapshot(repo, commitOid).get(path) ?? null;
}

function commitForFileChange(repo, branch, path, data, remove = false) {
  const oldTip = tip(repo, branch);
  const files = oldTip ? snapshot(repo, oldTip) : new Map();
  if (remove) files.delete(path);
  else files.set(path, { data: Buffer.from(data), mode: '100644' });
  const tree = makeTree(repo, files);
  const commit = makeCommit(repo, tree, oldTip ? [oldTip] : [], 'Update files');
  repo.refs.set(`refs/heads/${branch}`, commit);
  return commit;
}

function issueObject(repo, issue) {
  return {
    id: issue.id,
    node_id: Buffer.from(`Issue:${repo.owner}/${repo.name}#${issue.number}`).toString('base64'),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ id: stableId(`${repo.id}:${name}`), name, color: repo.labels.get(name.toLowerCase())?.color ?? 'ededed' })),
    user: { login: login, id: 1000, type: 'User' },
    comments: issue.comments.length,
    created_at: fixedTime,
    updated_at: fixedTime,
    closed_at: issue.state === 'closed' ? fixedTime : null,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function headBranch(value) {
  const part = String(value ?? '').split(':').at(-1) ?? '';
  return part.replace(/^refs\/heads\//, '');
}

function changedFiles(repo, pull) {
  const base = snapshot(repo, pull.baseOid);
  const head = snapshot(repo, pull.headOid);
  const names = new Set([...base.keys(), ...head.keys()]);
  const changes = [];
  for (const path of [...names].sort()) {
    const before = base.get(path);
    const after = head.get(path);
    if (before?.oid === after?.oid) continue;
    const oldText = before?.data.toString('utf8') ?? '';
    const newText = after?.data.toString('utf8') ?? '';
    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');
    let additions = 0;
    let deletions = 0;
    for (const line of newLines) if (!oldLines.includes(line) && line !== '') additions++;
    for (const line of oldLines) if (!newLines.includes(line) && line !== '') deletions++;
    changes.push({
      filename: path,
      status: !before ? 'added' : !after ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
      patch: `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    });
  }
  return changes;
}

function pullObject(repo, pull) {
  const mergeable = !pull.conflict;
  return {
    id: pull.id,
    node_id: Buffer.from(`PullRequest:${repo.owner}/${repo.name}#${pull.number}`).toString('base64'),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    merged: pull.merged,
    mergeable,
    mergeable_state: mergeable ? 'clean' : 'dirty',
    merged_at: pull.merged ? fixedTime : null,
    merge_commit_sha: pull.mergeSha ?? null,
    head: { ref: pull.head, sha: pull.headOid, label: `${repo.owner}:${pull.head}`, user: { login: repo.owner } },
    base: { ref: pull.base, sha: pull.baseOid, label: `${repo.owner}:${pull.base}`, user: { login: repo.owner } },
    user: { login, id: 1000 },
    created_at: fixedTime,
    updated_at: fixedTime,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

function isAncestor(repo, ancestor, descendant) {
  const seen = new Set();
  const queue = [descendant];
  while (queue.length) {
    const oid = queue.pop();
    if (oid === ancestor) return true;
    if (!oid || seen.has(oid)) continue;
    seen.add(oid);
    const commit = parseCommit(repo, oid);
    if (commit) queue.push(...commit.parents);
  }
  return false;
}

function pullConflicts(repo, headOid, baseOid) {
  const ancestors = new Set();
  const queue = [baseOid];
  while (queue.length) {
    const oid = queue.shift();
    if (!oid || ancestors.has(oid)) continue;
    ancestors.add(oid);
    const commit = parseCommit(repo, oid);
    if (commit) queue.push(...commit.parents);
  }
  const candidates = [headOid];
  let common = '';
  while (candidates.length) {
    const oid = candidates.shift();
    if (!oid) continue;
    if (ancestors.has(oid)) { common = oid; break; }
    const commit = parseCommit(repo, oid);
    if (commit) candidates.push(...commit.parents);
  }
  const baseFiles = snapshot(repo, baseOid);
  const headFiles = snapshot(repo, headOid);
  const commonFiles = common ? snapshot(repo, common) : new Map();
  for (const path of new Set([...baseFiles.keys(), ...headFiles.keys(), ...commonFiles.keys()])) {
    const ancestor = commonFiles.get(path)?.oid;
    const onBase = baseFiles.get(path)?.oid;
    const onHead = headFiles.get(path)?.oid;
    if (onBase !== ancestor && onHead !== ancestor && onBase !== onHead) return true;
  }
  return false;
}

function makePull(repo, input) {
  const head = headBranch(input.head);
  const base = headBranch(input.base ?? repo.defaultBranch);
  const headOid = tip(repo, head);
  const baseOid = tip(repo, base);
  if (!headOid || !baseOid) return null;
  const conflict = pullConflicts(repo, headOid, baseOid);
  const pull = {
    id: stableId(`${repo.id}:pull:${repo.nextPull}`),
    number: repo.nextPull++,
    title: String(input.title ?? ''),
    body: String(input.body ?? ''),
    state: 'open',
    merged: false,
    head,
    base,
    headOid,
    baseOid,
    conflict,
    mergeSha: null,
  };
  repo.pulls.push(pull);
  return pull;
}

function mergePull(repo, pull) {
  if (!pull || pull.state !== 'open') return { status: 404 };
  const baseCommit = tip(repo, pull.base);
  if (pullConflicts(repo, pull.headOid, baseCommit)) return { status: 405 };
  const baseFiles = snapshot(repo, tip(repo, pull.base));
  const headFiles = snapshot(repo, pull.headOid);
  const originalFiles = snapshot(repo, pull.baseOid);
  for (const path of new Set([...originalFiles.keys(), ...headFiles.keys()])) {
    const before = originalFiles.get(path);
    const after = headFiles.get(path);
    if (before?.oid === after?.oid) continue;
    if (after) baseFiles.set(path, after);
    else baseFiles.delete(path);
  }
  const tree = makeTree(repo, baseFiles);
  const oid = makeCommit(repo, tree, baseCommit ? [baseCommit] : [], `${pull.title} (#${pull.number})`);
  repo.refs.set(`refs/heads/${pull.base}`, oid);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeSha = oid;
  return { status: 200, sha: oid };
}

function packet(value) {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([Buffer.from((data.length + 4).toString(16).padStart(4, '0')), data]);
}

function decodePackets(data) {
  const packets = [];
  let offset = 0;
  while (offset + 4 <= data.length) {
    const header = data.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-f]{4}$/i.test(header)) break;
    const size = parseInt(header, 16);
    offset += 4;
    if (size === 0 || size === 1 || size === 2) {
      packets.push({ kind: size === 0 ? 'flush' : size === 1 ? 'delim' : 'response-end', data: Buffer.alloc(0) });
      continue;
    }
    if (size < 4 || offset + size - 4 > data.length) break;
    packets.push({ kind: 'data', data: data.subarray(offset, offset + size - 4) });
    offset += size - 4;
  }
  return { packets, offset };
}

function packHeader(typeCode, size) {
  const bytes = [];
  let first = (typeCode << 4) | (size & 15);
  size = Math.floor(size / 16);
  while (size) {
    bytes.push(first | 0x80);
    first = size & 0x7f;
    size = Math.floor(size / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

function writePack(objects) {
  const types = { commit: 1, tree: 2, blob: 3, tag: 4 };
  const chunks = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  chunks.push(head);
  for (const object of objects) chunks.push(packHeader(types[object.type], object.data.length), deflateSync(object.data));
  const body = Buffer.concat(chunks);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function applyDelta(base, delta) {
  let offset = 0;
  function readSize() {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length || shift > 56) throw new Error('invalid pack delta size');
      const byte = delta[offset++];
      value |= (byte & 0x7f) * (2 ** shift);
      if (!(byte & 0x80)) return value;
      shift += 7;
    }
  }
  const baseSize = readSize();
  const targetSize = readSize();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const parts = [];
  let total = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) copyOffset |= delta[offset++] << (i * 8);
      for (let i = 0; i < 3; i++) if (op & (1 << (i + 4))) copySize |= delta[offset++] << (i * 8);
      if (!copySize) copySize = 0x10000;
      const part = base.subarray(copyOffset, copyOffset + copySize);
      if (part.length !== copySize) throw new Error('delta copy exceeds base');
      parts.push(part);
      total += part.length;
    } else if (op) {
      const part = delta.subarray(offset, offset + op);
      if (part.length !== op) throw new Error('delta insert is truncated');
      parts.push(part);
      offset += op;
      total += part.length;
    } else throw new Error('invalid delta opcode');
    if (total > targetSize) throw new Error('delta exceeds target size');
  }
  if (total !== targetSize) throw new Error('delta target size mismatch');
  return Buffer.concat(parts, total);
}

function readPack(repo, data) {
  if (data.length < 32 || data.toString('ascii', 0, 4) !== 'PACK') throw new Error('invalid pack header');
  const version = data.readUInt32BE(4);
  const count = data.readUInt32BE(8);
  if (version !== 2 && version !== 3) throw new Error('unsupported pack version');
  const end = data.length - 20;
  const checksum = createHash('sha1').update(data.subarray(0, end)).digest();
  if (!checksum.equals(data.subarray(end))) throw new Error('pack checksum mismatch');
  const entries = [];
  let offset = 12;
  for (let i = 0; i < count; i++) {
    const entryOffset = offset;
    let byte = data[offset++];
    const type = (byte >> 4) & 7;
    let size = byte & 15;
    let shift = 4;
    while (byte & 0x80) {
      byte = data[offset++];
      size += (byte & 0x7f) * (2 ** shift);
      shift += 7;
    }
    let baseOffset = null;
    let baseOid = null;
    if (type === 6) {
      let c = data[offset++];
      let distance = c & 0x7f;
      while (c & 0x80) {
        c = data[offset++];
        distance = ((distance + 1) << 7) + (c & 0x7f);
      }
      baseOffset = entryOffset - distance;
    } else if (type === 7) {
      baseOid = data.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (type < 1 || type > 4) throw new Error('invalid pack object type');
    const inflated = inflateSync(data.subarray(offset, end), { info: true });
    const raw = inflated.buffer;
    const used = inflated.engine.bytesWritten;
    offset += used;
    if (raw.length !== size) throw new Error('pack object size mismatch');
    entries.push({ offset: entryOffset, type, raw, baseOffset, baseOid });
  }
  if (offset !== end) throw new Error('trailing pack data');
  const byOffset = new Map(entries.map((entry) => [entry.offset, entry]));
  const byOid = new Map();
  const names = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
  function resolve(entry, seen = new Set()) {
    if (entry.oid) return entry;
    if (seen.has(entry.offset)) throw new Error('pack delta cycle');
    seen.add(entry.offset);
    if (entry.type === 6 || entry.type === 7) {
      const base = entry.type === 6 ? byOffset.get(entry.baseOffset) : byOid.get(entry.baseOid) ?? repo.objects.get(entry.baseOid);
      if (!base) throw new Error('pack delta base is missing');
      const resolved = entry.type === 6 ? resolve(base, seen) : base;
      entry.data = applyDelta(resolved.data ?? resolved.raw, entry.raw);
      entry.objectType = resolved.objectType ?? resolved.type;
    } else {
      entry.data = entry.raw;
      entry.objectType = names[entry.type];
    }
    entry.oid = objectHash(entry.objectType, entry.data);
    byOid.set(entry.oid, entry);
    return entry;
  }
  for (const entry of entries) {
    const object = resolve(entry);
    repo.objects.set(object.oid, { type: object.objectType, data: object.data });
  }
}

function reachableObjects(repo, tips, depth = 0) {
  const objects = new Map();
  const commits = [];
  const seenCommits = new Set();
  const queue = tips.map((oid) => ({ oid, level: 1 }));
  while (queue.length) {
    const { oid, level } = queue.shift();
    if (!oid || seenCommits.has(oid)) continue;
    const rootObject = getObject(repo, oid);
    if (rootObject?.type === 'tag') {
      if (objects.has(oid)) continue;
      objects.set(oid, rootObject);
      const target = /^object ([0-9a-f]{40})$/m.exec(rootObject.data.toString('utf8'))?.[1];
      if (target) {
        if (parseCommit(repo, target)) queue.push({ oid: target, level });
        else addTree(target);
      }
      continue;
    }
    const commit = parseCommit(repo, oid);
    if (!commit) continue;
    seenCommits.add(oid);
    commits.push({ oid, level, commit });
    if (!depth || level < depth) for (const parent of commit.parents) queue.push({ oid: parent, level: level + 1 });
  }
  function addTree(oid) {
    const object = getObject(repo, oid);
    if (!object || objects.has(oid)) return;
    objects.set(oid, object);
    if (object.type === 'tree') for (const entry of parseTree(repo, oid)) addTree(entry.oid);
    if (object.type === 'tag') {
      const target = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'))?.[1];
      if (target) addTree(target);
    }
  }
  for (const entry of commits) {
    const object = getObject(repo, entry.oid, 'commit');
    objects.set(entry.oid, object);
    addTree(entry.commit.tree);
  }
  const shallow = depth ? commits.filter((entry) => entry.level === depth && entry.commit.parents.length).map((entry) => entry.oid) : [];
  return { objects, commits, shallow };
}

function pktTextLines(packets) {
  return packets.filter((item) => item.kind === 'data').map((item) => item.data.toString('utf8'));
}

async function readBytes(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 64 * 1024 * 1024) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sendBytes(res, status, data, contentType) {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': data.length,
    'x-github-request-id': `forge${(++requestNumber).toString(36)}`,
  });
  res.end(data);
}

function refAdvertisement(repo, service) {
  const cap = service === 'git-receive-pack'
    ? 'report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=forge/1'
    : 'multi_ack_detailed side-band-64k thin-pack ofs-delta shallow no-progress include-tag agent=forge/1';
  const rows = [...repo.refs].sort(([a], [b]) => a.localeCompare(b));
  const out = [packet(`# service=${service}\n`), Buffer.from('0000')];
  if (!rows.length) {
    out.push(packet(`${'0'.repeat(40)} capabilities^{}` + '\0' + `object-format=sha1 symref=HEAD:refs/heads/${repo.defaultBranch} ${cap}\n`));
  } else {
    rows.forEach(([ref, oid], index) => {
      const features = index === 0 ? `\0object-format=sha1 symref=HEAD:refs/heads/${repo.defaultBranch} ${cap}` : '';
      out.push(packet(`${oid} ${ref}${features}\n`));
      if (ref.startsWith('refs/tags/')) {
        const tag = getObject(repo, oid, 'tag');
        const peeled = tag && /^object ([0-9a-f]{40})$/m.exec(tag.data.toString('utf8'))?.[1];
        if (peeled) out.push(packet(`${peeled} ${ref}^{}\n`));
      }
    });
  }
  out.push(Buffer.from('0000'));
  return Buffer.concat(out);
}

function uploadPackV2Advertisement() {
  return Buffer.concat([
    packet('version 2\n'),
    packet('agent=forge/1\n'),
    packet('ls-refs=unborn\n'),
    packet('fetch=shallow wait-for-done filter\n'),
    packet('server-option\n'),
    packet('object-format=sha1\n'),
    Buffer.from('0000'),
  ]);
}

function responseSideband(pack, prefix = []) {
  const chunks = [];
  if (prefix.length) chunks.push(packet('shallow-info\n'), ...prefix.map((line) => packet(line)), Buffer.from('0001'));
  if (pack?.length) {
    chunks.push(packet('packfile\n'));
    for (let offset = 0; offset < pack.length; offset += 60000) {
      chunks.push(packet(Buffer.concat([Buffer.from([1]), pack.subarray(offset, offset + 60000)])));
    }
  }
  chunks.push(Buffer.from('0000'));
  return Buffer.concat(chunks);
}

function reachableFromTips(repo, tips) {
  return reachableObjects(repo, tips, 0).objects;
}

function buildFetchResponse(repo, wants, haves, depth = 0, shallowInput = []) {
  const result = reachableObjects(repo, wants, depth);
  const excluded = reachableObjects(repo, haves, depth && shallowInput.length ? 1 : 0).objects;
  const objects = [...result.objects].filter(([oid]) => !excluded.has(oid)).map(([, object]) => object);
  const prefix = [];
  const includedCommits = new Set(result.commits.map((entry) => entry.oid));
  for (const oid of shallowInput) if (includedCommits.has(oid) && !result.shallow.includes(oid)) prefix.push(`unshallow ${oid}\n`);
  for (const oid of result.shallow) if (!shallowInput.includes(oid)) prefix.push(`shallow ${oid}\n`);
  return { pack: objects.length ? writePack(objects) : null, prefix };
}

function processReceivePack(repo, body) {
  const decoded = decodePackets(body);
  const terminator = decoded.packets.findIndex((entry) => entry.kind === 'flush');
  if (terminator < 0) throw new Error('receive-pack commands are not terminated');
  const commands = [];
  for (const line of pktTextLines(decoded.packets.slice(0, terminator))) {
    const clean = line.replace(/\n$/, '');
    const nul = clean.indexOf('\0');
    const [oldOid, newOid, ref] = (nul < 0 ? clean : clean.slice(0, nul)).split(' ');
    if (!/^[0-9a-f]{40}$/.test(oldOid ?? '') || !/^[0-9a-f]{40}$/.test(newOid ?? '') || !ref?.startsWith('refs/')) continue;
    commands.push({ oldOid, newOid, ref });
  }
  const packData = body.subarray(decoded.offset);
  let unpack = 'ok';
  if (packData.length) {
    try { readPack(repo, packData); } catch { unpack = 'error'; }
  }
  const reports = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref) ?? '0'.repeat(40);
    let reason = '';
    if (unpack !== 'ok') reason = 'unpacker error';
    else if (current !== command.oldOid) reason = 'stale info';
    else if (command.newOid !== '0'.repeat(40) && !getObject(repo, command.newOid)) reason = 'object missing';
    else if (command.newOid !== '0'.repeat(40) && current !== '0'.repeat(40) && !isAncestor(repo, current, command.newOid)) reason = 'non-fast-forward';
    if (reason) reports.push(`ng ${command.ref} ${reason}\n`);
    else {
      if (command.newOid === '0'.repeat(40)) repo.refs.delete(command.ref);
      else repo.refs.set(command.ref, command.newOid);
      reports.push(`ok ${command.ref}\n`);
    }
  }
  const report = Buffer.concat([packet(`unpack ${unpack}\n`), ...reports.map(packet), Buffer.from('0000')]);
  return Buffer.concat([packet(Buffer.concat([Buffer.from([1]), report])), Buffer.from('0002')]);
}

function processUploadPackV2(repo, body) {
  const decoded = decodePackets(body);
  const lines = pktTextLines(decoded.packets);
  const command = lines.find((line) => line.startsWith('command='))?.slice(8).trim();
  if (command === 'ls-refs') {
    const options = lines.slice(lines.findIndex((line) => line.trim() === '0001') + 1);
    const prefixes = options.filter((line) => line.startsWith('ref-prefix ')).map((line) => line.slice(11).trim());
    const rows = [...repo.refs].sort(([a], [b]) => a.localeCompare(b));
    const output = [];
    const head = tip(repo);
    if (!prefixes.length || prefixes.some((prefix) => 'HEAD'.startsWith(prefix))) {
      output.push(head ? `${head} HEAD symref-target:refs/heads/${repo.defaultBranch}\n` : `unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
    }
    for (const [ref, oid] of rows) {
      if (prefixes.length && !prefixes.some((prefix) => ref.startsWith(prefix))) continue;
      let peeled = '';
      if (ref.startsWith('refs/tags/')) {
        const tag = getObject(repo, oid, 'tag');
        peeled = tag ? /^object ([0-9a-f]{40})$/m.exec(tag.data.toString('utf8'))?.[1] ?? '' : '';
      }
      output.push(`${oid} ${ref}${peeled ? ` peeled:${peeled}` : ''}\n`);
    }
    return Buffer.concat([...output.map(packet), Buffer.from('0000')]);
  }
  if (command !== 'fetch') return Buffer.from('0000');
  const wants = lines.filter((line) => line.startsWith('want ')).map((line) => line.slice(5).trim());
  const haves = lines.filter((line) => line.startsWith('have ')).map((line) => line.slice(5).trim());
  const depth = Number(lines.find((line) => line.startsWith('deepen '))?.slice(7) ?? 0);
  const shallow = lines.filter((line) => line.startsWith('shallow ')).map((line) => line.slice(8).trim());
  if (!wants.length) return Buffer.from('0000');
  const result = buildFetchResponse(repo, wants, haves, depth, shallow);
  return responseSideband(result.pack, result.prefix);
}

function processUploadPackV0(repo, body) {
  const decoded = decodePackets(body);
  const lines = pktTextLines(decoded.packets);
  const wants = lines.filter((line) => line.startsWith('want ')).map((line) => line.slice(5).trim().split(/\s+/)[0]);
  const haves = lines.filter((line) => line.startsWith('have ')).map((line) => line.slice(5).trim());
  const depth = Number(lines.find((line) => line.startsWith('deepen '))?.slice(7) ?? 0);
  const shallow = lines.filter((line) => line.startsWith('shallow ')).map((line) => line.slice(8).trim());
  if (!wants.length) return packet('NAK\n');
  const result = buildFetchResponse(repo, wants, haves, depth, shallow);
  const chunks = [...result.prefix.map(packet), packet('NAK\n')];
  if (result.pack) {
    for (let offset = 0; offset < result.pack.length; offset += 60000) {
      chunks.push(packet(Buffer.concat([Buffer.from([1]), result.pack.subarray(offset, offset + 60000)])));
    }
  }
  chunks.push(Buffer.from('0000'));
  return Buffer.concat(chunks);
}

function handleGit(req, res, url, path) {
  const match = /^\/([^/]+)\/([^/]+)\.git(?:\/(.*))?$/.exec(path);
  if (!match) return fail(res, 404, 'Not Found');
  const [, owner, name, endpoint = ''] = match;
  const repo = repoFor(owner, name);
  if (!repo) return fail(res, 404, 'Not Found');
  const protocol = String(req.headers['git-protocol'] ?? '');
  if (req.method === 'GET' && endpoint === 'info/refs') {
    const service = url.searchParams.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return fail(res, 400, 'Unsupported service');
    const v2 = service === 'git-upload-pack' && protocol.split(':').includes('version=2');
      return sendBytes(res, 200, v2 ? uploadPackV2Advertisement() : refAdvertisement(repo, service), `application/x-${service}-advertisement`);
  }
  if (req.method === 'POST' && endpoint === 'git-upload-pack') {
    return readBytes(req).then((body) => {
      const v2 = protocol.split(':').includes('version=2');
      const reply = v2 ? processUploadPackV2(repo, body) : processUploadPackV0(repo, body);
      sendBytes(res, 200, reply, 'application/x-git-upload-pack-result');
    });
  }
  if (req.method === 'POST' && endpoint === 'git-receive-pack') {
    return readBytes(req).then((body) => sendBytes(res, 200, processReceivePack(repo, body), 'application/x-git-receive-pack-result'));
  }
  return fail(res, 404, 'Not Found');
}

const toolDefinitions = [
  { name: 'create_repo', description: 'Create a repository for the authenticated user.', inputSchema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, private: { type: 'boolean' } }, required: ['name'] } },
  { name: 'get_repo', description: 'Get a repository owned by the authenticated user.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] } },
  { name: 'create_issue', description: 'Create an issue in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title'] } },
  { name: 'list_issues', description: 'List issues in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } }, required: ['owner', 'repo'] } },
  { name: 'create_pull_request', description: 'Open a pull request between repository branches.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
  { name: 'merge_pull_request', description: 'Merge an open pull request.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'integer' } }, required: ['owner', 'repo', 'pull_number'] } },
];

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function rpcToolResult(value, isError = false) {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value, ...(isError ? { isError: true } : {}) };
}

function callTool(name, args) {
  const tool = toolDefinitions.find((item) => item.name === name);
  if (!tool) return { error: rpcError(null, -32602, `Unknown tool: ${name}`) };
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return { error: rpcError(null, -32602, `Missing required argument: ${required}`) };
    }
  }
  const owner = String(args.owner ?? login);
  let repo = null;
  if (name !== 'create_repo') {
    repo = repoFor(owner, String(args.repo ?? args.name ?? ''));
    if (!repo) return { result: rpcToolResult({ message: 'Not Found' }, true) };
  }
  if (name === 'create_repo') {
    const repoName = String(args.name);
    const key = repoKey(login, repoName);
    if (repos.has(key)) return { result: rpcToolResult({ message: 'Repository already exists' }, true) };
    repo = newRepo(login, repoName, args);
    repos.set(key, repo);
    return { result: rpcToolResult(repoObject(repo)) };
  }
  if (name === 'get_repo') return { result: rpcToolResult(repoObject(repo)) };
  if (name === 'create_issue') {
    const issue = makeIssue(repo, args);
    return issue ? { result: rpcToolResult(issueObject(repo, issue)) } : { result: rpcToolResult({ message: 'Validation Failed' }, true) };
  }
  if (name === 'list_issues') {
    const state = String(args.state ?? 'open').toLowerCase();
    return { result: rpcToolResult(repo.issues.filter((issue) => state === 'all' || issue.state === state).map((issue) => issueObject(repo, issue))) };
  }
  if (name === 'create_pull_request') {
    const pull = makePull(repo, args);
    return pull ? { result: rpcToolResult(pullObject(repo, pull)) } : { result: rpcToolResult({ message: 'Head and base branches must exist' }, true) };
  }
  if (name === 'merge_pull_request') {
    const pull = repo.pulls.find((item) => item.number === Number(args.pull_number));
    const merged = mergePull(repo, pull);
    return merged.status === 200
      ? { result: rpcToolResult({ merged: true, sha: merged.sha, pull_request: pullObject(repo, pull) }) }
      : { result: rpcToolResult({ message: merged.status === 405 ? 'Pull request has conflicts' : 'Not Found' }, true) };
  }
  return { error: rpcError(null, -32602, 'Invalid tool call') };
}

async function handleMcp(req, res) {
  let request;
  try {
    request = await readBody(req);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return send(res, 400, rpcError(null, -32700, 'Parse error'));
    }
    throw error;
  }
  if (Array.isArray(request)) {
    return send(res, 200, request.map((item) => mcpResponse(item)).filter(Boolean));
  }
  const response = mcpResponse(request);
  if (!response) {
    res.writeHead(202, { 'content-length': '0' });
    return res.end();
  }
  return send(res, 200, response);
}

function mcpResponse(request) {
  if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') return rpcError(request?.id, -32600, 'Invalid Request');
  const id = request.id;
  const params = request.params && typeof request.params === 'object' ? request.params : {};
  const method = request.method;
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return null;
  if (method === 'server/discover') return {
    jsonrpc: '2.0', id,
    result: {
      resultType: 'discover',
      supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18'],
      capabilities: { tools: {} },
      serverInfo: { name: 'forge', version: '1.0.0' },
    },
  };
  if (method === 'initialize') return {
    jsonrpc: '2.0', id,
    result: {
      protocolVersion: '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: { name: 'forge', version: '1.0.0' },
    },
  };
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: toolDefinitions } };
  if (method === 'tools/call') {
    const name = String(params.name ?? '');
    const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
    const called = callTool(name, args);
    if (called.error) return { ...called.error, id };
    return { jsonrpc: '2.0', id, result: called.result };
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}

function tokenizeGraphql(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s|,/.test(ch)) { i++; continue; }
    if (ch === '#') { while (i < source.length && source[i] !== '\n') i++; continue; }
    if (source.startsWith('...', i)) { tokens.push('...'); i += 3; continue; }
    if (ch === '"') {
      let end = i + 1;
      while (end < source.length) {
        if (source[end] === '\\') end += 2;
        else if (source[end++] === '"') break;
      }
      tokens.push(source.slice(i, end));
      i = end;
      continue;
    }
    const name = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(i));
    if (name) { tokens.push(name[0]); i += name[0].length; continue; }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?/.exec(source.slice(i));
    if (number) { tokens.push(number[0]); i += number[0].length; continue; }
    tokens.push(ch);
    i++;
  }
  return tokens;
}

function parseGraphql(source, variables = {}) {
  const tokens = tokenizeGraphql(source);
  let i = 0;
  const peek = () => tokens[i];
  const take = () => tokens[i++];
  function value() {
    const token = take();
    if (token === '$') return variables[take()];
    if (token === '[') {
      const items = [];
      while (peek() && peek() !== ']') items.push(value());
      take();
      return items;
    }
    if (token === '{') {
      const object = {};
      while (peek() && peek() !== '}') {
        const key = take();
        take();
        object[key] = value();
      }
      take();
      return object;
    }
    if (token === 'null') return null;
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (token?.startsWith('"')) {
      try { return JSON.parse(token); } catch { return token.slice(1, -1); }
    }
    if (token && /^-?\d/.test(token)) return Number(token);
    return token;
  }
  function skipGroup(open, close) {
    if (peek() !== open) return;
    let depth = 0;
    do {
      const token = take();
      if (token === open) depth++;
      if (token === close) depth--;
    } while (i < tokens.length && depth > 0);
  }
  function selection() {
    const fields = [];
    if (take() !== '{') throw new Error('expected selection set');
    while (peek() && peek() !== '}') {
      if (peek() === '...') {
        take();
        if (peek() === 'on') { take(); const type = take(); fields.push({ name: '__fragment', type, selection: selection() }); }
        else take();
        continue;
      }
      const first = take();
      if (!first || !/^[_A-Za-z]/.test(first)) { i++; continue; }
      let name = first;
      let alias = null;
      if (peek() === ':') { take(); alias = name; name = take(); }
      const args = {};
      if (peek() === '(') {
        take();
        while (peek() && peek() !== ')') {
          const key = take();
          if (peek() === ':') { take(); args[key] = value(); }
          else if (peek() === '@') { take(); take(); if (peek() === '(') skipGroup('(', ')'); }
          else take();
        }
        take();
      }
      while (peek() === '@') { take(); take(); if (peek() === '(') skipGroup('(', ')'); }
      const children = peek() === '{' ? selection() : [];
      fields.push({ name, alias, args, selection: children });
    }
    take();
    return fields;
  }
  if (peek() === 'query' || peek() === 'mutation' || peek() === 'subscription') {
    take();
    if (peek() && /^[_A-Za-z]/.test(peek()) && peek() !== 'on') take();
    if (peek() === '(') skipGroup('(', ')');
    while (peek() === '@') { take(); take(); if (peek() === '(') skipGroup('(', ')'); }
  }
  return selection();
}

const typeFields = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'labels', 'user', 'comments', 'createdAt', 'updatedAt', 'url'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'title', 'body'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  User: ['id', 'login'],
  IssueConnection: ['nodes', 'pageInfo'],
  PullRequestConnection: ['nodes', 'pageInfo'],
  PageInfo: ['hasNextPage', 'endCursor'],
  PullRequestChangedFile: ['path'],
  __Type: ['name', 'kind', 'fields', 'enumValues'],
  __Field: ['name'],
  __EnumValue: ['name'],
};
const enumValues = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

function gid(type, identity) {
  return Buffer.from(`${type}:${identity}`).toString('base64');
}

function decodeGid(id) {
  try { return Buffer.from(String(id), 'base64').toString('utf8'); } catch { return ''; }
}

function repositoryId(repo) { return gid('Repository', repoKey(repo.owner, repo.name)); }
function issueId(repo, issue) { return gid('Issue', `${repoKey(repo.owner, repo.name)}#${issue.number}`); }
function pullId(repo, pull) { return gid('PullRequest', `${repoKey(repo.owner, repo.name)}#${pull.number}`); }

function graphqlExecute(source, variables = {}) {
  const errors = [];
  let fields;
  try { fields = parseGraphql(source, variables); }
  catch (error) { return { data: null, errors: [{ message: error.message }] }; }
  const mutation = /^\s*mutation\b/.test(source);
  const rootType = mutation ? 'Mutation' : 'Query';
  const root = {};
  for (const field of fields) {
    if (field.name === '__fragment') continue;
    const value = resolveGraphql(rootType, null, field, errors);
    if (value !== undefined) root[field.alias ?? field.name] = value;
  }
  return errors.length ? { data: root, errors } : { data: root };
}

function resolveGraphql(type, parent, field, errors) {
  const { name, args } = field;
  if (name === '__typename') return type;
  let value;
  let childType = '';
  if (type === 'Query') {
    if (name === 'viewer') { value = { login, id: 1000 }; childType = 'User'; }
    else if (name === 'repository') {
      value = repoFor(String(args.owner ?? ''), String(args.name ?? ''));
      childType = 'Repository';
    } else if (name === 'node') {
      const decoded = decodeGid(args.id);
      const repo = decoded.startsWith('Repository:') ? repos.get(decoded.slice(11)) : null;
      value = repo ?? null;
      childType = repo ? 'Repository' : 'Node';
    } else if (name === '__type') {
      const typeName = String(args.name ?? '');
      value = { name: typeName, kind: enumValues[typeName] ? 'ENUM' : 'OBJECT', fields: (typeFields[typeName] ?? []).map((entry) => ({ name: entry })), enumValues: (enumValues[typeName] ?? []).map((entry) => ({ name: entry })) };
      childType = '__Type';
    } else return unknownField(type, name, errors);
  } else if (type === 'Mutation') {
    const input = args.input ?? {};
    if (name === 'createIssue') {
      const identity = decodeGid(input.repositoryId).replace(/^Repository:/, '');
      const repo = repos.get(identity);
      const issue = repo && makeIssue(repo, input);
      value = issue ? { issue, repo } : null;
      childType = 'CreateIssuePayload';
    } else if (name === 'closeIssue') {
      const decoded = decodeGid(input.issueId);
      const issue = findIssueFromGid(decoded);
      if (issue) issue.issue.state = 'closed';
      value = issue ? { issue: issue.issue, repo: issue.repo } : null;
      childType = 'CloseIssuePayload';
    } else if (name === 'createPullRequest') {
      const repo = repos.get(decodeGid(input.repositoryId).replace(/^Repository:/, ''));
      const pull = repo && makePull(repo, { title: input.title, head: input.headRefName, base: input.baseRefName, body: input.body });
      value = pull ? { pullRequest: pull, repo } : null;
      childType = 'CreatePullRequestPayload';
    } else if (name === 'mergePullRequest') {
      const found = findPullFromGid(decodeGid(input.pullRequestId));
      const result = found && mergePull(found.repo, found.pull);
      value = found && result.status === 200 ? { pullRequest: found.pull, repo: found.repo } : null;
      childType = 'MergePullRequestPayload';
    } else if (name === 'addComment') {
      const found = findIssueFromGid(decodeGid(input.subjectId));
      if (found) {
        const comment = { id: found.repo.nextComment++, body: String(input.body ?? ''), user: { login }, created_at: fixedTime };
        found.issue.comments.push(comment);
        value = { commentEdge: { node: comment } };
      } else value = null;
      childType = 'AddCommentPayload';
    } else return unknownField(type, name, errors);
  } else if (type === 'Repository') {
    const repo = parent;
    if (!repo) return null;
    if (name === 'id') return repositoryId(repo);
    if (name === 'databaseId') return repo.id;
    if (name === 'name') return repo.name;
    if (name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
    if (name === 'owner') { value = { login: repo.owner, id: 1000 }; childType = 'User'; }
    else if (name === 'defaultBranchRef') { value = { name: repo.defaultBranch }; childType = 'Ref'; }
    else if (name === 'viewerPermission') return 'ADMIN';
    else if (name === 'hasIssuesEnabled') return true;
    else if (name === 'issue') {
      const issue = findIssue(repo, args.number);
      value = issue ? { issue, repo } : null;
      childType = 'Issue';
    }
    else if (name === 'issues') {
      let list = repo.issues;
      if (Array.isArray(args.states) && args.states.length) {
        const states = new Set(args.states.map((state) => String(state).toLowerCase()));
        list = list.filter((issue) => states.has(issue.state));
      }
      if (args.orderBy) {
        const direction = String(args.orderBy.direction ?? 'ASC').toUpperCase();
        list = [...list].sort((a, b) => direction === 'DESC' ? b.number - a.number : a.number - b.number);
      }
      const start = args.after ? Number(Buffer.from(String(args.after), 'base64').toString('utf8')) || 0 : 0;
      const count = Math.max(0, Math.min(Number(args.first ?? 100), 1000));
      const items = list.slice(start, start + count);
      value = { nodes: items, pageInfo: { hasNextPage: start + count < list.length, endCursor: Buffer.from(String(start + items.length)).toString('base64') }, repo };
      childType = 'IssueConnection';
    } else if (name === 'pullRequests') {
      value = { nodes: repo.pulls.slice(0, Math.max(0, Number(args.first ?? 100))), pageInfo: { hasNextPage: false, endCursor: null }, repo };
      childType = 'PullRequestConnection';
    } else if (name === 'pullRequest') {
      const pull = repo.pulls.find((item) => item.number === Number(args.number));
      value = pull ? { pull, repo } : null;
      childType = 'PullRequest';
    }
    else return unknownField(type, name, errors);
  } else if (type === 'Issue') {
    const issue = parent?.issue ?? parent;
    const repo = parent?.repo ?? parent?.repository ?? null;
    if (!issue) return null;
    if (name === 'id') return repo ? issueId(repo, issue) : issue.id;
    if (name === 'number') return issue.number;
    if (name === 'title' || name === 'body') return issue[name];
    if (name === 'state') return issue.state.toUpperCase();
    if (name === 'labels') { value = issue.labels.map((label) => ({ name: typeof label === 'string' ? label : label.name })); childType = 'LabelConnection'; }
    else if (name === 'user') { value = { login }; childType = 'User'; }
    else if (name === 'comments') return issue.comments.length;
    else if (name === 'createdAt' || name === 'updatedAt') return fixedTime;
    else if (name === 'url') return '';
    else return unknownField(type, name, errors);
  } else if (type === 'PullRequest') {
    const pull = parent?.pull ?? parent;
    const repo = parent?.repo ?? null;
    if (!pull) return null;
    if (name === 'id') return repo ? pullId(repo, pull) : pull.id;
    if (name === 'number') return pull.number;
    if (name === 'title' || name === 'body') return pull[name];
    if (name === 'state') return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    if (name === 'merged') return pull.merged;
    if (name === 'headRefName') return pull.head;
    if (name === 'baseRefName') return pull.base;
    if (name === 'mergeable') return pull.conflict ? 'CONFLICTING' : 'MERGEABLE';
    if (name === 'files') { value = { nodes: repo ? changedFiles(repo, pull).map((file) => ({ path: file.filename })) : [], repo }; childType = 'PullRequestFileConnection'; }
    else return unknownField(type, name, errors);
  } else if (type === 'IssueConnection' || type === 'PullRequestConnection' || type === 'PullRequestFileConnection') {
    if (name === 'nodes') {
      value = type === 'PullRequestFileConnection'
        ? (parent.nodes ?? [])
        : (parent.nodes ?? []).map((item) => type === 'IssueConnection' ? { issue: item, repo: parent.repo } : { pull: item, repo: parent.repo });
      childType = type === 'IssueConnection' ? 'Issue' : type === 'PullRequestConnection' ? 'PullRequest' : 'PullRequestChangedFile';
    } else if (name === 'pageInfo') { value = parent.pageInfo; childType = 'PageInfo'; }
    else return unknownField(type, name, errors);
  } else if (type === 'PageInfo') {
    if (name === 'hasNextPage' || name === 'endCursor') return parent?.[name] ?? null;
    return unknownField(type, name, errors);
  } else if (type === '__Type') {
    if (name === 'name' || name === 'kind') return parent[name];
    if (name === 'fields' || name === 'enumValues') { value = parent[name] ?? []; childType = name === 'fields' ? '__Field' : '__EnumValue'; }
    else return unknownField(type, name, errors);
  } else if (type === '__Field' || type === '__EnumValue') {
    if (name === 'name') return parent.name;
    return unknownField(type, name, errors);
  } else if (type === 'PullRequestChangedFile') {
    if (name === 'path') return parent.path;
    return unknownField(type, name, errors);
  } else if (type === 'Ref') {
    if (name === 'name') return parent.name;
    return unknownField(type, name, errors);
  } else if (type === 'User') {
    if (name === 'login') return parent.login;
    if (name === 'id') return parent.id;
    return unknownField(type, name, errors);
  } else if (type.endsWith('Payload')) {
    if (name === 'issue') {
      value = parent.issue ? { issue: parent.issue, repo: parent.repo } : null; childType = 'Issue';
    } else if (name === 'pullRequest') {
      value = parent.pullRequest ? { pull: parent.pullRequest, repo: parent.repo } : null; childType = 'PullRequest';
    } else if (name === 'commentEdge') { value = parent.commentEdge; childType = 'CommentEdge'; }
    else return unknownField(type, name, errors);
  } else if (type === 'CommentEdge') {
    if (name === 'node') { value = parent.node; childType = 'Comment'; }
    else return unknownField(type, name, errors);
  } else if (type === 'Comment') {
    if (name === 'id') return String(parent.id);
    if (name === 'body') return parent.body;
    return unknownField(type, name, errors);
  } else {
    return unknownField(type, name, errors);
  }
  if (Array.isArray(value)) return value.map((item) => field.selection.length ? executeGraphqlSelection(childType, item, field.selection, errors) : item);
  return field.selection.length ? executeGraphqlSelection(childType, value, field.selection, errors) : value;
}

function executeGraphqlSelection(type, value, fields, errors) {
  if (value === null || value === undefined) return null;
  const result = {};
  for (const field of fields) {
    if (field.name === '__fragment') {
      if (field.type === type || field.type === 'Node') Object.assign(result, executeGraphqlSelection(type, value, field.selection, errors));
      continue;
    }
    const resolved = resolveGraphql(type, value, field, errors);
    if (resolved !== undefined) result[field.alias ?? field.name] = resolved;
  }
  return result;
}

function unknownField(type, name, errors) {
  errors.push({ message: `Cannot query field "${name}" on type "${type}".` });
  return undefined;
}

function findIssueFromGid(value) {
  const match = /^Issue:(.+)#(\d+)$/.exec(value);
  if (!match) return null;
  const repo = repos.get(match[1]);
  const issue = repo && findIssue(repo, match[2]);
  return issue ? { repo, issue } : null;
}

function findPullFromGid(value) {
  const match = /^PullRequest:(.+)#(\d+)$/.exec(value);
  if (!match) return null;
  const repo = repos.get(match[1]);
  const pull = repo?.pulls.find((item) => item.number === Number(match[2]));
  return repo && pull ? { repo, pull } : null;
}

async function handleGraphql(req, res) {
  const body = await readBody(req);
  const execute = (item) => {
    if (!item || typeof item.query !== 'string') return { data: null, errors: [{ message: 'query is required' }] };
    return graphqlExecute(item.query, item.variables ?? {});
  };
  return send(res, 200, Array.isArray(body) ? body.map(execute) : execute(body));
}

const login = (() => {
  const raw = process.env.MAKEFUN_SHOP_LOGIN ?? process.env.MAKEFUN_SHOP_TOKEN ?? 'octocat';
  try {
    const segment = raw.split('.')[1];
    if (segment) {
      const claims = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
      if (typeof claims.login === 'string') return claims.login;
      if (typeof claims.preferred_username === 'string') return claims.preferred_username;
      if (typeof claims.sub === 'string' && /^[a-z0-9-]+$/i.test(claims.sub)) return claims.sub;
    }
  } catch {}
  return raw.split(':')[0].replace(/^Bearer\s+/i, '') || 'octocat';
})();

function makeIssue(repo, input) {
  const names = Array.isArray(input.labels) ? input.labels.map((label) => typeof label === 'string' ? label : label.name).filter(Boolean) : [];
  if (names.some((name) => !repo.labels.has(String(name).toLowerCase()))) return null;
  const issue = {
    id: stableId(`${repo.id}:issue:${repo.nextIssue}`),
    number: repo.nextIssue++,
    title: String(input.title ?? ''),
    body: String(input.body ?? ''),
    state: 'open',
    labels: names.map(String),
    comments: [],
  };
  repo.issues.push(issue);
  return issue;
}

function findIssue(repo, number) {
  return repo.issues.find((issue) => issue.number === Number(number)) ?? null;
}

function makeContents(repo, input, path) {
  const branch = String(input.branch ?? repo.defaultBranch);
  const oldTip = tip(repo, branch);
  const existing = oldTip ? blobAt(repo, oldTip, path) : null;
  if (existing && input.sha !== existing.oid) return { status: 409 };
  if (!existing && input.sha) return { status: 409 };
  const data = Buffer.from(String(input.content ?? ''), input.encoding === 'utf-8' ? 'utf8' : 'base64');
  const blob = putObject(repo, 'blob', data);
  const files = oldTip ? snapshot(repo, oldTip) : new Map();
  files.set(path, { oid: blob, data, mode: '100644' });
  const tree = makeTree(repo, files);
  const commit = makeCommit(repo, tree, oldTip ? [oldTip] : [], String(input.message ?? 'Update file'));
  repo.refs.set(`refs/heads/${branch}`, commit);
  return { status: existing ? 200 : 201, blob, commit };
}

function contentsReply(repo, commit, filePath) {
  const files = snapshot(repo, commit);
  const target = filePath.replace(/^\/+|\/+$/g, '');
  const found = files.get(target);
  if (found) {
    return {
      type: 'file', name: target.split('/').at(-1), path: target, sha: found.oid, size: found.data.length,
      url: `https://api.github.com/repos/${repo.owner}/${repo.name}/contents/${target}`,
      html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${commit}/${target}`,
      git_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/git/blobs/${found.oid}`,
      download_url: null, content: found.data.toString('base64'), encoding: 'base64',
    };
  }
  const prefix = target ? `${target}/` : '';
  const children = new Map();
  for (const [path, entry] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    if (!rest) continue;
    const slash = rest.indexOf('/');
    const name = slash < 0 ? rest : rest.slice(0, slash);
    if (!children.has(name)) children.set(name, slash < 0
      ? { type: 'file', name, path: `${prefix}${name}`, sha: entry.oid, size: entry.data.length }
      : { type: 'dir', name, path: `${prefix}${name}` });
  }
  return children.size ? [...children.values()].sort((a, b) => a.name.localeCompare(b.name)) : null;
}

function ownerMatches(owner) {
  return String(owner).toLowerCase() === login.toLowerCase();
}

async function handleRest(req, res, url, path) {
  if (req.method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
    return send(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (req.method === 'GET' && path === '/api/v3/meta') return send(res, 200, { installed_version: '1.0.0' });
  if (req.method === 'GET' && path === '/api/v3/user') return send(res, 200, { login, id: 1000, type: 'User', name: login });
  if (path === '/api/v3/user/repos' && req.method === 'GET') {
    const all = [...repos.values()].filter((repo) => ownerMatches(repo.owner));
    const perPage = Math.max(1, Math.min(100, Number(url.searchParams.get('per_page') ?? 30) || 30));
    const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1);
    const start = (page - 1) * perPage;
    const headers = {};
    if (start + perPage < all.length) {
      const next = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      next.searchParams.set('page', String(page + 1));
      headers.link = `<${next.href}>; rel="next"`;
    }
    return send(res, 200, all.slice(start, start + perPage).map(repoObject), headers);
  }
  if (path === '/api/v3/user/repos' && req.method === 'POST') {
    const input = await readBody(req);
    const name = String(input.name ?? '');
    if (!name) return fail(res, 422, 'Repository name is required');
    const key = repoKey(login, name);
    if (repos.has(key)) return fail(res, 422, 'Repository already exists');
    const repo = newRepo(login, name, input);
    repos.set(key, repo);
    return send(res, 201, repoObject(repo));
  }

  const match = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(path);
  if (!match) return fail(res, 404, 'Not Found');
  const [, owner, name, suffix = ''] = match;
  const repo = repoFor(owner, name);
  if (!repo) return fail(res, 404, 'Not Found');
  const method = req.method ?? 'GET';

  if (!suffix && method === 'GET') return send(res, 200, repoObject(repo));
  if (!suffix && method === 'PATCH') {
    const input = await readBody(req);
    if (input.description !== undefined) repo.description = String(input.description ?? '');
    return send(res, 200, repoObject(repo));
  }
  if (!suffix && method === 'DELETE') {
    repos.delete(repoKey(owner, name));
    return send(res, 204, null);
  }
  if (suffix === 'branches' && method === 'GET') {
    const branches = [...repo.refs].filter(([ref]) => ref.startsWith('refs/heads/'));
    return send(res, 200, branches.map(([ref, sha]) => ({ name: ref.slice(11), commit: { sha } })));
  }
  if (suffix.startsWith('branches/') && method === 'GET') {
    const branch = suffix.slice('branches/'.length);
    const sha = tip(repo, branch);
    return sha ? send(res, 200, { name: branch, commit: { sha } }) : fail(res, 404, 'Branch not found');
  }
  if (suffix === 'git/refs' && method === 'POST') {
    const input = await readBody(req);
    const ref = String(input.ref ?? '');
    const sha = String(input.sha ?? input.object?.sha ?? '');
    if (!ref.startsWith('refs/') || !getObject(repo, sha)) return fail(res, 422, 'Invalid ref or object');
    if (repo.refs.has(ref)) return fail(res, 422, 'Reference already exists');
    repo.refs.set(ref, sha);
    return send(res, 201, { ref, node_id: Buffer.from(ref).toString('base64'), object: { sha, type: 'commit', url: '' } });
  }
  if (suffix.startsWith('git/refs/') && method === 'GET') {
    const ref = `refs/${suffix.slice('git/refs/'.length)}`;
    const sha = repo.refs.get(ref);
    return sha ? send(res, 200, { ref, object: { sha, type: 'commit', url: '' } }) : fail(res, 404, 'Reference not found');
  }
  if (suffix === 'commits' && method === 'GET') {
    const branch = url.searchParams.get('sha') ?? repo.defaultBranch;
    let oid = repo.refs.get(branch.startsWith('refs/') ? branch : `refs/heads/${branch}`);
    const result = [];
    const seen = new Set();
    while (oid && !seen.has(oid) && result.length < 100) {
      seen.add(oid);
      const commit = parseCommit(repo, oid);
      if (!commit) break;
      result.push({ sha: oid, node_id: Buffer.from(`Commit:${oid}`).toString('base64'), commit: { message: commit.message, tree: { sha: commit.tree }, author: { name: 'Forge', email: 'forge@example.invalid', date: fixedTime } } });
      oid = commit.parents[0];
    }
    return send(res, 200, result);
  }
  if (suffix.startsWith('contents') && (method === 'GET' || method === 'PUT' || method === 'DELETE')) {
    const filePath = suffix.slice('contents'.length).replace(/^\/+/, '');
    const branch = url.searchParams.get('ref') ?? repo.defaultBranch;
    const current = repo.refs.get(branch.startsWith('refs/') ? branch : `refs/heads/${branch}`) ?? '';
    if (method === 'GET') {
      const found = contentsReply(repo, current, filePath);
      return found ? send(res, 200, found) : fail(res, 404, 'Not Found');
    }
    const input = await readBody(req);
    if (!filePath) return fail(res, 422, 'A file path is required');
    if (method === 'PUT') {
      const result = makeContents(repo, input, filePath);
      if (result.status === 409) return fail(res, 409, 'sha does not match');
      return send(res, result.status, {
        content: { name: filePath.split('/').at(-1), path: filePath, sha: result.blob, size: Buffer.from(String(input.content ?? ''), input.encoding === 'utf-8' ? 'utf8' : 'base64').length, encoding: 'base64' },
        commit: { sha: result.commit, message: input.message ?? 'Update file', html_url: '' },
      });
    }
    const existing = current ? blobAt(repo, current, filePath) : null;
    if (!existing) return fail(res, 404, 'Not Found');
    if (input.sha !== existing.oid) return fail(res, 409, 'sha does not match');
    const commit = commitForFileChange(repo, branch, filePath, Buffer.alloc(0), true);
    return send(res, 200, { commit: { sha: commit } });
  }
  if (suffix === 'labels' && method === 'POST') {
    const input = await readBody(req);
    const label = { name: String(input.name ?? ''), color: String(input.color ?? 'ededed'), description: String(input.description ?? '') };
    if (!label.name) return fail(res, 422, 'Label name is required');
    repo.labels.set(label.name.toLowerCase(), label);
    return send(res, 201, label);
  }
  if (suffix === 'issues' && method === 'POST') {
    const input = await readBody(req);
    const issue = makeIssue(repo, input);
    return issue ? send(res, 201, issueObject(repo, issue)) : fail(res, 422, 'Validation Failed');
  }
  if (suffix === 'issues' && method === 'GET') {
    const state = (url.searchParams.get('state') ?? 'open').toLowerCase();
    let items = repo.issues.filter((issue) => state === 'all' || issue.state === state);
    const direction = (url.searchParams.get('direction') ?? 'desc').toLowerCase();
    const sort = (url.searchParams.get('sort') ?? 'created').toLowerCase();
    if (sort === 'created') items = [...items].sort((a, b) => direction === 'asc' ? a.number - b.number : b.number - a.number);
    return send(res, 200, items.map((issue) => issueObject(repo, issue)));
  }
  let issueMatch = /^issues\/(\d+)(?:\/(comments))?$/.exec(suffix);
  if (issueMatch) {
    const issue = findIssue(repo, issueMatch[1]);
    if (!issue) return fail(res, 404, 'Not Found');
    if (issueMatch[2] === 'comments') {
      if (method === 'GET') return send(res, 200, issue.comments);
      if (method === 'POST') {
        const input = await readBody(req);
        const comment = { id: repo.nextComment++, body: String(input.body ?? ''), user: { login }, created_at: fixedTime };
        issue.comments.push(comment);
        return send(res, 201, comment);
      }
    } else {
      if (method === 'GET') return send(res, 200, issueObject(repo, issue));
      if (method === 'PATCH') {
        const input = await readBody(req);
        if (input.title !== undefined) issue.title = String(input.title);
        if (input.body !== undefined) issue.body = String(input.body);
        if (input.state === 'closed' || input.state === 'open') issue.state = input.state;
        if (Array.isArray(input.labels)) issue.labels = input.labels.map(String);
        return send(res, 200, issueObject(repo, issue));
      }
    }
  }
  if (suffix === 'pulls' && method === 'POST') {
    const pull = makePull(repo, await readBody(req));
    return pull ? send(res, 201, pullObject(repo, pull)) : fail(res, 422, 'Head and base branches must exist');
  }
  if (suffix === 'pulls' && method === 'GET') {
    const state = (url.searchParams.get('state') ?? 'open').toLowerCase();
    return send(res, 200, repo.pulls.filter((pull) => state === 'all' || pull.state === state).map((pull) => pullObject(repo, pull)));
  }
  const pullMatch = /^pulls\/(\d+)(?:\/(files|merge))?$/.exec(suffix);
  if (pullMatch) {
    const pull = repo.pulls.find((item) => item.number === Number(pullMatch[1]));
    if (!pull) return fail(res, 404, 'Not Found');
    if (pullMatch[2] === 'files' && method === 'GET') return send(res, 200, changedFiles(repo, pull));
    if (pullMatch[2] === 'merge' && method === 'PUT') {
      const result = mergePull(repo, pull);
      if (result.status === 405) return fail(res, 405, 'Pull request cannot be merged due to conflicts');
      return result.status === 404 ? fail(res, 404, 'Not Found') : send(res, 200, { sha: result.sha, merged: true, message: 'Pull request successfully merged' });
    }
    if (!pullMatch[2] && method === 'GET') return send(res, 200, pullObject(repo, pull));
  }
  return fail(res, 404, 'Not Found');
}

export function createApp() {
  return createServer(async (req, res) => {
    let url;
    let path;
    try {
      url = new URL(req.url ?? '/', 'http://forge');
      path = decodeURIComponent(url.pathname);
    } catch {
      return fail(res, 400, 'Invalid URL');
    }
    try {
      if (req.method === 'GET' && path === '/healthz') return send(res, 200, { ok: true });
      if (path === '/mcp') {
        if (!authorized(req)) return fail(res, 401, 'Bad credentials');
        return handleMcp(req, res);
      }
      if (path === '/api/graphql') {
        if (!authorized(req)) return fail(res, 401, 'Bad credentials');
        return await handleGraphql(req, res);
      }
      if (path.startsWith('/api/')) {
        if (!authorized(req)) return fail(res, 401, 'Bad credentials');
        return await handleRest(req, res, url, path);
      }
      if (/^\/[^/]+\/[^/]+\.git(?:\/|$)/.test(path)) {
        if (!authorized(req)) return fail(res, 401, 'Bad credentials');
        return await handleGit(req, res, url, path);
      }
      return fail(res, 404, 'Not Found');
    } catch (error) {
      if (error instanceof SyntaxError) return fail(res, 400, 'Problems parsing JSON');
      if (error instanceof Error && error.message === 'request body too large') return fail(res, 413, error.message);
      if (!res.headersSent) return fail(res, 500, 'Internal server error');
      res.destroy();
    }
  });
}

import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { HttpError } from './errors.js';

const block = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
]) {
  block.addSubnet(address, prefix, 'ipv4');
}
for (const [address, prefix] of [
  ['::1', 128],
  ['::', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
]) {
  block.addSubnet(address, prefix, 'ipv6');
}

export function ipBlocked(address) {
  let ip = String(address || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (ip.startsWith('::ffff:')) ip = ip.slice('::ffff:'.length);
  const kind = isIP(ip);
  if (kind === 4) return block.check(ip, 'ipv4') || ip === '255.255.255.255';
  if (kind === 6) return block.check(ip, 'ipv6');
  return true;
}

function hostBlocked(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === 'metadata.google.internal') return true;
  return false;
}

export function parsePublicUrl(input) {
  if (typeof input !== 'string' || input.length > 2000) {
    throw new HttpError(400, 'Enter a full product link, including http:// or https://.', 'INVALID_URL');
  }
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    throw new HttpError(400, 'Enter a full product link, including http:// or https://.', 'INVALID_URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HttpError(400, 'Only http and https product links are supported.', 'INVALID_URL');
  }
  if (url.username || url.password) {
    throw new HttpError(400, 'Links with embedded passwords are not supported.', 'INVALID_URL');
  }
  if (hostBlocked(url.hostname) || (isIP(url.hostname) && ipBlocked(url.hostname))) {
    throw new HttpError(400, 'That link points to a private or local address and was blocked.', 'BLOCKED_URL');
  }
  return url;
}

export async function assertPublicResolution(url) {
  if (isIP(url.hostname)) return;
  let records;
  try {
    records = await lookup(url.hostname, { all: true, verbatim: true });
  } catch {
    throw new HttpError(422, 'That link could not be reached.', 'UNREACHABLE');
  }
  if (records.length === 0 || records.some((record) => ipBlocked(record.address))) {
    throw new HttpError(400, 'That link points to a private or local address and was blocked.', 'BLOCKED_URL');
  }
}

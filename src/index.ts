import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { API as MegaAPI, File as MegaFile, decrypt as megaDecrypt } from 'megajs';

type Env = {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  VITE_SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  SESSION_SECRET?: string;
};

let runtimeEnv: Env;

function envGet(key: string): string | undefined {
  return runtimeEnv?.[key as keyof Env] as string | undefined;
}

// ============================================================================
// Constants & Shared Helpers
// ============================================================================

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const STORAGE_TICKET_TTL_MS = 3 * 60 * 60 * 1000;
const NODE_KEY_TTL_MS = 7 * ONE_DAY_MS;
const STREAM_CACHE_BLOCK_BYTES = 2 * 1024 * 1024;
const MAX_DB_STREAM_CACHE_BYTES = 128 * 1024 * 1024;

const DEFAULT_ADMIN_USERNAME = 'admin';
const DEFAULT_ADMIN_EMAIL = 'rifatahmedsajeeb@gmail.com';
const DEFAULT_ADMIN_PASSWORD = 'admin123';
const SESSION_TTL_MS = 7 * ONE_DAY_MS;
const ADMIN_SESSION_COOKIE = 'cinemega_admin_session';

const MEGA_GATEWAYS = [
  { id: 'primary_gateway_co_nz', url: 'https://g.api.mega.co.nz/' },
  { id: 'mirror_gateway_mega_nz', url: 'https://g.api.mega.nz/' },
  { id: 'eu_mirror_gateway', url: 'https://eu.api.mega.co.nz/' },
] as const;

const BROWSER_USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
];

const VIDEO_EXTENSIONS = new Set([
  'mp4',
  'mkv',
  'webm',
  'mov',
  'm4v',
  'avi',
  'ts',
  'ogv',
  'flv',
  '3gp',
]);

const MIME_BY_EXTENSION: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  ts: 'video/mp2t',
  ogv: 'video/ogg',
  flv: 'video/x-flv',
  '3gp': 'video/3gpp',
};

const GENRE_KEYWORDS: Array<{ pattern: RegExp; genre: string }> = [
  { pattern: /\b(sci[- ]?fi|space|cyber|galaxy|future|dystop|orbit|alien)\b/i, genre: 'Sci-Fi' },
  { pattern: /\b(doc|documentary|nature|earth|history|wild|alpine|ocean)\b/i, genre: 'Documentary' },
  { pattern: /\b(action|thriller|chase|heist|martial|war|combat)\b/i, genre: 'Action' },
  { pattern: /\b(noir|crime|mystery|detective|shadow|midnight)\b/i, genre: 'Noir & Mystery' },
  { pattern: /\b(anime|animation|animated|cartoon|ghibli|ova)\b/i, genre: 'Animation' },
  { pattern: /\b(horror|scary|ghost|slasher|haunt)\b/i, genre: 'Horror' },
  { pattern: /\b(comedy|standup|funny|sitcom)\b/i, genre: 'Comedy' },
  { pattern: /\b(drama|indie|short|festival|cinema)\b/i, genre: 'Drama & Indie' },
];

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-viewer-key, range',
  'Access-Control-Expose-Headers':
    'content-range, content-length, accept-ranges, x-cinemega-cache, x-cinemega-fetcher',
};

interface MediaVideo {
  id: string;
  folderId: string;
  ownerId: string;
  title: string;
  fileName: string;
  nodeId: string;
  megaUrl: string;
  directUrl?: string;
  mimeType: string;
  sizeBytes: number;
  durationSec?: number;
  subpath?: string;
  thumbnailUrl?: string;
  orderIndex: number;
}

interface MediaFolder {
  id: string;
  ownerId: string;
  name: string;
  genre: string;
  megaUrl: string;
  description: string;
  coverImage: string;
  sourceType: 'mega_folder' | 'mega_file' | 'showcase';
  videoCount: number;
  videos: MediaVideo[];
  createdAt?: number;
}

interface WatchState {
  videoId: string;
  folderId: string;
  ownerId: string;
  positionSec: number;
  durationSec: number;
  favorite?: boolean;
  updatedAt: number;
}

interface CollectedMegaVideo {
  nodeId: string;
  fileName: string;
  title: string;
  mimeType: string;
  sizeBytes: number;
  subpath: string;
  orderIndex: number;
}

interface ResolvedMegaTarget {
  nodeId: string;
  fileName: string;
  sizeBytes: number;
  keyBuffer: Buffer;
  downloadId: string | [string, string];
  megaFile?: MegaFile;
}

interface MegaStorageTicket {
  streamKey: string;
  cdnUrl: string;
  sizeBytes: number;
  keyB64: string;
  strategyUsed: string;
  updatedAt: number;
  expiresAt: number;
}

interface CachedMegaEntry {
  root: MegaFile;
  nodeMap: Map<string, MegaFile>;
  filesByName: Map<string, MegaFile>;
  expiresAt: number;
  strategyUsed: string;
}

const DEFAULT_SHOWCASE_FOLDERS: MediaFolder[] = [
  {
    id: 'showcase-scifi-odyssey',
    ownerId: 'showcase',
    name: 'Orbital Odyssey',
    genre: 'Sci-Fi',
    megaUrl: 'showcase://orbital-odyssey',
    description:
      'Deep-space expedition reels and orbital telemetry shorts curated for wide-format theater playback.',
    coverImage: '/src/assets/images/cinema_hero_odyssey_1794917340248.jpg',
    sourceType: 'showcase',
    videoCount: 3,
    videos: [
      {
        id: 'scifi-ep1',
        folderId: 'showcase-scifi-odyssey',
        ownerId: 'showcase',
        title: '01. Eclipse Over Sector Four',
        fileName: '01_Eclipse_Over_Sector_Four.mp4',
        nodeId: '',
        megaUrl: 'showcase://orbital-odyssey',
        directUrl: '/samples/orbital_odyssey.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 432000,
        durationSec: 14,
        subpath: 'Season 1',
        thumbnailUrl: '/src/assets/images/cinema_hero_odyssey_1794917340248.jpg',
        orderIndex: 0,
      },
      {
        id: 'scifi-ep2',
        folderId: 'showcase-scifi-odyssey',
        ownerId: 'showcase',
        title: '02. Meridian Dune Crossing',
        fileName: '02_Meridian_Dune_Crossing.mp4',
        nodeId: '',
        megaUrl: 'showcase://orbital-odyssey',
        directUrl: '/samples/desert_horizon.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 312000,
        durationSec: 14,
        subpath: 'Season 1',
        thumbnailUrl: '/src/assets/images/cinema_desert_sci_1794917341729.jpg',
        orderIndex: 1,
      },
      {
        id: 'scifi-ep3',
        folderId: 'showcase-scifi-odyssey',
        ownerId: 'showcase',
        title: '03. Outer Beacon Signal',
        fileName: '03_Outer_Beacon_Signal.mp4',
        nodeId: '',
        megaUrl: 'showcase://orbital-odyssey',
        directUrl: '/samples/coastal_lighthouse.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 321000,
        durationSec: 14,
        subpath: 'Season 1',
        thumbnailUrl: '/src/assets/images/cinema_coastal_drama_1794917343375.jpg',
        orderIndex: 2,
      },
    ],
  },
  {
    id: 'showcase-midnight-noir',
    ownerId: 'showcase',
    name: 'Midnight Tokyo Noir',
    genre: 'Noir & Mystery',
    megaUrl: 'showcase://midnight-noir',
    description:
      'Rain-soaked urban cinema shorts and slow-burn mystery reels with amber tungsten cinematography.',
    coverImage: '/src/assets/images/cinema_noir_rain_1794917341151.jpg',
    sourceType: 'showcase',
    videoCount: 2,
    videos: [
      {
        id: 'noir-ep1',
        folderId: 'showcase-midnight-noir',
        ownerId: 'showcase',
        title: '01. Last Train From Shinjuku',
        fileName: '01_Last_Train_From_Shinjuku.mp4',
        nodeId: '',
        megaUrl: 'showcase://midnight-noir',
        directUrl: '/samples/midnight_noir.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 546000,
        durationSec: 14,
        subpath: 'Anthology',
        thumbnailUrl: '/src/assets/images/cinema_noir_rain_1794917341151.jpg',
        orderIndex: 0,
      },
      {
        id: 'noir-ep2',
        folderId: 'showcase-midnight-noir',
        ownerId: 'showcase',
        title: '02. North Atlantic Fog',
        fileName: '02_North_Atlantic_Fog.mp4',
        nodeId: '',
        megaUrl: 'showcase://midnight-noir',
        directUrl: '/samples/coastal_lighthouse.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 321000,
        durationSec: 14,
        subpath: 'Anthology',
        thumbnailUrl: '/src/assets/images/cinema_coastal_drama_1794917343375.jpg',
        orderIndex: 1,
      },
    ],
  },
  {
    id: 'showcase-alpine-docs',
    ownerId: 'showcase',
    name: 'Earth & Alpine Reels',
    genre: 'Documentary',
    megaUrl: 'showcase://alpine-docs',
    description:
      'High-altitude expeditions, Patagonian ridges, and arid plateau studies filmed in widescreen.',
    coverImage: '/src/assets/images/cinema_alpine_doc_1794917341780.jpg',
    sourceType: 'showcase',
    videoCount: 2,
    videos: [
      {
        id: 'doc-ep1',
        folderId: 'showcase-alpine-docs',
        ownerId: 'showcase',
        title: '01. Fitz Roy First Light',
        fileName: '01_Fitz_Roy_First_Light.mp4',
        nodeId: '',
        megaUrl: 'showcase://alpine-docs',
        directUrl: '/samples/patagonia_peaks.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 434000,
        durationSec: 14,
        subpath: 'Patagonia',
        thumbnailUrl: '/src/assets/images/cinema_alpine_doc_1794917341780.jpg',
        orderIndex: 0,
      },
      {
        id: 'doc-ep2',
        folderId: 'showcase-alpine-docs',
        ownerId: 'showcase',
        title: '02. Atacama Twilight Plateau',
        fileName: '02_Atacama_Twilight_Plateau.mp4',
        nodeId: '',
        megaUrl: 'showcase://alpine-docs',
        directUrl: '/samples/desert_horizon.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 312000,
        durationSec: 14,
        subpath: 'Atacama',
        thumbnailUrl: '/src/assets/images/cinema_desert_sci_1794917341729.jpg',
        orderIndex: 1,
      },
    ],
  },
];

function jsonResponse(data: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
      ...(extraHeaders || {}),
    },
  });
}

function getFileExtension(fileName: string): string {
  const idx = fileName.lastIndexOf('.');
  if (idx <= 0 || idx === fileName.length - 1) return '';
  return fileName.slice(idx + 1).toLowerCase();
}

function isVideoFileName(fileName: string): boolean {
  return VIDEO_EXTENSIONS.has(getFileExtension(fileName));
}

function getMimeTypeFromFileName(fileName: string): string {
  return MIME_BY_EXTENSION[getFileExtension(fileName)] || 'video/mp4';
}

function cleanVideoTitle(fileName: string): string {
  const withoutExt = fileName.replace(/\.[^.]+$/, '');
  const spaced = withoutExt.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
  const cleaned = spaced
    .replace(
      /\b(2160p|1080p|720p|480p|4k|uhd|hdr|bluray|bdrip|webrip|web-dl|x264|x265|hevc|aac|dts|mp4|mkv)\b/gi,
      ''
    )
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || spaced || fileName;
}

function inferGenreFromFolderName(folderName: string): string {
  const trimmed = folderName.trim();
  for (const rule of GENRE_KEYWORDS) {
    if (rule.pattern.test(trimmed)) return rule.genre;
  }
  return trimmed.slice(0, 60) || 'Custom Collection';
}

function parseMegaUrl(rawUrl: string): {
  valid: boolean;
  kind?: 'folder' | 'file';
  normalizedUrl?: string;
  error?: string;
} {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return { valid: false, error: 'Please paste a public Mega.nz folder or file link.' };
  }
  let urlObj: URL;
  try {
    urlObj = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
  } catch {
    return { valid: false, error: 'Invalid URL format. Example: https://mega.nz/folder/ID#KEY' };
  }

  const host = urlObj.hostname.toLowerCase();
  if (host !== 'mega.nz' && host !== 'www.mega.nz' && host !== 'mega.co.nz' && host !== 'www.mega.co.nz') {
    return { valid: false, error: 'URL must be a mega.nz or mega.co.nz public share link.' };
  }

  const pathname = urlObj.pathname;
  const hash = urlObj.hash;

  const modernFolderMatch = pathname.match(/^\/folder\/([a-zA-Z0-9_-]{6,})/);
  if (modernFolderMatch) {
    if (!hash || hash.length < 10) {
      return { valid: false, error: 'This Mega.nz folder link is missing its decryption key (#KEY).' };
    }
    const cleanHash = hash.includes('/file/') ? hash : hash.split('/')[0];
    return {
      valid: true,
      kind: hash.includes('/file/') ? 'file' : 'folder',
      normalizedUrl: `https://mega.nz/folder/${modernFolderMatch[1]}${cleanHash}`,
    };
  }

  const modernFileMatch = pathname.match(/^\/file\/([a-zA-Z0-9_-]{6,})/);
  if (modernFileMatch) {
    if (!hash || hash.length < 10) {
      return { valid: false, error: 'This Mega.nz file link is missing its decryption key (#KEY).' };
    }
    return {
      valid: true,
      kind: 'file',
      normalizedUrl: `https://mega.nz/file/${modernFileMatch[1]}${hash}`,
    };
  }

  if (hash.startsWith('#F!')) {
    const parts = hash.slice(3).split('!');
    if (parts.length < 2 || parts[0].length < 4 || parts[1].length < 8) {
      return { valid: false, error: 'Incomplete legacy Mega.nz folder link.' };
    }
    return { valid: true, kind: 'folder', normalizedUrl: `https://mega.nz/#F!${parts[0]}!${parts[1]}` };
  }

  if (hash.startsWith('#!')) {
    const parts = hash.slice(2).split('!');
    if (parts.length < 2 || parts[0].length < 4 || parts[1].length < 8) {
      return { valid: false, error: 'Incomplete legacy Mega.nz file link.' };
    }
    return { valid: true, kind: 'file', normalizedUrl: `https://mega.nz/#!${parts[0]}!${parts[1]}` };
  }

  return { valid: false, error: 'Unrecognized Mega.nz link format. Expected /folder/...#... or /file/...#...' };
}

function parseByteRange(
  rangeHeader: string | null | undefined,
  totalSize: number
): { valid: boolean; isRange: boolean; start: number; end: number } {
  if (totalSize <= 0) return { valid: false, isRange: false, start: 0, end: 0 };
  if (!rangeHeader) return { valid: true, isRange: false, start: 0, end: totalSize - 1 };

  const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/i);
  if (!match) return { valid: false, isRange: true, start: 0, end: totalSize - 1 };

  const startStr = match[1];
  const endStr = match[2];
  let start = startStr ? Number.parseInt(startStr, 10) : 0;
  let end = endStr ? Number.parseInt(endStr, 10) : totalSize - 1;

  if (!startStr && endStr) {
    const suffixLen = Number.parseInt(endStr, 10);
    start = Math.max(0, totalSize - suffixLen);
    end = totalSize - 1;
  }

  if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || start >= totalSize || end < start) {
    return { valid: false, isRange: true, start: 0, end: totalSize - 1 };
  }

  return { valid: true, isRange: true, start, end: Math.min(end, totalSize - 1) };
}

function computeBlockRanges(
  start: number,
  end: number,
  totalSize: number,
  blockSize = STREAM_CACHE_BLOCK_BYTES
) {
  if (totalSize <= 0 || blockSize <= 0 || start < 0 || end < start || start >= totalSize) return [];
  const clampedEnd = Math.min(end, totalSize - 1);
  const firstBlock = Math.floor(start / blockSize);
  const lastBlock = Math.floor(clampedEnd / blockSize);
  const slices = [];

  for (let blockIndex = firstBlock; blockIndex <= lastBlock; blockIndex++) {
    const blockStart = blockIndex * blockSize;
    const blockEnd = Math.min(totalSize - 1, blockStart + blockSize - 1);
    const reqStart = Math.max(start, blockStart);
    const reqEnd = Math.min(clampedEnd, blockEnd);
    slices.push({
      blockIndex,
      blockStart,
      blockEnd,
      sliceStartInBlock: reqStart - blockStart,
      sliceEndInBlock: reqEnd - blockStart,
      sliceLength: reqEnd - reqStart + 1,
    });
  }
  return slices;
}

function hashKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 24);
}

function sanitizeIdForFile(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'thumb';
}

function normalizeRoutePath(pathname: string): string {
  const apiIdx = pathname.indexOf('/api/');
  if (apiIdx !== -1) {
    return pathname.slice(apiIdx);
  }
  if (pathname.endsWith('/api')) {
    return '/api';
  }
  const fnMatch = pathname.match(/^\/functions\/v1\/[^/]+(.*)$/);
  if (fnMatch) {
    return fnMatch[1] || '/';
  }
  return pathname;
}

// ============================================================================
// Supabase Client Factory
// ============================================================================

let cachedSupabase: SupabaseClient | null = null;
function getSupabase(): SupabaseClient {
  if (cachedSupabase) return cachedSupabase;
  const url = envGet('SUPABASE_URL') || envGet('VITE_SUPABASE_URL') || '';
  const serviceKey =
    envGet('SUPABASE_SERVICE_ROLE_KEY') || envGet('SUPABASE_ANON_KEY') || '';
  if (!url || !serviceKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be configured in Edge secrets.');
  }
  cachedSupabase = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cachedSupabase;
}

// ============================================================================
// Admin Auth Store (Compatible with server.ts admin_config & scrypt hashes)
// ============================================================================

interface StoredAdminConfig {
  username: string;
  email: string;
  passwordSalt: string;
  passwordHash: string;
  updatedAt: number;
}

function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function safeEqualHex(aHex: string, bHex: string): boolean {
  try {
    const a = Buffer.from(aHex, 'hex');
    const b = Buffer.from(bHex, 'hex');
    if (a.length !== b.length || a.length === 0) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function getSessionSecret(config: StoredAdminConfig): string {
  return (
    envGet('SESSION_SECRET') ||
    crypto.createHash('sha256').update(`cinemega-session:${config.passwordSalt}`).digest('hex')
  );
}

async function loadOrInitAdminConfig(): Promise<StoredAdminConfig> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('admin_config')
    .select('username, email, password_salt, password_hash, updated_at')
    .eq('id', 1)
    .maybeSingle();

  if (error) {
    throw new Error(`Supabase admin_config read failed: ${error.message}`);
  }
  if (data) {
    return {
      username: data.username || DEFAULT_ADMIN_USERNAME,
      email: data.email || DEFAULT_ADMIN_EMAIL,
      passwordSalt: data.password_salt,
      passwordHash: data.password_hash,
      updatedAt: Number(data.updated_at) || Date.now(),
    };
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const initial: StoredAdminConfig = {
    username: DEFAULT_ADMIN_USERNAME,
    email: DEFAULT_ADMIN_EMAIL,
    passwordSalt: salt,
    passwordHash: hashPassword(DEFAULT_ADMIN_PASSWORD, salt),
    updatedAt: Date.now(),
  };
  await supabase.from('admin_config').upsert({
    id: 1,
    username: initial.username,
    email: initial.email,
    password_salt: initial.passwordSalt,
    password_hash: initial.passwordHash,
    updated_at: initial.updatedAt,
  });
  return initial;
}

function getAdminAuthStatusPayload(config: StoredAdminConfig, authenticated: boolean) {
  const defaultHash = hashPassword(DEFAULT_ADMIN_PASSWORD, config.passwordSalt);
  const isDefaultCredentials =
    config.username.trim().toLowerCase() === DEFAULT_ADMIN_USERNAME &&
    safeEqualHex(defaultHash, config.passwordHash);
  return {
    authenticated,
    isDefaultCredentials,
    admin: authenticated
      ? {
          username: config.username,
          email: config.email,
          isDefaultCredentials,
          updatedAt: config.updatedAt,
        }
      : null,
  };
}

function createAdminSessionToken(config: StoredAdminConfig, now = Date.now()): string {
  const payload = {
    u: config.username,
    v: config.passwordHash.slice(0, 16),
    exp: now + SESSION_TTL_MS,
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', getSessionSecret(config))
    .update(encoded)
    .digest('base64url');
  return `${encoded}.${sig}`;
}

function verifyAdminSessionToken(
  config: StoredAdminConfig,
  token: string | undefined,
  now = Date.now()
): boolean {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [encoded, sig] = parts;
  const expectedSig = crypto
    .createHmac('sha256', getSessionSecret(config))
    .update(encoded)
    .digest('base64url');

  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expectedSig);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as {
      u?: string;
      v?: string;
      exp?: number;
    };
    if (!payload || typeof payload.exp !== 'number' || payload.exp <= now) return false;
    if (payload.u !== config.username) return false;
    if (payload.v !== config.passwordHash.slice(0, 16)) return false;
    return true;
  } catch {
    return false;
  }
}

function parseCookies(cookieHeader: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) {
      try {
        out[key] = decodeURIComponent(val);
      } catch {
        out[key] = val;
      }
    }
  }
  return out;
}

async function isRequestAdmin(req: Request): Promise<boolean> {
  const config = await loadOrInitAdminConfig();
  const authHeader = req.headers.get('authorization') || '';
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (verifyAdminSessionToken(config, token)) return true;
  }
  const cookies = parseCookies(req.headers.get('cookie'));
  return verifyAdminSessionToken(config, cookies[ADMIN_SESSION_COOKIE]);
}

// ============================================================================
// Library Store & Watch State Store & Analytics/Cache Store
// ============================================================================

async function ensureSeededFolders(): Promise<void> {
  const supabase = getSupabase();
  const { data: metaRow, error: metaErr } = await supabase
    .from('library_meta')
    .select('value')
    .eq('key', 'seeded')
    .maybeSingle();

  if (metaErr) throw new Error(`Supabase library_meta check failed: ${metaErr.message}`);
  if (!metaRow) {
    const now = Date.now();
    await supabase.from('library_folders').upsert(
      DEFAULT_SHOWCASE_FOLDERS.map((folder, idx) => ({
        folder_id: folder.id,
        position: idx,
        folder_json: folder,
        updated_at: now,
      }))
    );
    await supabase.from('library_meta').upsert({ key: 'seeded', value: '1' });
  }
}

async function getAllFolders(): Promise<MediaFolder[]> {
  await ensureSeededFolders();
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('library_folders')
    .select('folder_json')
    .order('position', { ascending: true });
  if (error) throw new Error(`Supabase getFolders failed: ${error.message}`);

  const result: MediaFolder[] = [];
  for (const row of data || []) {
    const parsed = row.folder_json as MediaFolder;
    if (parsed && typeof parsed.id === 'string' && Array.isArray(parsed.videos)) {
      result.push(parsed);
    }
  }
  return result;
}

async function saveAllFolders(folders: MediaFolder[]): Promise<void> {
  const supabase = getSupabase();
  const now = Date.now();
  const { data: existingRows } = await supabase.from('library_folders').select('folder_id');
  const nextIds = new Set(folders.map((f) => f.id));
  const toDelete = (existingRows || [])
    .map((r) => String(r.folder_id))
    .filter((id) => !nextIds.has(id));

  if (toDelete.length > 0) {
    const { error: delErr } = await supabase
      .from('library_folders')
      .delete()
      .in('folder_id', toDelete);
    if (delErr) throw new Error(`Supabase delete folders failed: ${delErr.message}`);
  }

  if (folders.length > 0) {
    const { error: upsertErr } = await supabase.from('library_folders').upsert(
      folders.map((folder, idx) => ({
        folder_id: folder.id,
        position: idx,
        folder_json: folder,
        updated_at: now,
      }))
    );
    if (upsertErr) throw new Error(`Supabase upsert folders failed: ${upsertErr.message}`);
  }
}

async function ensureAnalyticsRow() {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('analytics_state')
    .select('total_views, total_watch_time_sec, cache_hits, mega_requests, cached_bytes_served')
    .eq('id', 1)
    .maybeSingle();
  if (error) throw new Error(`Supabase analytics_state read failed: ${error.message}`);
  if (data) {
    return {
      total_views: Number(data.total_views) || 0,
      total_watch_time_sec: Number(data.total_watch_time_sec) || 0,
      cache_hits: Number(data.cache_hits) || 0,
      mega_requests: Number(data.mega_requests) || 0,
      cached_bytes_served: Number(data.cached_bytes_served) || 0,
    };
  }
  const initial = {
    id: 1,
    total_views: 0,
    total_watch_time_sec: 0,
    cache_hits: 0,
    mega_requests: 0,
    cached_bytes_served: 0,
  };
  await supabase.from('analytics_state').upsert(initial);
  return initial;
}

async function recordMegaRequest() {
  try {
    const supabase = getSupabase();
    const current = await ensureAnalyticsRow();
    await supabase
      .from('analytics_state')
      .update({ mega_requests: current.mega_requests + 1 })
      .eq('id', 1);
  } catch {
    // Non-fatal
  }
}

async function recordCacheHit(bytesServed = 0) {
  try {
    const supabase = getSupabase();
    const current = await ensureAnalyticsRow();
    await supabase
      .from('analytics_state')
      .update({
        cache_hits: current.cache_hits + 1,
        cached_bytes_served: current.cached_bytes_served + Math.max(0, bytesServed),
      })
      .eq('id', 1);
  } catch {
    // Non-fatal
  }
}

async function readCachedBlock(streamKey: string, blockIndex: number): Promise<Uint8Array | null> {
  const supabase = getSupabase();
  const blockKey = `${hashKey(streamKey)}:${blockIndex}`;
  const now = Date.now();
  const { data, error } = await supabase
    .from('stream_blocks')
    .select('data_base64, expires_at')
    .eq('block_key', blockKey)
    .maybeSingle();
  if (error || !data) return null;
  if (Number(data.expires_at) <= now) {
    await supabase.from('stream_blocks').delete().eq('block_key', blockKey);
    return null;
  }
  void supabase.from('stream_blocks').update({ updated_at: now }).eq('block_key', blockKey);
  return new Uint8Array(Buffer.from(String(data.data_base64), 'base64'));
}

async function writeCachedBlock(streamKey: string, blockIndex: number, data: Uint8Array): Promise<void> {
  try {
    const supabase = getSupabase();
    const hashed = hashKey(streamKey);
    const blockKey = `${hashed}:${blockIndex}`;
    const now = Date.now();
    await supabase.from('stream_blocks').upsert({
      block_key: blockKey,
      stream_key: hashed,
      block_index: blockIndex,
      data_base64: Buffer.from(data).toString('base64'),
      size_bytes: data.byteLength,
      updated_at: now,
      expires_at: now + ONE_DAY_MS,
    });

    const { data: rows } = await supabase
      .from('stream_blocks')
      .select('block_key, size_bytes')
      .order('updated_at', { ascending: true });
    if (rows && rows.length > 0) {
      let total = rows.reduce((acc, r) => acc + (Number(r.size_bytes) || 0), 0);
      if (total > MAX_DB_STREAM_CACHE_BYTES) {
        const toDelete: string[] = [];
        for (const r of rows) {
          if (total <= MAX_DB_STREAM_CACHE_BYTES) break;
          toDelete.push(String(r.block_key));
          total -= Number(r.size_bytes) || 0;
        }
        if (toDelete.length > 0) {
          await supabase.from('stream_blocks').delete().in('block_key', toDelete);
        }
      }
    }
  } catch {
    // Non-fatal
  }
}

// ============================================================================
// 4-Strategy Multi-Gateway Mega.nz Fetcher (Deno Edge Runtime Native)
// ============================================================================

const rootMemoryCache = new Map<string, CachedMegaEntry>();
const gatewayCooldownUntil = new Map<string, number>();
let uaCursor = 0;

function nextUserAgent(): string {
  const ua = BROWSER_USER_AGENTS[uaCursor % BROWSER_USER_AGENTS.length];
  uaCursor = (uaCursor + 1) % BROWSER_USER_AGENTS.length;
  return ua;
}

function getOrderedGateways() {
  const now = Date.now();
  const healthy: Array<{ id: string; url: string }> = [];
  const cooling: Array<{ id: string; url: string }> = [];
  for (const gw of MEGA_GATEWAYS) {
    if ((gatewayCooldownUntil.get(gw.id) || 0) <= now) healthy.push(gw);
    else cooling.push(gw);
  }
  return [...healthy, ...cooling];
}

function createHardenedMegaApi(gatewayUrl: string): MegaAPI {
  const ua = nextUserAgent();
  const api = new MegaAPI(false, {
    gateway: gatewayUrl,
    userAgent: null,
    fetch: async (url: string, opts: RequestInit = {}) => {
      const headers = new Headers(opts.headers || {});
      headers.set('User-Agent', ua);
      headers.set('Accept', '*/*');
      headers.set('Accept-Language', 'en-US,en;q=0.9');
      headers.set('Origin', 'https://mega.nz');
      headers.set('Referer', 'https://mega.nz/');

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 22_000);
      if (opts.signal) {
        opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
      }
      try {
        return await globalThis.fetch(url, { ...opts, headers, signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }
    },
  } as Record<string, unknown>);

  const origRequest = api.request.bind(api) as unknown as (
    json: Record<string, unknown>,
    cb?: (err: Error | null, resp?: unknown) => void,
    retryno?: number
  ) => Promise<unknown>;

  (api as unknown as { request: typeof origRequest }).request = (
    json: Record<string, unknown>,
    cb?: (err: Error | null, resp?: unknown) => void,
    retryno = 0
  ) => {
    const savedQs =
      json && typeof json._querystring === 'object' && json._querystring !== null
        ? { ...(json._querystring as Record<string, string>) }
        : undefined;
    const proxy = new Proxy(json, {
      deleteProperty(target, prop) {
        if (prop === '_querystring') return true;
        delete target[prop as string];
        return true;
      },
    });
    if (savedQs) proxy._querystring = savedQs;
    return origRequest(proxy, cb, retryno);
  };

  return api;
}

function getMegaNodeId(node: MegaFile): string {
  if (typeof node.nodeId === 'string' && node.nodeId) return node.nodeId;
  const downloadId = (node as unknown as { downloadId?: string | string[] }).downloadId;
  if (Array.isArray(downloadId) && typeof downloadId[1] === 'string') return downloadId[1];
  if (typeof downloadId === 'string' && downloadId) return downloadId;
  return '';
}

function collectMegaVideos(
  node: MegaFile,
  parentPath: string,
  nodeMap: Map<string, MegaFile>,
  filesByName: Map<string, MegaFile>,
  results: CollectedMegaVideo[],
  depth = 0
) {
  if (depth > 5 || results.length >= 400) return;
  const resolvedId = getMegaNodeId(node);
  if (resolvedId) nodeMap.set(resolvedId, node);

  if (!node.directory) {
    const fileName = node.name || 'Untitled Video.mp4';
    if (!filesByName.has(fileName)) filesByName.set(fileName, node);
    if (isVideoFileName(fileName)) {
      results.push({
        nodeId: resolvedId,
        fileName,
        title: cleanVideoTitle(fileName),
        mimeType: getMimeTypeFromFileName(fileName),
        sizeBytes: typeof node.size === 'number' ? node.size : 0,
        subpath: parentPath,
        orderIndex: results.length,
      });
    }
    return;
  }

  const children = Array.isArray(node.children) ? [...node.children] : [];
  children.sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { numeric: true }));
  for (const child of children) {
    const nextPath = child.directory
      ? parentPath
        ? `${parentPath} / ${child.name || 'Subfolder'}`
        : child.name || 'Subfolder'
      : parentPath;
    collectMegaVideos(child, nextPath, nodeMap, filesByName, results, depth + 1);
  }
}

async function solveMegaHashcashChallenge(challenge: string): Promise<string> {
  const parts = challenge.split(':');
  if (parts.length < 4) throw new Error(`Invalid X-Hashcash challenge format: ${challenge}`);
  const [version, easinessRaw, timestamp, tokenStr] = parts;
  const easiness = Number(easinessRaw);
  const base = ((easiness & 63) << 1) + 1;
  const shifts = (easiness >> 6) * 7 + 3;
  const threshold = base << shifts;

  const tokenBytes = Buffer.from(tokenStr, 'base64url');
  const buffer = Buffer.alloc(4 + 262144 * 48);
  for (let i = 0; i < 262144; i++) {
    tokenBytes.copy(buffer, 4 + i * 48);
  }

  for (let attempt = 0; attempt < 2_000_000; attempt++) {
    if (attempt > 0 && attempt % 1024 === 0) {
      await new Promise<void>((r) => setTimeout(r, 0));
    }
    const digest = crypto.createHash('sha256').update(buffer).digest();
    if (digest.readUInt32BE(0) <= threshold) {
      const prefix = buffer.subarray(0, 4).toString('base64url');
      return `${version}:${tokenStr}:${timestamp}:${prefix}`;
    }
    for (let j = 0; j < 4; j++) {
      buffer[j] = (buffer[j] + 1) & 0xff;
      if (buffer[j] !== 0) break;
    }
  }
  throw new Error('Exhausted X-Hashcash proof-of-work attempts');
}

async function persistNodeKeys(normalizedUrl: string, entry: CachedMegaEntry): Promise<void> {
  const now = Date.now();
  const expiresAt = now + NODE_KEY_TTL_MS;
  const rows: Array<Record<string, unknown>> = [];

  const collect = (node: MegaFile) => {
    if (node.directory) return;
    const rawKey = (node as unknown as { key?: Uint8Array }).key;
    const downloadId = (node as unknown as { downloadId?: string | string[] }).downloadId;
    if (!rawKey || !(rawKey instanceof Uint8Array) || rawKey.length === 0 || !downloadId) return;
    const keyBuf = Buffer.from(rawKey);
    const nodeId = getMegaNodeId(node) || node.name || 'file';
    rows.push({
      node_cache_key: `${normalizedUrl}::${nodeId}`,
      root_url: normalizedUrl,
      node_id: nodeId,
      file_name: node.name || 'video.mp4',
      size_bytes: typeof node.size === 'number' ? node.size : 0,
      key_b64: keyBuf.toString('base64url'),
      download_id_json: downloadId,
      updated_at: now,
      expires_at: expiresAt,
    });
  };

  if (!entry.root.directory) collect(entry.root);
  else for (const node of entry.nodeMap.values()) collect(node);

  if (rows.length > 0) {
    try {
      await getSupabase().from('mega_node_keys').upsert(rows);
    } catch {
      // Non-fatal
    }
  }
}

async function resolveMegaRoot(normalizedUrl: string): Promise<CachedMegaEntry> {
  const now = Date.now();
  const mem = rootMemoryCache.get(normalizedUrl);
  if (mem && mem.expiresAt > now) return mem;

  const gateways = getOrderedGateways();
  let lastError: Error | null = null;

  for (let idx = 0; idx < gateways.length; idx++) {
    const gw = gateways[idx];
    try {
      void recordMegaRequest();
      const api = createHardenedMegaApi(gw.url);
      const root = MegaFile.fromURL(normalizedUrl, { api } as Record<string, unknown>);
      await root.loadAttributes();

      const nodeMap = new Map<string, MegaFile>();
      const filesByName = new Map<string, MegaFile>();
      const tempResults: CollectedMegaVideo[] = [];
      collectMegaVideos(root, '', nodeMap, filesByName, tempResults);
      for (const childNode of nodeMap.values()) {
        (childNode as unknown as { api: MegaAPI }).api = api;
      }

      const entry: CachedMegaEntry = {
        root,
        nodeMap,
        filesByName,
        expiresAt: Date.now() + ONE_DAY_MS,
        strategyUsed: gw.id,
      };
      gatewayCooldownUntil.delete(gw.id);
      rootMemoryCache.set(normalizedUrl, entry);
      await persistNodeKeys(normalizedUrl, entry);
      return entry;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      gatewayCooldownUntil.set(gw.id, Date.now() + 45_000);
      if (/invalid url|wrong hostname|could not be decrypted|not found in folder/i.test(lastError.message)) {
        throw lastError;
      }
      await new Promise<void>((r) => setTimeout(r, 250 * (idx + 1)));
    }
  }

  throw lastError || new Error('All Mega.nz gateways failed to resolve link attributes.');
}

async function resolveTargetVideo(
  normalizedUrl: string,
  nodeId: string,
  fileNameHint: string
): Promise<ResolvedMegaTarget | null> {
  const now = Date.now();
  const supabase = getSupabase();

  const mem = rootMemoryCache.get(normalizedUrl);
  if (mem && mem.expiresAt > now) {
    let targetFile: MegaFile | undefined;
    if (!mem.root.directory) targetFile = mem.root;
    else {
      if (nodeId) targetFile = mem.nodeMap.get(nodeId);
      if (!targetFile && fileNameHint) targetFile = mem.filesByName.get(fileNameHint);
    }
    if (targetFile && !targetFile.directory) {
      const rawKey = (targetFile as unknown as { key?: Uint8Array }).key;
      const downloadId = (targetFile as unknown as { downloadId?: string | [string, string] }).downloadId;
      if (rawKey && downloadId) {
        return {
          nodeId: getMegaNodeId(targetFile) || targetFile.name || 'video',
          fileName: targetFile.name || fileNameHint || 'video.mp4',
          sizeBytes: typeof targetFile.size === 'number' ? targetFile.size : 0,
          keyBuffer: Buffer.from(rawKey),
          downloadId,
          megaFile: targetFile,
        };
      }
    }
  }

  const parseRow = (row: Record<string, unknown> | null): ResolvedMegaTarget | null => {
    if (!row) return null;
    try {
      const downloadId =
        typeof row.download_id_json === 'string'
          ? (JSON.parse(row.download_id_json) as string | [string, string])
          : (row.download_id_json as string | [string, string]);
      const keyBuffer = Buffer.from(String(row.key_b64 || ''), 'base64url');
      if (keyBuffer.length === 0) return null;
      return {
        nodeId: String(row.node_id || ''),
        fileName: String(row.file_name || fileNameHint || 'video.mp4'),
        sizeBytes: Number(row.size_bytes) || 0,
        keyBuffer,
        downloadId,
      };
    } catch {
      return null;
    }
  };

  if (nodeId) {
    const { data } = await supabase
      .from('mega_node_keys')
      .select('node_id, file_name, size_bytes, key_b64, download_id_json, expires_at')
      .eq('root_url', normalizedUrl)
      .eq('node_id', nodeId)
      .gt('expires_at', now)
      .limit(1)
      .maybeSingle();
    const parsed = parseRow(data);
    if (parsed && parsed.sizeBytes > 0) return parsed;
  }

  if (fileNameHint) {
    const { data } = await supabase
      .from('mega_node_keys')
      .select('node_id, file_name, size_bytes, key_b64, download_id_json, expires_at')
      .eq('root_url', normalizedUrl)
      .eq('file_name', fileNameHint)
      .gt('expires_at', now)
      .limit(1)
      .maybeSingle();
    const parsed = parseRow(data);
    if (parsed && parsed.sizeBytes > 0) return parsed;
  }

  const entry = await resolveMegaRoot(normalizedUrl);
  let targetFile: MegaFile | undefined;
  if (!entry.root.directory) targetFile = entry.root;
  else {
    if (nodeId) targetFile = entry.nodeMap.get(nodeId);
    if (!targetFile && fileNameHint) targetFile = entry.filesByName.get(fileNameHint);
  }
  if (!targetFile || targetFile.directory) return null;
  const rawKey = (targetFile as unknown as { key?: Uint8Array }).key;
  const downloadId = (targetFile as unknown as { downloadId?: string | [string, string] }).downloadId;
  if (!rawKey || !downloadId) return null;

  return {
    nodeId: getMegaNodeId(targetFile) || targetFile.name || 'video',
    fileName: targetFile.name || fileNameHint || 'video.mp4',
    sizeBytes: typeof targetFile.size === 'number' ? targetFile.size : 0,
    keyBuffer: Buffer.from(rawKey),
    downloadId,
    megaFile: targetFile,
  };
}

async function requestCdnTicketViaJsonRpc(
  gatewayUrl: string,
  downloadId: string | [string, string]
): Promise<string> {
  const reqObj: Record<string, unknown> = { a: 'g', g: 1, ssl: 2 };
  const qsParams: Record<string, string> = { id: Math.random().toString().slice(2, 12) };

  if (Array.isArray(downloadId)) {
    qsParams.n = downloadId[0];
    reqObj.n = downloadId[1];
  } else {
    reqObj.p = downloadId;
  }

  let hashcashHeader: string | undefined;
  for (let attempt = 0; attempt < 4; attempt++) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': nextUserAgent(),
      Accept: '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      Origin: 'https://mega.nz',
      Referer: 'https://mega.nz/',
    };
    if (hashcashHeader) headers['X-Hashcash'] = hashcashHeader;

    const endpoint = `${gatewayUrl}cs?${new URLSearchParams(qsParams).toString()}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 18_000);

    let resp: Response;
    try {
      resp = await globalThis.fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify([reqObj]),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const challenge = resp.headers.get('X-Hashcash');
    if (challenge) {
      hashcashHeader = await solveMegaHashcashChallenge(challenge);
      continue;
    }

    if (!resp.ok) throw new Error(`Mega gateway HTTP ${resp.status}`);
    const data = await resp.json();
    const first = Array.isArray(data) ? data[0] : data;
    if (typeof first === 'number' && first < 0) {
      if (first === -3 && attempt < 3) {
        await new Promise<void>((r) => setTimeout(r, 600 * (attempt + 1)));
        continue;
      }
      throw new Error(`Mega API error code ${first}`);
    }
    if (first && typeof first === 'object' && typeof (first as { g?: string }).g === 'string') {
      const gUrl = (first as { g: string }).g;
      if (gUrl.startsWith('http')) return gUrl;
    }
    throw new Error('Mega gateway returned an empty storage ticket');
  }
  throw new Error('Exceeded retries while requesting Mega storage ticket');
}

async function resolveStorageTicket(
  streamKey: string,
  target: ResolvedMegaTarget,
  forceRefresh = false
): Promise<MegaStorageTicket> {
  const supabase = getSupabase();
  const now = Date.now();

  if (!forceRefresh) {
    const { data } = await supabase
      .from('mega_storage_tickets')
      .select('stream_key, cdn_url, size_bytes, key_b64, strategy_used, updated_at, expires_at')
      .eq('stream_key', streamKey)
      .maybeSingle();

    if (data && Number(data.expires_at) > now) {
      return {
        streamKey: String(data.stream_key),
        cdnUrl: String(data.cdn_url),
        sizeBytes: Number(data.size_bytes) || 0,
        keyB64: String(data.key_b64),
        strategyUsed: String(data.strategy_used),
        updatedAt: Number(data.updated_at),
        expiresAt: Number(data.expires_at),
      };
    }
  }

  const gateways = getOrderedGateways();
  let lastError: Error | null = null;

  for (const gw of gateways) {
    try {
      void recordMegaRequest();
      const cdnUrl = await requestCdnTicketViaJsonRpc(gw.url, target.downloadId);
      gatewayCooldownUntil.delete(gw.id);
      const ticket: MegaStorageTicket = {
        streamKey,
        cdnUrl,
        sizeBytes: target.sizeBytes,
        keyB64: target.keyBuffer.toString('base64url'),
        strategyUsed: gw.id,
        updatedAt: now,
        expiresAt: now + STORAGE_TICKET_TTL_MS,
      };
      void supabase.from('mega_storage_tickets').upsert({
        stream_key: ticket.streamKey,
        cdn_url: ticket.cdnUrl,
        size_bytes: ticket.sizeBytes,
        key_b64: ticket.keyB64,
        strategy_used: ticket.strategyUsed,
        updated_at: ticket.updatedAt,
        expires_at: ticket.expiresAt,
      });
      return ticket;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      gatewayCooldownUntil.set(gw.id, Date.now() + 45_000);
    }
  }

  throw lastError || new Error('Unable to acquire Mega storage download ticket from any gateway.');
}

async function openDecryptedRangeStream(
  streamKey: string,
  target: ResolvedMegaTarget,
  start: number,
  end: number
): Promise<{
  stream: ReadableStream<Uint8Array>;
  strategyUsed: string;
  cancel: () => void;
}> {
  const expectedLen = end - start + 1;
  const apiStart = start - (start % 16);
  const skipBytes = start - apiStart;
  const supabase = getSupabase();

  for (const forceRefresh of [false, true]) {
    try {
      const ticket = await resolveStorageTicket(streamKey, target, forceRefresh);
      const abortController = new AbortController();
      const rangeUrl = `${ticket.cdnUrl}/${apiStart}-${end}`;

      const resp = await globalThis.fetch(rangeUrl, {
        method: 'GET',
        headers: {
          'User-Agent': nextUserAgent(),
          Accept: '*/*',
          Origin: 'https://mega.nz',
          Referer: 'https://mega.nz/',
        },
        signal: abortController.signal,
      });

      if (!resp.ok || !resp.body) {
        await supabase.from('mega_storage_tickets').delete().eq('stream_key', streamKey);
        throw new Error(`Mega storage CDN returned HTTP ${resp.status}`);
      }

      const reader = resp.body.getReader();
      const decryptor = megaDecrypt(target.keyBuffer, {
        start: apiStart,
        disableVerification: true,
      }) as unknown as {
        write(chunk: Uint8Array): boolean;
        end(): void;
        destroy(err?: Error): void;
        on(event: string, cb: (...args: unknown[]) => void): void;
      };

      let remainingSkip = skipBytes;
      let remainingLimit = expectedLen;
      let closed = false;

      const cancel = () => {
        if (closed) return;
        closed = true;
        abortController.abort();
        void reader.cancel().catch(() => {});
        try {
          decryptor.destroy();
        } catch {
          // Ignore
        }
      };

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          decryptor.on('data', (rawChunk: unknown) => {
            if (closed || remainingLimit <= 0) return;
            let slice = rawChunk instanceof Uint8Array ? rawChunk : new Uint8Array(rawChunk as ArrayBuffer);
            if (remainingSkip > 0) {
              if (slice.length <= remainingSkip) {
                remainingSkip -= slice.length;
                return;
              }
              slice = slice.subarray(remainingSkip);
              remainingSkip = 0;
            }
            if (slice.length > remainingLimit) {
              slice = slice.subarray(0, remainingLimit);
            }
            remainingLimit -= slice.length;
            controller.enqueue(new Uint8Array(slice));
            if (remainingLimit <= 0) {
              closed = true;
              controller.close();
              abortController.abort();
              void reader.cancel().catch(() => {});
              try {
                decryptor.destroy();
              } catch {
                // Ignore
              }
            }
          });

          decryptor.on('end', () => {
            if (!closed) {
              closed = true;
              controller.close();
            }
          });

          decryptor.on('error', (err: unknown) => {
            if (!closed) {
              closed = true;
              controller.error(err);
            }
          });

          void (async () => {
            try {
              while (!closed) {
                const { value, done } = await reader.read();
                if (closed) break;
                if (done) {
                  decryptor.end();
                  break;
                }
                if (value && value.length > 0) {
                  decryptor.write(Buffer.from(value));
                }
              }
            } catch (err) {
              if (!closed) {
                closed = true;
                controller.error(err);
              }
            }
          })();
        },
        cancel() {
          cancel();
        },
      });

      return {
        stream,
        strategyUsed: forceRefresh ? `${ticket.strategyUsed}_refreshed` : 'direct_cdn_ticket',
        cancel,
      };
    } catch {
      // Proceed to next strategy tier
    }
  }

  // Tier 3 & 4: MegaJS multi-gateway direct file.download stream
  const gateways = getOrderedGateways();
  let lastError: Error | null = null;
  for (let i = 0; i < gateways.length; i++) {
    const gw = gateways[i];
    try {
      void recordMegaRequest();
      const api = createHardenedMegaApi(gw.url);
      const fileNode =
        target.megaFile ||
        new MegaFile({
          downloadId: target.downloadId,
          key: target.keyBuffer,
          directory: false,
          api,
        } as unknown as ConstructorParameters<typeof MegaFile>[0]);
      (fileNode as unknown as { api: MegaAPI }).api = api;

      const rawStream = fileNode.download({
        start,
        end: Math.max(1, end),
        forceHttps: true,
        maxConnections: i === 0 ? 1 : 2,
      }) as unknown as {
        on(event: string, cb: (...args: unknown[]) => void): void;
        destroy?: () => void;
      };

      let remaining = expectedLen;
      let closed = false;
      const cancel = () => {
        closed = true;
        if (typeof rawStream.destroy === 'function') rawStream.destroy();
      };

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          rawStream.on('data', (rawChunk: unknown) => {
            if (closed || remaining <= 0) return;
            let slice = rawChunk instanceof Uint8Array ? rawChunk : new Uint8Array(rawChunk as ArrayBuffer);
            if (slice.length > remaining) slice = slice.subarray(0, remaining);
            remaining -= slice.length;
            controller.enqueue(new Uint8Array(slice));
            if (remaining <= 0) {
              closed = true;
              controller.close();
              if (typeof rawStream.destroy === 'function') rawStream.destroy();
            }
          });
          rawStream.on('end', () => {
            if (!closed) {
              closed = true;
              controller.close();
            }
          });
          rawStream.on('error', (err: unknown) => {
            if (!closed) {
              closed = true;
              controller.error(err);
            }
          });
        },
        cancel() {
          cancel();
        },
      });

      return { stream, strategyUsed: `${gw.id}_stream`, cancel };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      gatewayCooldownUntil.set(gw.id, Date.now() + 45_000);
    }
  }

  throw lastError || new Error('All 4 Mega fetching systems failed to open range stream.');
}

// ============================================================================
// HTTP Request Router (Supabase Edge Function Entry Point)
// ============================================================================

async function handleRequest(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(req.url);
  const route = normalizeRoutePath(url.pathname);
  const method = req.method.toUpperCase();

  try {
    // Health
    if (method === 'GET' && (route === '/api/health' || route === '/health' || route === '/')) {
      return jsonResponse({
        ok: true,
        service: 'cinemega',
        runtime: 'cloudflare-workers',
        database: 'supabase',
        supabaseConfigured: true,
        fetchingSystems: 4,
      });
    }

    // Admin Auth Status
    if (method === 'GET' && route === '/api/admin/me') {
      const config = await loadOrInitAdminConfig();
      const authenticated = await isRequestAdmin(req);
      return jsonResponse(getAdminAuthStatusPayload(config, authenticated));
    }

    // Admin Login
    if (method === 'POST' && route === '/api/admin/login') {
      const body = (await req.json().catch(() => ({}))) as { identifier?: unknown; password?: unknown };
      const identifier = typeof body.identifier === 'string' ? body.identifier.trim().toLowerCase() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      if (!identifier || !password) {
        return jsonResponse({ error: 'Username/email and password are required.' }, 400);
      }
      const config = await loadOrInitAdminConfig();
      const matchesUser =
        identifier === config.username.trim().toLowerCase() ||
        identifier === config.email.trim().toLowerCase();
      const passwordMatches = safeEqualHex(hashPassword(password, config.passwordSalt), config.passwordHash);
      if (!matchesUser || !passwordMatches) {
        return jsonResponse({ error: 'Invalid admin username/email or password.' }, 401);
      }

      const token = createAdminSessionToken(config);
      return jsonResponse(
        { ...getAdminAuthStatusPayload(config, true), token },
        200,
        {
          'Set-Cookie': `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=604800`,
        }
      );
    }

    // Admin Logout
    if (method === 'POST' && route === '/api/admin/logout') {
      return jsonResponse({ ok: true }, 200, {
        'Set-Cookie': `${ADMIN_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=0`,
      });
    }

    // Admin Profile Update
    if (method === 'POST' && route === '/api/admin/profile') {
      if (!(await isRequestAdmin(req))) {
        return jsonResponse({ error: 'Admin authentication required.' }, 401);
      }
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const config = await loadOrInitAdminConfig();
      const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
      if (!safeEqualHex(hashPassword(currentPassword, config.passwordSalt), config.passwordHash)) {
        return jsonResponse({ error: 'Current password is incorrect.' }, 400);
      }

      const nextUsername =
        typeof body.newUsername === 'string' && body.newUsername.trim()
          ? body.newUsername.trim()
          : config.username;
      const nextEmail =
        typeof body.newEmail === 'string' && body.newEmail.trim()
          ? body.newEmail.trim()
          : config.email;
      const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';

      if (nextUsername.length < 2 || nextUsername.length > 40) {
        return jsonResponse({ error: 'Username must be between 2 and 40 characters.' }, 400);
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nextEmail)) {
        return jsonResponse({ error: 'Please enter a valid admin email address.' }, 400);
      }

      let passwordSalt = config.passwordSalt;
      let passwordHash = config.passwordHash;
      if (newPassword.length > 0) {
        if (newPassword.length < 6) {
          return jsonResponse({ error: 'New password must be at least 6 characters.' }, 400);
        }
        passwordSalt = crypto.randomBytes(16).toString('hex');
        passwordHash = hashPassword(newPassword, passwordSalt);
      }

      const updated: StoredAdminConfig = {
        username: nextUsername,
        email: nextEmail,
        passwordSalt,
        passwordHash,
        updatedAt: Date.now(),
      };
      const { error: profileErr } = await getSupabase().from('admin_config').upsert({
        id: 1,
        username: updated.username,
        email: updated.email,
        password_salt: updated.passwordSalt,
        password_hash: updated.passwordHash,
        updated_at: updated.updatedAt,
      });
      if (profileErr) throw new Error(`Supabase admin_config write failed: ${profileErr.message}`);

      const refreshedToken = createAdminSessionToken(updated);
      return jsonResponse({
        ok: true,
        ...getAdminAuthStatusPayload(updated, true),
        token: refreshedToken,
      });
    }

    // Public Catalog Folders
    if (method === 'GET' && route === '/api/folders') {
      const folders = await getAllFolders();
      return jsonResponse({ folders });
    }

    // Stored JPEG Thumbnails
    const thumbMatch = route.match(/^\/api\/thumbnails\/([a-zA-Z0-9_-]+\.jpg)$/);
    if (method === 'GET' && thumbMatch) {
      const fileName = thumbMatch[1];
      const { data, error } = await getSupabase()
        .from('video_thumbnails')
        .select('base64_data')
        .eq('file_name', fileName)
        .maybeSingle();
      if (error || !data?.base64_data) {
        return new Response(null, { status: 404, headers: CORS_HEADERS });
      }
      const bytes = new Uint8Array(Buffer.from(String(data.base64_data), 'base64'));
      return new Response(bytes, {
        status: 200,
        headers: {
          'Content-Type': 'image/jpeg',
          'Cache-Control': 'public, max-age=86400',
          ...CORS_HEADERS,
        },
      });
    }

    // Viewer Watch States
    const viewerKey = (
      req.headers.get('x-viewer-key') ||
      url.searchParams.get('viewerKey') ||
      'default'
    )
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 64) || 'default';

    if (method === 'GET' && route === '/api/watch-states') {
      const { data, error } = await getSupabase()
        .from('viewer_watch_states')
        .select('video_id, folder_id, position_sec, duration_sec, favorite, updated_at')
        .eq('viewer_key', viewerKey);
      if (error) throw new Error(error.message);

      const watchStates: Record<string, WatchState> = {};
      for (const row of data || []) {
        watchStates[row.video_id] = {
          videoId: row.video_id,
          folderId: row.folder_id || '',
          ownerId: viewerKey,
          positionSec: Number(row.position_sec) || 0,
          durationSec: Number(row.duration_sec) || 0,
          favorite: Boolean(row.favorite),
          updatedAt: Number(row.updated_at) || Date.now(),
        };
      }
      return jsonResponse({ watchStates });
    }

    const watchStateMatch = route.match(/^\/api\/watch-states\/([^/]+)$/);
    if (watchStateMatch) {
      const videoId = decodeURIComponent(watchStateMatch[1]).slice(0, 128);
      if (method === 'PUT') {
        const body = (await req.json().catch(() => ({}))) as Partial<WatchState>;
        const cleanState: WatchState = {
          videoId,
          folderId: typeof body.folderId === 'string' ? body.folderId.slice(0, 128) : '',
          ownerId: viewerKey,
          positionSec: Math.max(0, Number(body.positionSec) || 0),
          durationSec: Math.max(0, Number(body.durationSec) || 0),
          favorite: Boolean(body.favorite),
          updatedAt: Number(body.updatedAt) || Date.now(),
        };
        const { error } = await getSupabase().from('viewer_watch_states').upsert({
          viewer_key: viewerKey,
          video_id: cleanState.videoId,
          folder_id: cleanState.folderId,
          position_sec: cleanState.positionSec,
          duration_sec: cleanState.durationSec,
          favorite: cleanState.favorite,
          updated_at: cleanState.updatedAt,
        });
        if (error) throw new Error(error.message);
        return jsonResponse({ watchState: cleanState });
      }
      if (method === 'DELETE') {
        const { error } = await getSupabase()
          .from('viewer_watch_states')
          .delete()
          .eq('viewer_key', viewerKey)
          .eq('video_id', videoId);
        if (error) throw new Error(error.message);
        return jsonResponse({ ok: true });
      }
    }

    // Analytics Events
    if (method === 'POST' && route === '/api/analytics/event') {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const type = body.type === 'view' ? 'view' : body.type === 'watch' ? 'watch' : null;
      if (!type) return jsonResponse({ error: 'Invalid analytics event type.' }, 400);
      const videoId = typeof body.videoId === 'string' ? body.videoId.trim() : '';
      if (!videoId) return jsonResponse({ ok: true });

      const supabase = getSupabase();
      const analytics = await ensureAnalyticsRow();
      const { data: existing } = await supabase
        .from('played_videos')
        .select('views, watch_time_sec')
        .eq('video_id', videoId)
        .maybeSingle();

      let views = Number(existing?.views ?? 0);
      let watchTimeSec = Number(existing?.watch_time_sec ?? 0);

      if (type === 'view') {
        views += 1;
        await supabase
          .from('analytics_state')
          .update({ total_views: analytics.total_views + 1 })
          .eq('id', 1);
      } else {
        const delta = Math.max(0, Math.min(300, Number(body.deltaSec) || 0));
        watchTimeSec = Math.round((watchTimeSec + delta) * 10) / 10;
        await supabase
          .from('analytics_state')
          .update({ total_watch_time_sec: Math.round((analytics.total_watch_time_sec + delta) * 10) / 10 })
          .eq('id', 1);
      }

      await supabase.from('played_videos').upsert({
        video_id: videoId,
        folder_id: typeof body.folderId === 'string' ? body.folderId : '',
        title: typeof body.title === 'string' ? body.title : 'Untitled Video',
        folder_name: typeof body.folderName === 'string' ? body.folderName : 'Collection',
        genre: typeof body.genre === 'string' ? body.genre : 'Custom',
        views,
        watch_time_sec: watchTimeSec,
        last_played_at: Date.now(),
      });
      return jsonResponse({ ok: true });
    }

    // Admin Stats
    if (method === 'GET' && route === '/api/admin/stats') {
      if (!(await isRequestAdmin(req))) {
        return jsonResponse({ error: 'Admin authentication required.' }, 401);
      }
      const supabase = getSupabase();
      const now = Date.now();
      await Promise.all([
        supabase.from('inspect_cache').delete().lte('expires_at', now),
        supabase.from('stream_blocks').delete().lte('expires_at', now),
      ]);

      const [analytics, playedRes, inspectRes, blockRes] = await Promise.all([
        ensureAnalyticsRow(),
        supabase
          .from('played_videos')
          .select('video_id, folder_id, title, folder_name, genre, views, watch_time_sec, last_played_at')
          .order('last_played_at', { ascending: false }),
        supabase
          .from('inspect_cache')
          .select('cache_key, folder_name, suggested_genre, source_type, total_size_bytes, videos_json, cached_at, expires_at')
          .order('cached_at', { ascending: false }),
        supabase.from('stream_blocks').select('size_bytes'),
      ]);

      const playedVideos = (playedRes.data || []).map((row) => ({
        videoId: String(row.video_id),
        folderId: String(row.folder_id || ''),
        title: String(row.title || 'Untitled Video'),
        folderName: String(row.folder_name || 'Collection'),
        genre: String(row.genre || 'Custom'),
        views: Number(row.views) || 0,
        watchTimeSec: Number(row.watch_time_sec) || 0,
        lastPlayedAt: Number(row.last_played_at) || 0,
      }));

      const entries = (inspectRes.data || []).map((row) => ({
        cacheKey: String(row.cache_key),
        folderName: String(row.folder_name),
        genre: String(row.suggested_genre),
        sourceType: row.source_type === 'mega_file' ? 'mega_file' : 'mega_folder',
        videoCount: Array.isArray(row.videos_json) ? row.videos_json.length : 0,
        totalSizeBytes: Number(row.total_size_bytes) || 0,
        cachedAt: Number(row.cached_at) || 0,
        expiresAt: Number(row.expires_at) || 0,
      }));

      const blocks = blockRes.data || [];
      const blockBytes = blocks.reduce((acc, r) => acc + (Number(r.size_bytes) || 0), 0);

      return jsonResponse({
        totalViews: analytics.total_views,
        totalWatchTimeSec: analytics.total_watch_time_sec,
        uniqueVideosPlayed: playedVideos.length,
        playedVideos,
        cache: {
          ttlMs: ONE_DAY_MS,
          ttlHours: 24,
          cacheHits: analytics.cache_hits,
          megaRequests: analytics.mega_requests,
          cachedBytesServed: analytics.cached_bytes_served,
          inspectEntriesCount: entries.length,
          streamBlockCount: blocks.length,
          diskUsageBytes: blockBytes,
          entries,
        },
        updatedAt: now,
      });
    }

    // Admin Cache Clear
    if (method === 'POST' && route === '/api/admin/cache/clear') {
      if (!(await isRequestAdmin(req))) {
        return jsonResponse({ error: 'Admin authentication required.' }, 401);
      }
      const body = (await req.json().catch(() => ({}))) as { cacheKey?: unknown };
      const cacheKey = typeof body.cacheKey === 'string' ? body.cacheKey : undefined;
      const supabase = getSupabase();

      if (cacheKey) {
        await Promise.all([
          supabase.from('inspect_cache').delete().eq('cache_key', cacheKey),
          supabase.from('mega_node_keys').delete().eq('root_url', cacheKey),
          supabase.from('mega_storage_tickets').delete().like('stream_key', `${cacheKey}::%`),
        ]);
      } else {
        rootMemoryCache.clear();
        await Promise.all([
          supabase.from('inspect_cache').delete().neq('cache_key', ''),
          supabase.from('stream_blocks').delete().neq('block_key', ''),
          supabase.from('mega_storage_tickets').delete().neq('stream_key', ''),
          supabase.from('mega_node_keys').delete().neq('node_cache_key', ''),
        ]);
      }

      // Return fresh stats
      const reqUrl = new URL('/api/admin/stats', url.origin);
      return await fetchStatsInternal(reqUrl);
    }

    // Admin Folder Create
    if (method === 'POST' && route === '/api/admin/folders') {
      if (!(await isRequestAdmin(req))) {
        return jsonResponse({ error: 'Admin authentication required.' }, 401);
      }
      const body = (await req.json().catch(() => ({}))) as { folder?: MediaFolder };
      const folder = body.folder;
      if (!folder || typeof folder.id !== 'string' || typeof folder.name !== 'string' || !Array.isArray(folder.videos)) {
        return jsonResponse({ error: 'Valid folder payload is required.' }, 400);
      }
      const current = (await getAllFolders()).filter((f) => f.id !== folder.id);
      current.unshift(folder);
      await saveAllFolders(current);
      return jsonResponse({ folder }, 201);
    }

    // Admin Folder Patch / Delete
    const folderMatch = route.match(/^\/api\/admin\/folders\/([^/]+)$/);
    if (folderMatch) {
      if (!(await isRequestAdmin(req))) {
        return jsonResponse({ error: 'Admin authentication required.' }, 401);
      }
      const folderId = decodeURIComponent(folderMatch[1]);
      if (method === 'PATCH') {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const folders = await getAllFolders();
        const idx = folders.findIndex((f) => f.id === folderId);
        if (idx === -1) return jsonResponse({ error: 'Folder not found.' }, 404);
        const cur = folders[idx];
        const titleOverrides = new Map<string, string>();
        if (Array.isArray(body.videoTitles)) {
          for (const entry of body.videoTitles) {
            if (
              entry &&
              typeof entry === 'object' &&
              typeof (entry as { id?: unknown }).id === 'string' &&
              typeof (entry as { title?: unknown }).title === 'string' &&
              (entry as { title: string }).title.trim()
            ) {
              titleOverrides.set(
                (entry as { id: string }).id,
                (entry as { title: string }).title.trim()
              );
            }
          }
        }
        const updated: MediaFolder = {
          ...cur,
          name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : cur.name,
          genre: typeof body.genre === 'string' && body.genre.trim() ? body.genre.trim() : cur.genre,
          description:
            typeof body.description === 'string' ? body.description.trim() : cur.description,
          coverImage:
            typeof body.coverImage === 'string' && body.coverImage.trim()
              ? body.coverImage.trim()
              : cur.coverImage,
          videos:
            titleOverrides.size > 0
              ? cur.videos.map((v) =>
                  titleOverrides.has(v.id) ? { ...v, title: titleOverrides.get(v.id)! } : v
                )
              : cur.videos,
        };
        folders[idx] = updated;
        await saveAllFolders(folders);
        return jsonResponse({ folder: updated });
      }
      if (method === 'DELETE') {
        const folders = await getAllFolders();
        const targetFolder = folders.find((f) => f.id === folderId);
        if (!targetFolder) return jsonResponse({ error: 'Folder not found.' }, 404);
        const thumbNames = targetFolder.videos.map((v) => `${sanitizeIdForFile(v.id)}.jpg`);
        if (thumbNames.length > 0) {
          await getSupabase().from('video_thumbnails').delete().in('file_name', thumbNames);
        }
        await saveAllFolders(folders.filter((f) => f.id !== folderId));
        return jsonResponse({ ok: true });
      }
    }

    // Public On-Demand Thumbnail Capture / Upload
    if (method === 'POST' && route === '/api/thumbnails/on-demand') {
      const body = (await req.json().catch(() => ({}))) as {
        folderId?: string;
        videoId?: string;
        base64Jpeg?: string;
      };
      if (!body.folderId || !body.videoId) {
        return jsonResponse({ error: 'folderId and videoId are required.' }, 400);
      }
      const folders = await getAllFolders();
      const folder = folders.find((f) => f.id === body.folderId);
      const video = folder?.videos.find((v) => v.id === body.videoId);
      if (!folder || !video) {
        return jsonResponse({ error: 'Folder or video not found in database.' }, 404);
      }
      if (video.thumbnailUrl && video.thumbnailUrl.includes('/api/thumbnails/')) {
        return jsonResponse({
          ok: true,
          alreadyExists: true,
          videoId: video.id,
          thumbnailUrl: video.thumbnailUrl,
          folder,
        });
      }
      const rawBase64 =
        typeof body.base64Jpeg === 'string'
          ? body.base64Jpeg.replace(/^data:image\/\w+;base64,/, '').trim()
          : '';
      if (rawBase64.length > 32 && rawBase64.length <= 800 * 1024) {
        const safeName = `${sanitizeIdForFile(video.id)}.jpg`;
        const now = Date.now();
        await getSupabase().from('video_thumbnails').upsert({
          file_name: safeName,
          video_id: video.id,
          mime_type: 'image/jpeg',
          base64_data: rawBase64,
          updated_at: now,
        });
        const thumbnailUrl = `/api/thumbnails/${safeName}?v=${now}`;
        video.thumbnailUrl = thumbnailUrl;
        if (folder.videos[0]?.id === video.id) folder.coverImage = thumbnailUrl;
        await saveAllFolders(folders);
        return jsonResponse({ ok: true, videoId: video.id, thumbnailUrl, folder });
      }
      return jsonResponse(
        {
          needsClientCapture: true,
          error: 'Client frame capture required on Supabase Edge Function runtime.',
        },
        422
      );
    }

    // Admin Thumbnail Capture / Upload
    if (method === 'POST' && route === '/api/admin/thumbnails/generate') {
      if (!(await isRequestAdmin(req))) {
        return jsonResponse({ error: 'Admin authentication required.' }, 401);
      }
      const body = (await req.json().catch(() => ({}))) as {
        folderId?: string;
        videoId?: string;
        base64Jpeg?: string;
      };
      const rawBase64 =
        typeof body.base64Jpeg === 'string'
          ? body.base64Jpeg.replace(/^data:image\/\w+;base64,/, '').trim()
          : '';
      if (rawBase64.length > 20 && rawBase64.length <= 800 * 1024 && body.folderId && body.videoId) {
        const folders = await getAllFolders();
        const folder = folders.find((f) => f.id === body.folderId);
        const video = folder?.videos.find((v) => v.id === body.videoId);
        if (!folder || !video) {
          return jsonResponse({ error: 'Folder or video not found in database.' }, 404);
        }
        const safeName = `${sanitizeIdForFile(video.id)}.jpg`;
        const now = Date.now();
        await getSupabase().from('video_thumbnails').upsert({
          file_name: safeName,
          video_id: video.id,
          mime_type: 'image/jpeg',
          base64_data: rawBase64,
          updated_at: now,
        });
        const thumbnailUrl = `/api/thumbnails/${safeName}?v=${now}`;
        video.thumbnailUrl = thumbnailUrl;
        if (folder.videos[0]?.id === video.id) folder.coverImage = thumbnailUrl;
        await saveAllFolders(folders);
        return jsonResponse({ ok: true, videoId: video.id, thumbnailUrl, folder });
      }
      return jsonResponse(
        {
          needsClientCapture: true,
          error:
            'Automatic server-side FFmpeg thumbnail extraction requires the Node.js server.ts runtime because Supabase Edge Functions do not bundle an FFmpeg binary.',
        },
        501
      );
    }

    // Mega Inspect
    if (method === 'POST' && route === '/api/mega/inspect') {
      if (!(await isRequestAdmin(req))) {
        return jsonResponse({ error: 'Admin authentication required.' }, 401);
      }
      const body = (await req.json().catch(() => ({}))) as { url?: unknown; forceRefresh?: unknown };
      const rawUrl = typeof body.url === 'string' ? body.url : '';
      const forceRefresh = body.forceRefresh === true;
      const parsed = parseMegaUrl(rawUrl);
      if (!parsed.valid || !parsed.normalizedUrl) {
        return jsonResponse({ error: parsed.error || 'Invalid Mega.nz URL.' }, 400);
      }

      const supabase = getSupabase();
      const now = Date.now();
      if (!forceRefresh) {
        const { data: cached } = await supabase
          .from('inspect_cache')
          .select(
            'folder_name, suggested_genre, source_type, mega_url, total_size_bytes, videos_json, cached_at, expires_at'
          )
          .eq('cache_key', parsed.normalizedUrl)
          .maybeSingle();

        if (cached && Number(cached.expires_at) > now) {
          void recordCacheHit(0);
          return jsonResponse({
            folderName: String(cached.folder_name),
            suggestedGenre: String(cached.suggested_genre),
            sourceType: cached.source_type === 'mega_file' ? 'mega_file' : 'mega_folder',
            megaUrl: String(cached.mega_url),
            totalSizeBytes: Number(cached.total_size_bytes) || 0,
            videos: Array.isArray(cached.videos_json) ? cached.videos_json : [],
            cachedAt: Number(cached.cached_at),
            expiresAt: Number(cached.expires_at),
            cached: true,
          });
        }
      }

      const entry = await resolveMegaRoot(parsed.normalizedUrl);
      const videos: CollectedMegaVideo[] = [];
      const nodeMap = new Map<string, MegaFile>();
      const filesByName = new Map<string, MegaFile>();
      collectMegaVideos(entry.root, '', nodeMap, filesByName, videos);

      if (videos.length === 0) {
        return jsonResponse(
          {
            error:
              'No supported video files (.mp4, .mkv, .webm, .mov, .m4v, .avi) were found in this Mega.nz link.',
          },
          422
        );
      }

      const rawName = entry.root.name || (parsed.kind === 'file' ? videos[0].title : 'Mega Video Collection');
      const folderName = parsed.kind === 'file' ? cleanVideoTitle(rawName) : rawName;
      const totalSizeBytes = videos.reduce((sum, item) => sum + item.sizeBytes, 0);
      const sourceType = parsed.kind === 'file' ? 'mega_file' : 'mega_folder';
      const expiresAt = now + ONE_DAY_MS;

      await supabase.from('inspect_cache').upsert({
        cache_key: parsed.normalizedUrl,
        folder_name: folderName,
        suggested_genre: inferGenreFromFolderName(folderName),
        source_type: sourceType,
        mega_url: parsed.normalizedUrl,
        total_size_bytes: totalSizeBytes,
        videos_json: videos,
        cached_at: now,
        expires_at: expiresAt,
      });

      return jsonResponse({
        folderName,
        suggestedGenre: inferGenreFromFolderName(folderName),
        sourceType,
        megaUrl: parsed.normalizedUrl,
        totalSizeBytes,
        videos,
        cachedAt: now,
        expiresAt,
        cached: false,
      });
    }

    // Mega Video Streaming (HTTP 206 Byte-Range + 2 MB PostgreSQL Block Cache)
    if ((method === 'GET' || method === 'HEAD') && route === '/api/mega/stream') {
      if (url.searchParams.get('transcode') === '1') {
        return jsonResponse(
          {
            error:
              'Live FFmpeg transcoding (?transcode=1) is only supported on the Node.js server.ts backend. Direct MP4/WebM/MOV playback works natively on Supabase Edge Functions.',
          },
          501
        );
      }

      const rawUrl = url.searchParams.get('url') || '';
      const nodeId = url.searchParams.get('nodeId') || '';
      const fileNameHint = url.searchParams.get('fileName') || '';
      const parsed = parseMegaUrl(rawUrl);
      if (!parsed.valid || !parsed.normalizedUrl) {
        return jsonResponse({ error: parsed.error || 'Invalid Mega.nz URL.' }, 400);
      }

      const target = await resolveTargetVideo(parsed.normalizedUrl, nodeId, fileNameHint);
      if (!target) {
        return jsonResponse({ error: 'Requested video node was not found in the Mega.nz folder.' }, 404);
      }

      const totalSize = target.sizeBytes;
      if (totalSize <= 0) {
        return jsonResponse({ error: 'Video file size is unavailable from Mega.nz.' }, 422);
      }

      const fileName = target.fileName || fileNameHint || 'video.mp4';
      const streamKey = `${parsed.normalizedUrl}::${target.nodeId || fileName}`;
      const contentType = getMimeTypeFromFileName(fileName);
      const range = parseByteRange(req.headers.get('range'), totalSize);

      if (!range.valid) {
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${totalSize}`, ...CORS_HEADERS },
        });
      }

      if (method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: {
            'Accept-Ranges': 'bytes',
            'Content-Type': contentType,
            'Content-Length': String(totalSize),
            'Cache-Control': 'private, max-age=86400',
            ...CORS_HEADERS,
          },
        });
      }

      const contentLength = range.end - range.start + 1;
      const baseHeaders: Record<string, string> = {
        'Accept-Ranges': 'bytes',
        'Content-Type': contentType,
        'Content-Length': String(contentLength),
        'Cache-Control': 'private, max-age=86400',
        ...(range.isRange ? { 'Content-Range': `bytes ${range.start}-${range.end}/${totalSize}` } : {}),
        ...CORS_HEADERS,
      };
      const status = range.isRange ? 206 : 200;

      const slices = computeBlockRanges(range.start, range.end, totalSize, STREAM_CACHE_BLOCK_BYTES);
      const firstBlockCached = slices.length > 0 ? await readCachedBlock(streamKey, slices[0].blockIndex) : null;

      if (contentLength < 65536 && !firstBlockCached) {
        const megaEnd = Math.min(totalSize - 1, Math.max(1, range.end));
        const { stream, strategyUsed } = await openDecryptedRangeStream(
          streamKey,
          target,
          range.start,
          megaEnd
        );
        return new Response(stream, {
          status,
          headers: {
            ...baseHeaders,
            'X-CineMega-Cache': 'MISS',
            'X-CineMega-Fetcher': strategyUsed,
          },
        });
      }

      let cancelled = false;
      let activeCancel: (() => void) | null = null;
      const cacheState =
        firstBlockCached && slices.length === 1
          ? 'HIT'
          : firstBlockCached
          ? 'PARTIAL'
          : 'MISS';

      let sliceIndex = 0;
      const bodyStream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            if (cancelled || sliceIndex >= slices.length) {
              if (!cancelled) controller.close();
              return;
            }

            const i = sliceIndex++;
            const slice = slices[i];
            const cachedBlock =
              i === 0 && firstBlockCached
                ? firstBlockCached
                : await readCachedBlock(streamKey, slice.blockIndex);

            if (cachedBlock && cachedBlock.length > slice.sliceEndInBlock) {
              const outSlice = cachedBlock.subarray(slice.sliceStartInBlock, slice.sliceEndInBlock + 1);
              void recordCacheHit(outSlice.length);
              controller.enqueue(outSlice);
              if (sliceIndex >= slices.length) controller.close();
              return;
            }

            const expectedBlockLen = slice.blockEnd - slice.blockStart + 1;
            const { stream, cancel } = await openDecryptedRangeStream(
              streamKey,
              target,
              slice.blockStart,
              slice.blockEnd
            );
            activeCancel = cancel;

            const reader = stream.getReader();
            const blockParts: Uint8Array[] = [];
            let blockOffset = 0;

            try {
              while (!cancelled && blockOffset < expectedBlockLen) {
                const { value, done } = await reader.read();
                if (done || !value) break;
                const remaining = expectedBlockLen - blockOffset;
                const chunk = value.length > remaining ? value.subarray(0, remaining) : value;
                const chunkStart = blockOffset;
                const chunkEnd = blockOffset + chunk.length - 1;
                blockOffset += chunk.length;
                blockParts.push(chunk);

                const overlapStart = Math.max(chunkStart, slice.sliceStartInBlock);
                const overlapEnd = Math.min(chunkEnd, slice.sliceEndInBlock);
                if (overlapStart <= overlapEnd && !cancelled) {
                  controller.enqueue(
                    chunk.subarray(overlapStart - chunkStart, overlapEnd - chunkStart + 1)
                  );
                }
              }
            } finally {
              await reader.cancel().catch(() => {});
            }

            if (!cancelled && blockOffset === expectedBlockLen) {
              const fullBlock = new Uint8Array(expectedBlockLen);
              let cursor = 0;
              for (const part of blockParts) {
                fullBlock.set(part, cursor);
                cursor += part.length;
              }
              void writeCachedBlock(streamKey, slice.blockIndex, fullBlock);
            }

            if (!cancelled && sliceIndex >= slices.length) {
              controller.close();
            }
          } catch (err) {
            if (!cancelled) controller.error(err);
          }
        },
        cancel() {
          cancelled = true;
          if (activeCancel) activeCancel();
        },
      });

      return new Response(bodyStream, {
        status,
        headers: {
          ...baseHeaders,
          'X-CineMega-Cache': cacheState,
          'X-CineMega-Fetcher': firstBlockCached ? 'db_block_cache' : 'direct_cdn_ticket',
        },
      });
    }

    return jsonResponse({ error: `Route not found: ${method} ${route}` }, 404);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal Edge Function error.';
    return jsonResponse({ error: message }, 500);
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    runtimeEnv = env;
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      return jsonResponse(
        { error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY Worker secret.' },
        500
      );
    }
    return handleRequest(req);
  },
};

async function fetchStatsInternal(_url: URL): Promise<Response> {
  const supabase = getSupabase();
  const now = Date.now();
  const [analytics, playedRes, inspectRes, blockRes] = await Promise.all([
    ensureAnalyticsRow(),
    supabase
      .from('played_videos')
      .select('video_id, folder_id, title, folder_name, genre, views, watch_time_sec, last_played_at')
      .order('last_played_at', { ascending: false }),
    supabase
      .from('inspect_cache')
      .select('cache_key, folder_name, suggested_genre, source_type, total_size_bytes, videos_json, cached_at, expires_at')
      .order('cached_at', { ascending: false }),
    supabase.from('stream_blocks').select('size_bytes'),
  ]);

  const playedVideos = (playedRes.data || []).map((row) => ({
    videoId: String(row.video_id),
    folderId: String(row.folder_id || ''),
    title: String(row.title || 'Untitled Video'),
    folderName: String(row.folder_name || 'Collection'),
    genre: String(row.genre || 'Custom'),
    views: Number(row.views) || 0,
    watchTimeSec: Number(row.watch_time_sec) || 0,
    lastPlayedAt: Number(row.last_played_at) || 0,
  }));

  const entries = (inspectRes.data || []).map((row) => ({
    cacheKey: String(row.cache_key),
    folderName: String(row.folder_name),
    genre: String(row.suggested_genre),
    sourceType: row.source_type === 'mega_file' ? 'mega_file' : 'mega_folder',
    videoCount: Array.isArray(row.videos_json) ? row.videos_json.length : 0,
    totalSizeBytes: Number(row.total_size_bytes) || 0,
    cachedAt: Number(row.cached_at) || 0,
    expiresAt: Number(row.expires_at) || 0,
  }));

  const blocks = blockRes.data || [];
  const blockBytes = blocks.reduce((acc, r) => acc + (Number(r.size_bytes) || 0), 0);

  return jsonResponse({
    totalViews: analytics.total_views,
    totalWatchTimeSec: analytics.total_watch_time_sec,
    uniqueVideosPlayed: playedVideos.length,
    playedVideos,
    cache: {
      ttlMs: ONE_DAY_MS,
      ttlHours: 24,
      cacheHits: analytics.cache_hits,
      megaRequests: analytics.mega_requests,
      cachedBytesServed: analytics.cached_bytes_served,
      inspectEntriesCount: entries.length,
      streamBlockCount: blocks.length,
      diskUsageBytes: blockBytes,
      entries,
    },
    updatedAt: now,
  });
}

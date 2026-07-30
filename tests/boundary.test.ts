import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import fixtureJson from '../fixtures/portfolio.json';
import { portfolioFixtureSchema } from '../src/domain';

const root = process.cwd();

/* ------------------------------------------------------------------------- *
 * D10 — the data-boundary scan.
 *
 * The previous version was a three-token denylist over five paths (`src`,
 * `scripts`, `fixtures`, `tests`, `server.ts`), matching the tokens with `\b`
 * boundaries plus one Windows-path regex. It missed the normal JSON/TS-escaped
 * form of a Windows path, single-quoted paths, forward-slash drive paths, UNC
 * paths, POSIX home paths, a customer code followed by an underscore (`_` is a
 * word character, so `\b` never fires), every customer name outside the three,
 * and everything under `docs/`, `config/`, `migrations/`, `public/` and the
 * root `*.md` files.
 *
 * This version:
 *   - enumerates the COMPLETE tracked tree with `git ls-files`, because what is
 *     committed is the actual boundary;
 *   - runs each matcher over both the raw file text and a copy with `\\`
 *     collapsed to `\`, so source-escaped and literal path forms are both seen;
 *   - matches customer tokens on letter boundaries rather than `\b`, so a
 *     token followed by `_`, `-`, `.` or a digit is caught while the same
 *     letters embedded in an ordinary word or an escape sequence are not;
 *   - inspects file types and binary signatures, so a real transcript, mailbox
 *     item or workbook is caught by shape rather than by whether it happens to
 *     mention one of three names.
 *
 * The matchers are exported and exercised against inline fixtures below, so
 * every miss in the review's table is proven closed without writing an
 * offending string into the repository. Fixtures use synthetic user and
 * organisation names for the same reason.
 * ------------------------------------------------------------------------- */

const BACKSLASH = String.fromCharCode(92);
/** A literal backslash inside a regular-expression source string. */
const RX_BS = `${BACKSLASH}${BACKSLASH}`;
const SEGMENT_CHARS = '[A-Za-z0-9_$.\\-]';

/** A path character, or a space/separator that is followed by a path character. */
function pathTailPattern(separators: string) {
  return `(?:${SEGMENT_CHARS}|[ ](?=${SEGMENT_CHARS})|(?:${separators})(?=${SEGMENT_CHARS}))*`;
}

/**
 * A drive-letter absolute path in all three forms that appear in real source:
 * single-backslash, source-escaped double-backslash, and forward-slash. The
 * lookbehind stops `https:`, `file:`, `ws:` and `data:` URL schemes matching.
 */
const windowsDrivePathPattern = new RegExp(
  `(?<![A-Za-z0-9])[A-Za-z]:(?:${RX_BS}{1,2}|/)${pathTailPattern(`${RX_BS}{1,2}|/`)}`,
  'g',
);

/** A UNC share path, in both its literal and source-escaped backslash forms. */
const uncPathPattern = new RegExp(
  `(?<![A-Za-z0-9${RX_BS}])${RX_BS}{2,4}[A-Za-z0-9]${SEGMENT_CHARS}{1,62}${RX_BS}{1,2}${pathTailPattern(`${RX_BS}{1,2}`)}`,
  'g',
);

/** `/home/<user>/...` (Linux) and `/Users/<user>/...` (macOS). */
const posixHomePathPattern = /(?<![A-Za-z0-9._\-/])\/(?:home|Users)\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._ -]*)*/g;

/**
 * Local cloud-sync folders. The provider name must appear either immediately
 * after a path separator (the Windows sync folder and the macOS CloudStorage
 * folder both have this shape) or in the tenant-folder form, provider name
 * followed by a dash, the organisation and a separator. A bare mention of the
 * product in prose, and the relative fictional fixture paths this repository
 * uses, are deliberately not matches: absolute leaked forms are already
 * covered by the drive, UNC and home matchers above.
 */
const cloudSyncPathPattern = /(?:[\\/]{1,2}(?:OneDrive|SharePoint|Google ?Drive|GoogleDrive|Dropbox|iCloud ?Drive)[^\\/\n"'`]{0,60}[\\/]|(?:OneDrive|Google ?Drive|SharePoint) ?- ?[A-Za-z0-9][^\\/\n"'`]{0,60}[\\/])/gi;

/** Known live customer/tenant names, held as char codes so this file stays clean. */
const customerTokens = [[78, 80, 76], [78, 87, 76, 68, 67], [66, 101, 108, 108, 114, 111, 99, 107]].map((codes) => String.fromCharCode(...codes));
/**
 * Letter boundaries, not `\b`. `_`, `-`, `.` and digits are all legitimate
 * neighbours of a leaked project code in a filename, and `\b` treats `_` as a
 * word character, which is exactly how a `<code>_Register_2026.xlsx` filename
 * slipped past the previous denylist.
 */
const customerTokenPattern = new RegExp(`(?<![A-Za-z])(?:${customerTokens.join('|')})(?![A-Za-z])`, 'gi');

/** File types that are, by definition, a live document rather than product material. */
const forbiddenFileExtensions = new Set(['.vtt', '.srt', '.eml', '.emlx', '.msg', '.mbox', '.pst', '.ost', '.olm', '.one', '.xls', '.xlsx', '.xlsm', '.xlsb', '.doc', '.docx', '.ppt', '.pptx', '.pdf', '.rtf']);

const binarySignatures: Array<{ label: string; bytes: number[] }> = [
  { label: 'zip/OOXML (xlsx, docx, pptx)', bytes: [0x50, 0x4b, 0x03, 0x04] },
  { label: 'OLE2 compound file (msg, xls, doc)', bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] },
  { label: 'PDF', bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  { label: 'Outlook personal folders', bytes: [0x21, 0x42, 0x44, 0x4e] },
];

/**
 * The same signatures as base64, because this application moves every file
 * through `dataBase64`, so a committed workbook or mailbox item is far more
 * likely to appear base64-encoded inside a JSON or TS file than as raw bytes.
 * Derived from the byte signatures rather than written out, so this file does
 * not itself contain the strings it hunts for. Base64 encodes three bytes to
 * four characters from offset zero, so a fixed-length prefix of the encoding of
 * a fixed file prefix is stable whatever follows it.
 */
const base64SignaturePrefixes = binarySignatures.map((signature) => {
  const encoded = Buffer.from(signature.bytes).toString('base64').replace(/=+$/, '');
  return encoded.slice(0, Math.floor((signature.bytes.length * 8) / 6));
});
const base64OfficePayloadPattern = new RegExp(`(?<![A-Za-z0-9+/])(?:${base64SignaturePrefixes.join('|')})`, 'g');

/** A real transcript has many cues; the synthetic fixtures in this repo have at most four. */
const vttCuePattern = /\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->\s*/g;
const vttCueThreshold = 12;
/** RFC 822 headers at line starts — an actual `.eml`/`.msg` payload, not an escaped test string. */
const emailHeaderPattern = /^(?:From|To|Cc|Bcc|Subject|Date|Message-ID|Received|Return-Path):/gim;
const emailHeaderThreshold = 4;

export type BoundaryRule =
  | 'windows-drive-path'
  | 'unc-path'
  | 'posix-home-path'
  | 'cloud-sync-path'
  | 'customer-token'
  | 'office-payload-base64'
  | 'live-document-file-type'
  | 'binary-document-signature'
  | 'transcript-payload'
  | 'email-payload';

export interface BoundaryFinding {
  file: string;
  rule: BoundaryRule;
  match: string;
}

function unique(values: string[]) {
  return [...new Set(values)];
}

function matchAll(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(new RegExp(pattern.source, pattern.flags))].map((entry) => entry[0]);
}

/** Raw text plus a copy with source-level `\\` escapes collapsed to `\`. */
function textForms(text: string): string[] {
  const collapsed = text.split(`${BACKSLASH}${BACKSLASH}`).join(BACKSLASH);
  return collapsed === text ? [text] : [text, collapsed];
}

export function findWindowsDrivePaths(text: string): string[] {
  return unique(textForms(text).flatMap((form) => matchAll(form, windowsDrivePathPattern)));
}

export function findUncPaths(text: string): string[] {
  return unique(textForms(text).flatMap((form) => matchAll(form, uncPathPattern)));
}

export function findPosixHomePaths(text: string): string[] {
  return unique(textForms(text).flatMap((form) => matchAll(form, posixHomePathPattern)));
}

export function findCloudSyncPaths(text: string): string[] {
  return unique(textForms(text).flatMap((form) => matchAll(form, cloudSyncPathPattern)));
}

export function findCustomerTokens(text: string): string[] {
  return unique(matchAll(text, customerTokenPattern).map((value) => value.toLowerCase()));
}

export function findOfficePayloadBase64(text: string): string[] {
  return unique(matchAll(text, base64OfficePayloadPattern));
}

export function findLiveDocumentFileTypes(relativePath: string): string[] {
  const extension = path.extname(relativePath).toLowerCase();
  return forbiddenFileExtensions.has(extension) ? [extension] : [];
}

export function findBinaryDocumentSignatures(buffer: Buffer): string[] {
  return binarySignatures
    .filter((signature) => buffer.length >= signature.bytes.length && signature.bytes.every((byte, index) => buffer[index] === byte))
    .map((signature) => signature.label);
}

export function findTranscriptPayloads(text: string): string[] {
  const findings: string[] = [];
  if (/^\uFEFF?WEBVTT/.test(text)) findings.push('file begins with WEBVTT');
  const cues = matchAll(text, vttCuePattern).length;
  if (cues >= vttCueThreshold) findings.push(`${cues} transcript cue timestamps`);
  return findings;
}

export function findEmailPayloads(text: string): string[] {
  const headers = unique(matchAll(text, emailHeaderPattern).map((value) => value.toLowerCase()));
  return headers.length >= emailHeaderThreshold ? [`${headers.length} RFC 822 headers at line start`] : [];
}

export function scanBoundaryContent(relativePath: string, buffer: Buffer): BoundaryFinding[] {
  const findings: BoundaryFinding[] = [];
  const push = (rule: BoundaryRule, matches: string[]) => {
    for (const match of matches) findings.push({ file: relativePath, rule, match });
  };
  push('live-document-file-type', findLiveDocumentFileTypes(relativePath));
  push('binary-document-signature', findBinaryDocumentSignatures(buffer));
  if (buffer.includes(0)) return findings; // binary: the text matchers would be noise
  const text = buffer.toString('utf8');
  push('windows-drive-path', findWindowsDrivePaths(text));
  push('unc-path', findUncPaths(text));
  push('posix-home-path', findPosixHomePaths(text));
  push('cloud-sync-path', findCloudSyncPaths(text));
  push('customer-token', findCustomerTokens(text));
  push('office-payload-base64', findOfficePayloadBase64(text));
  push('transcript-payload', findTranscriptPayloads(text));
  push('email-payload', findEmailPayloads(text));
  return findings;
}

function digestOf(finding: BoundaryFinding) {
  return createHash('sha256').update(finding.match).digest('hex').slice(0, 16);
}

/* ------------------------------------------------------------------------- *
 * Registers.
 *
 * Two of them, deliberately kept apart, because "allowed" and "not yet fixed"
 * are different statements, and collapsing them is how the original denylist
 * ended up meaning nothing.
 *
 * Matches are pinned by digest rather than by literal so that pinning a finding
 * does not itself commit the offending string. A DIFFERENT match in the same
 * file fails, so neither register can quietly absorb a new leak. Removing a
 * match is always safe — the assertion is a subset check.
 * ------------------------------------------------------------------------- */

interface RegisterEntry {
  file: string;
  rule: BoundaryRule;
  /** sha256(match).slice(0, 16). The failure message prints the digest of anything new. */
  digests: string[];
  /** Plain-language description of what the pinned match is. */
  describes: string;
  reason: string;
}

const customerTokenDigests = customerTokens.map((token) => createHash('sha256').update(token.toLowerCase()).digest('hex').slice(0, 16));

const POLICY_ALLOWED: RegisterEntry[] = [
  {
    file: 'AGENTS.md',
    rule: 'windows-drive-path',
    digests: ['c6ec6edd17bf5dba'],
    describes: 'the approved local data root named by the boundary policy',
    reason:
      'This is the policy anchor itself, not a machine-specific path. It names no user account, no customer and no project, and both AGENTS.md and docs/data-boundary.md state that the physical path must be confirmed before code relies on it. Removing it would make the policy unstatable.',
  },
  {
    file: 'docs/data-boundary.md',
    rule: 'windows-drive-path',
    digests: ['c6ec6edd17bf5dba'],
    describes: 'the approved local data root named by the boundary policy',
    reason: 'The same policy anchor as AGENTS.md; docs/data-boundary.md is where the data-zone table defines it. It identifies no user, customer or project.',
  },
  // Customer names in governance documents. docs/data-boundary.md states this
  // explicitly: "Project names mentioned in governance documents to define the
  // boundary are not test data and must not be expanded into project details."
  // The allowance is therefore narrow: these governance documents only, and
  // only for naming the boundary. Any occurrence in code, tests, fixtures,
  // migrations, config or public assets fails.
  ...['AGENTS.md', 'GOAL-CONTRACT.md', 'README.md', 'docs/MVP-BUILD-CONTRACT.md', 'docs/architecture.md', 'docs/data-boundary.md'].map((file) => ({
    file,
    rule: 'customer-token' as const,
    digests: customerTokenDigests,
    describes: 'live customer names used to define the forbidden zone',
    reason:
      'Permitted by docs/data-boundary.md, which sanctions naming projects in governance documents to define the boundary. Recommended but not required: README.md is the repository front door and loses nothing by saying "live customer projects" instead.',
  })),
];

// Empty, and it must stay that way: the two machine-specific paths that used to
// sit here were scrubbed from docs/sqlite-runtime.md during the repair.
const KNOWN_PRE_EXISTING_VIOLATIONS: RegisterEntry[] = [];

function isRegistered(finding: BoundaryFinding, register: RegisterEntry[]) {
  const digest = digestOf(finding);
  return register.some((entry) => entry.file === finding.file && entry.rule === finding.rule && entry.digests.includes(digest));
}

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 256 * 1024 * 1024 })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
}

function describeFindings(findings: BoundaryFinding[]) {
  return findings.map((finding) => `${finding.file} [${finding.rule}] digest=${digestOf(finding)} length=${finding.match.length}`);
}

describe('repository data boundary', () => {
  it('scans every tracked file and finds no unregistered live paths, customer names or document payloads', () => {
    const files = trackedFiles();
    expect(files.length).toBeGreaterThan(50);
    // The tree must actually be scanned, including the directories the previous
    // version never looked at.
    for (const required of ['AGENTS.md', 'README.md', 'docs/data-boundary.md', 'server.ts', 'src/projectLifecycle.ts', 'vite.config.ts']) {
      expect(files).toContain(required);
    }

    const findings = files.flatMap((file) => scanBoundaryContent(file, readFileSync(path.join(root, file))));
    const unregistered = findings.filter((finding) => !isRegistered(finding, POLICY_ALLOWED) && !isRegistered(finding, KNOWN_PRE_EXISTING_VIOLATIONS));
    expect(describeFindings(unregistered)).toEqual([]);
  });

  it('keeps both registers explicit, reasoned and separated', () => {
    for (const entry of [...POLICY_ALLOWED, ...KNOWN_PRE_EXISTING_VIOLATIONS]) {
      expect(entry.reason.length).toBeGreaterThan(40);
      expect(entry.digests.length).toBeGreaterThan(0);
      expect(entry.describes.length).toBeGreaterThan(10);
    }
    // Pending debt must say so, so it can never be read as an approval.
    expect(KNOWN_PRE_EXISTING_VIOLATIONS.every((entry) => entry.reason.includes('GENUINE VIOLATION'))).toBe(true);
    expect(POLICY_ALLOWED.some((entry) => entry.reason.includes('GENUINE VIOLATION'))).toBe(false);
  });
});

describe('data boundary matchers', () => {
  // Every row of the review's miss table, as an inline fixture. The strings are
  // assembled from parts so this test file never itself contains a live-looking
  // path, and the user/organisation names are synthetic.
  const B = BACKSLASH;
  const user = 'consultant';
  const org = 'ExampleOrg';
  const escapedWindowsPath = `"C:${B}${B}Users${B}${B}${user}${B}${B}OneDrive - ${org}${B}${B}Projects"`;
  const singleQuotedWindowsPath = `'C:${B}Users${B}${user}${B}Projects'`;
  const forwardSlashWindowsPath = `"${['C:', 'Users', user, 'Projects', 'Register'].join('/')}"`;
  const escapedUncPath = `"${B}${B}${B}${B}${org}${B}${B}Projects"`;
  const rawUncPath = `${B}${B}${org}${B}Projects`;
  const posixHomePath = ['', 'home', user, 'OneDrive', 'Projects'].join('/');
  const macHomePath = ['', 'Users', user, 'Library', 'CloudStorage'].join('/');
  const cloudSyncPath = `C:${B}Users${B}${user}${B}OneDrive - ${org}${B}Projects`;
  const macCloudSyncPath = ['', 'Users', user, 'Library', 'CloudStorage', `OneDrive-${org}`, 'Projects'].join('/');
  const registerFileName = `${customerTokens[0]}_Register_2026.xlsx`;

  it('catches Windows drive paths in escaped, single-quoted and forward-slash forms', () => {
    expect(findWindowsDrivePaths(escapedWindowsPath)).not.toEqual([]);
    expect(findWindowsDrivePaths(singleQuotedWindowsPath)).not.toEqual([]);
    expect(findWindowsDrivePaths(forwardSlashWindowsPath)).not.toEqual([]);
  });

  it('catches UNC paths in escaped and raw forms', () => {
    expect(findUncPaths(escapedUncPath)).not.toEqual([]);
    expect(findUncPaths(rawUncPath)).not.toEqual([]);
  });

  it('catches POSIX home paths on Linux and macOS', () => {
    expect(findPosixHomePaths(posixHomePath)).not.toEqual([]);
    expect(findPosixHomePaths(macHomePath)).not.toEqual([]);
  });

  it('catches cloud sync folder paths on both platforms', () => {
    expect(findCloudSyncPaths(cloudSyncPath)).not.toEqual([]);
    expect(findCloudSyncPaths(macCloudSyncPath)).not.toEqual([]);
    expect(findCloudSyncPaths(`SharePoint - ${org}${B}Shared Documents${B}`)).not.toEqual([]);
  });

  it('catches a customer token adjacent to underscores, digits and punctuation', () => {
    expect(findCustomerTokens(registerFileName)).not.toEqual([]);
    for (const token of customerTokens) {
      expect(findCustomerTokens(`${token}_Register_2026.xlsx`)).not.toEqual([]);
      expect(findCustomerTokens(`${token}-2026`)).not.toEqual([]);
      expect(findCustomerTokens(`prefix ${token}.`)).not.toEqual([]);
      expect(findCustomerTokens(token.toLowerCase())).not.toEqual([]);
    }
  });

  it('does not fire on letters merely embedded in ordinary words or escape sequences', () => {
    // `\nPlease` contains n, P, l — the shape a boundary-free matcher would
    // false-positive on, and which exists today in tests/sourceIntelligence.test.ts.
    expect(findCustomerTokens(`casey@example.invalid${B}nPlease confirm the route`)).toEqual([]);
    expect(findCustomerTokens('unploughed')).toEqual([]);
    expect(findWindowsDrivePaths('https://registry.npmjs.org/vite/-/vite-7.1.3.tgz')).toEqual([]);
    expect(findWindowsDrivePaths("connect-src 'self' ws:; img-src 'self' data:")).toEqual([]);
    expect(findCloudSyncPaths('Google Drive, OneDrive, SharePoint, Rocketlane and Dataverse are not implemented.')).toEqual([]);
    expect(findCloudSyncPaths("externalPath: 'OneDrive/Project Atlas/Readiness Pack.docx'")).toEqual([]);
    expect(findPosixHomePaths('see http://example.invalid/home/page')).toEqual([]);
  });

  it('catches live document file types and binary document signatures anywhere in the tree', () => {
    for (const name of ['fixtures/meeting.vtt', 'docs/thread.eml', 'docs/item.msg', 'fixtures/register.xlsx', 'a.pdf']) {
      expect(findLiveDocumentFileTypes(name)).not.toEqual([]);
    }
    expect(findLiveDocumentFileTypes('src/domain.ts')).toEqual([]);
    expect(findBinaryDocumentSignatures(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]))).not.toEqual([]);
    expect(findBinaryDocumentSignatures(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))).not.toEqual([]);
    expect(findBinaryDocumentSignatures(Buffer.from('%PDF-1.7\n'))).not.toEqual([]);
    expect(findBinaryDocumentSignatures(Buffer.from('{"schemaVersion":1}'))).toEqual([]);
    const workbookBase64 = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]), Buffer.alloc(64)]).toString('base64');
    expect(findOfficePayloadBase64(`{"dataBase64":"${workbookBase64}"}`)).not.toEqual([]);
    expect(findOfficePayloadBase64(Buffer.from('WEBVTT\n\nsynthetic', 'utf8').toString('base64'))).toEqual([]);
  });

  it('catches transcript and mailbox payloads by shape, not by whether they name a customer', () => {
    const cues = Array.from({ length: 20 }, (_, index) => `0${index}`.slice(-2))
      .map((seq) => `00:00:${seq}.000 --> 00:00:${seq}.900\nSpeaker ${seq}: line\n`)
      .join('\n');
    expect(findTranscriptPayloads(`WEBVTT\n\n${cues}`)).not.toEqual([]);
    expect(findTranscriptPayloads(cues)).not.toEqual([]);
    // The synthetic one- and two-cue fixtures this repository legitimately uses.
    expect(findTranscriptPayloads("const source = 'WEBVTT\\n\\n00:00:01.000 --> 00:00:02.000\\nAction: confirm'")).toEqual([]);
    const mail = ['Return-Path: <a@corp.example>', 'From: a@corp.example', 'To: b@corp.example', 'Subject: Register update', 'Date: Thu, 30 Jul 2026 09:00:00 +0000', '', 'Body.'].join('\n');
    expect(findEmailPayloads(mail)).not.toEqual([]);
    expect(findEmailPayloads("normalizeSource('message.eml', Buffer.from('From: casey@example.invalid\\nSubject: Release'))")).toEqual([]);
  });
});

describe('fixture and route boundary controls', () => {
  it('contains no external URLs in fixture data', () => {
    expect(JSON.stringify(fixtureJson)).not.toMatch(/https?:\/\//i);
  });

  it('validates all fixture records as fictional', () => {
    const fixture = portfolioFixtureSchema.parse(fixtureJson);
    const collections = fixture.projects.flatMap((project) => [project.projectSources, project.actions, project.risksIssues, project.changes, project.decisions, project.openQuestions, project.milestones, project.workPackages, project.activity, project.deliverables, project.aiWork, project.verifications, project.provenance]);
    expect(fixture.dataClassification).toBe('fictional');
    expect(collections.flat().every((record) => record.dataClassification === 'fictional')).toBe(true);
  });

  it('exposes only explicit approved POST command endpoints and no hard delete route', () => {
    const server = readFileSync(path.join(root, 'server.ts'), 'utf8');
    expect(server).not.toMatch(/app\.(put|patch|delete)\s*\(/i);
    expect(server).not.toMatch(/method:\s*['"]DELETE['"]/i);
    expect(server).toContain('/api/inbox/:graphId/delete');
    expect(server).toContain('moveMessageToDeletedItems');
  });

  it('keeps operational compatibility tables behind the single projection writer', () => {
    const intelligenceFiles = ['src/projectRegisters.ts', 'src/projectLifecycle.ts', 'src/sourceIntelligence.ts']
      .map((file) => path.join(root, file));
    const directWrite = /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE)\s+(?:actions|decisions|risks_issues|changes|open_questions|milestones|project_sources)\b/i;
    const findings = intelligenceFiles.filter((file) => directWrite.test(readFileSync(file, 'utf8')));
    expect(findings).toEqual([]);
    expect(readFileSync(path.join(root, 'src', 'registerProjection.ts'), 'utf8')).toMatch(directWrite);
  });

  it('does not track database artifacts, portable runtime, native sqlite dependencies, tokens, or tenant config', () => {
    const packageJson = readFileSync(path.join(root, 'package.json'), 'utf8');
    expect(packageJson).not.toMatch(/better-sqlite3|sqlite3|postgres|mysql|mongodb|prisma/i);
    const repositoryFiles = trackedFiles();
    expect(repositoryFiles.some((name) => /(^|[\\/])\.runtime([\\/]|$)/i.test(name))).toBe(false);
    expect(repositoryFiles.some((name) => /\.(db|sqlite|sqlite3|db-wal|db-shm|db-journal)$/i.test(name))).toBe(false);
    expect(repositoryFiles.some((name) => /m365-auth\.local\.json|token/i.test(name))).toBe(false);
    expect(repositoryFiles.some((name) => /(^|[\\/])config[\\/].*\.local\.json$/i.test(name))).toBe(false);
  });
});

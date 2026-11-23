import { HARNESS_MAX_MESSAGE_BYTES, sha256Hex } from "@mnemo-ai/types/harness-runtime";
import { isIP } from "node:net";

const REDACTED = "[REDACTED]";
const PEM_BEGIN = "-----BEGIN ";
const VISIBLE_ROLES = new Set(["user", "assistant"]);

export interface VisibleMessage {
  role: "user" | "assistant";
  content: string;
}

export interface NormalizedVisibleMessage {
  role: "user" | "assistant";
  content: string;
  contentHash: string;
  normalizationVersion: 1;
}

function isAsciiLetter(character: string | undefined): boolean {
  if (character === undefined) return false;
  const code = character.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isNameCharacter(character: string | undefined): boolean {
  if (character === undefined) return false;
  const code = character.charCodeAt(0);
  return (
    isAsciiLetter(character) ||
    (code >= 48 && code <= 57) ||
    character === "_" ||
    character === "." ||
    character === "-"
  );
}

function isInlineWhitespace(character: string | undefined): boolean {
  return character === " " || character === "\t";
}

function findClosingQuote(content: string, start: number, quote: string): number {
  for (let index = start; index < content.length; index += 1) {
    if (content[index] === "\\") {
      index += 1;
    } else if (content[index] === quote) {
      return index;
    }
  }
  return -1;
}

function lineIndentAt(content: string, index: number): number {
  let lineStart = index;
  while (lineStart > 0 && content[lineStart - 1] !== "\n") lineStart -= 1;

  let indent = 0;
  while (isInlineWhitespace(content[lineStart + indent])) indent += 1;
  return indent;
}

function consumeIndentedContinuations(
  content: string,
  start: number,
  parentIndent: number
): number {
  let cursor = start;
  while (cursor < content.length) {
    let lineStart = cursor;
    if (content[lineStart] === "\r") lineStart += 1;
    if (content[lineStart] !== "\n") break;
    lineStart += 1;

    let indent = 0;
    while (isInlineWhitespace(content[lineStart + indent])) indent += 1;
    if (indent <= parentIndent) break;

    cursor = lineStart + indent;
    while (cursor < content.length && content[cursor] !== "\r" && content[cursor] !== "\n") {
      cursor += 1;
    }
  }
  return cursor;
}

function isPemLabel(label: string): boolean {
  if (!label.endsWith("PRIVATE KEY")) return false;
  for (const character of label) {
    if (
      character !== " " &&
      !(character >= "A" && character <= "Z") &&
      !(character >= "0" && character <= "9")
    ) {
      return false;
    }
  }
  return true;
}

function redactPemBlocks(content: string): string {
  const output: string[] = [];
  let cursor = 0;

  while (cursor < content.length) {
    const begin = content.indexOf(PEM_BEGIN, cursor);
    if (begin === -1) break;

    const labelStart = begin + PEM_BEGIN.length;
    const headerEnd = content.indexOf("-----", labelStart);
    if (headerEnd === -1 || headerEnd - labelStart > 64) {
      output.push(content.slice(cursor, labelStart));
      cursor = labelStart;
      continue;
    }

    const label = content.slice(labelStart, headerEnd);
    if (!isPemLabel(label)) {
      output.push(content.slice(cursor, headerEnd + 5));
      cursor = headerEnd + 5;
      continue;
    }

    output.push(content.slice(cursor, begin), REDACTED);
    const endMarker = `-----END ${label}-----`;
    const end = content.indexOf(endMarker, headerEnd + 5);
    if (end === -1) return output.join("");
    cursor = end + endMarker.length;
  }

  output.push(content.slice(cursor));
  return output.join("");
}

function isUrlBoundary(character: string | undefined): boolean {
  return (
    character === undefined ||
    character === "/" ||
    character === "?" ||
    character === "#" ||
    character === '"' ||
    character === "<" ||
    character === ">" ||
    /\s/u.test(character)
  );
}

function isSchemeCharacter(character: string | undefined): boolean {
  if (character === undefined) return false;
  const code = character.charCodeAt(0);
  return (
    isAsciiLetter(character) ||
    (code >= 48 && code <= 57) ||
    character === "+" ||
    character === "." ||
    character === "-" ||
    character === "_"
  );
}

function isValidPort(port: string): boolean {
  return /^\d+$/.test(port) && Number(port) <= 65_535;
}

function isValidHost(hostPort: string): boolean {
  if (hostPort.startsWith("[")) {
    const closingBracket = hostPort.indexOf("]");
    if (closingBracket === -1) return false;
    const address = hostPort.slice(1, closingBracket);
    const suffix = hostPort.slice(closingBracket + 1);
    return (
      address !== "" &&
      isIP(address) === 6 &&
      (suffix === "" || (suffix.startsWith(":") && isValidPort(suffix.slice(1))))
    );
  }

  const colon = hostPort.lastIndexOf(":");
  const hasPort = colon !== -1;
  const hostname = hasPort ? hostPort.slice(0, colon) : hostPort;
  const port = hasPort ? hostPort.slice(colon + 1) : "";
  if (hostname === "" || (hasPort && !isValidPort(port))) return false;
  const labels = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
  return labels
    .split(".")
    .every(
      (label) =>
        label !== "" &&
        /^[A-Za-z0-9-]+$/.test(label) &&
        label[0] !== "-" &&
        label[label.length - 1] !== "-"
    );
}

function isLikelyStandaloneHost(authority: string): boolean {
  if (!isValidHost(authority)) return false;
  const hostname = authority.startsWith("[")
    ? authority
    : authority.slice(
        0,
        authority.lastIndexOf(":") === -1 ? undefined : authority.lastIndexOf(":")
      );
  return hostname === "localhost" || hostname.startsWith("[") || hostname.includes(".");
}

function isValidUserInfo(userInfo: string): boolean {
  if (userInfo === "") return false;
  for (let index = 0; index < userInfo.length; index += 1) {
    const character = userInfo[index] ?? "";
    if (/^[A-Za-z0-9\-._~!$&'()*+,;=:@]$/.test(character)) continue;
    if (character === "%" && /^[0-9A-Fa-f]{2}$/.test(userInfo.slice(index + 1, index + 3))) {
      index += 2;
      continue;
    }
    return false;
  }
  return true;
}

function redactUrlUserInfo(content: string): string {
  const output: string[] = [];
  let cursor = 0;

  while (cursor < content.length) {
    const separator = content.indexOf("://", cursor);
    if (separator === -1) break;

    let schemeStart = separator;
    while (schemeStart > cursor && isSchemeCharacter(content[schemeStart - 1])) schemeStart -= 1;
    const scheme = content.slice(schemeStart, separator);
    if (!/^[A-Za-z][A-Za-z0-9+.-]*$/.test(scheme)) {
      output.push(content.slice(cursor, separator + 3));
      cursor = separator + 3;
      continue;
    }

    const authorityStart = separator + 3;
    let authorityEnd = authorityStart;
    while (!isUrlBoundary(content[authorityEnd])) {
      authorityEnd += 1;
    }

    while (content[authorityEnd - 1] === ")" || content[authorityEnd - 1] === "}") {
      authorityEnd -= 1;
    }
    let candidate = content.slice(authorityStart, authorityEnd);
    const bracketAt = candidate.lastIndexOf("@");
    if (candidate.endsWith("]")) {
      const host = candidate.slice(bracketAt + 1);
      const closesIpv6Host = host.startsWith("[") && host.indexOf("]") === host.length - 1;
      if (!closesIpv6Host) {
        authorityEnd -= 1;
        candidate = content.slice(authorityStart, authorityEnd);
      }
    }

    const hostComma = candidate.indexOf(",", candidate.lastIndexOf("@") + 1);
    if (hostComma !== -1) {
      authorityEnd = authorityStart + hostComma;
      candidate = content.slice(authorityStart, authorityEnd);
    }
    const host = candidate.slice(candidate.lastIndexOf("@") + 1);
    if (/\:\d+\.$/.test(host)) {
      authorityEnd -= 1;
      candidate = content.slice(authorityStart, authorityEnd);
    }

    const comma = candidate.indexOf(",");
    const finalAtOffset = candidate.lastIndexOf("@");
    if (comma !== -1 && comma < finalAtOffset) {
      // Comma-userinfo and CSV are grammar-ambiguous; a complete network-looking
      // authority before the comma wins, otherwise the comma remains userinfo.
      const credentialColon = candidate.indexOf(":");
      const commaBelongsToCredentials =
        credentialColon > comma || !isLikelyStandaloneHost(candidate.slice(0, comma));
      if (!commaBelongsToCredentials) authorityEnd = authorityStart + comma;
    }

    const authority = content.slice(authorityStart, authorityEnd);
    const finalAt = authority.lastIndexOf("@");
    if (
      finalAt < 0 ||
      !isValidUserInfo(authority.slice(0, finalAt)) ||
      !isValidHost(authority.slice(finalAt + 1))
    ) {
      output.push(content.slice(cursor, authorityEnd));
      cursor = authorityEnd;
      continue;
    }

    output.push(content.slice(cursor, authorityStart), REDACTED, "@", authority.slice(finalAt + 1));
    cursor = authorityEnd;
  }

  output.push(content.slice(cursor));
  return output.join("");
}

function isAuthorizationBoundary(character: string | undefined): boolean {
  return (
    character === undefined ||
    character === ";" ||
    character === "," ||
    character === "}" ||
    character === "]" ||
    character === "\r" ||
    character === "\n"
  );
}

function redactAuthorization(content: string): string {
  const lower = content.toLowerCase();
  const output: string[] = [];
  let cursor = 0;

  while (cursor < content.length) {
    const nameStart = lower.indexOf("authorization", cursor);
    if (nameStart === -1) break;
    const nameEnd = nameStart + "authorization".length;
    if (isNameCharacter(content[nameStart - 1]) || isNameCharacter(content[nameEnd])) {
      output.push(content.slice(cursor, nameEnd));
      cursor = nameEnd;
      continue;
    }

    let index = nameEnd;
    while (isInlineWhitespace(content[index])) index += 1;
    if (content[index] === '"' || content[index] === "'") index += 1;
    while (isInlineWhitespace(content[index])) index += 1;
    if (content[index] !== ":") {
      output.push(content.slice(cursor, nameEnd));
      cursor = nameEnd;
      continue;
    }

    index += 1;
    while (isInlineWhitespace(content[index])) index += 1;
    const quote = content[index] === '"' || content[index] === "'" ? content[index] : undefined;
    if (quote !== undefined) index += 1;
    output.push(content.slice(cursor, index), REDACTED);

    if (quote !== undefined) {
      const closingQuote = findClosingQuote(content, index, quote);
      if (closingQuote === -1) return output.join("");
      cursor = closingQuote;
    } else {
      const schemeLength = lower.startsWith("basic", index)
        ? 5
        : lower.startsWith("bearer", index)
          ? 6
          : 0;
      cursor = index + schemeLength;
      if (schemeLength > 0 && isInlineWhitespace(content[cursor])) {
        while (isInlineWhitespace(content[cursor])) cursor += 1;
        while (!isAuthorizationBoundary(content[cursor]) && !isInlineWhitespace(content[cursor])) {
          cursor += 1;
        }
        cursor = consumeIndentedContinuations(content, cursor, lineIndentAt(content, nameStart));
      } else {
        cursor = index;
        while (!isAuthorizationBoundary(content[cursor])) cursor += 1;
        cursor = consumeIndentedContinuations(content, cursor, lineIndentAt(content, nameStart));
      }
    }
  }

  output.push(content.slice(cursor));
  return output.join("");
}

function tokenizeName(name: string): string[] {
  const tokens: string[] = [];
  let token = "";

  for (let index = 0; index < name.length; index += 1) {
    const character = name[index] ?? "";
    if (character === "_" || character === "." || character === "-") {
      if (token !== "") tokens.push(token);
      token = "";
      continue;
    }

    const previous = name[index - 1];
    const next = name[index + 1];
    const startsCamelToken =
      character >= "A" &&
      character <= "Z" &&
      token !== "" &&
      ((previous !== undefined && previous >= "a" && previous <= "z") ||
        (next !== undefined &&
          next >= "a" &&
          next <= "z" &&
          previous !== undefined &&
          previous >= "A" &&
          previous <= "Z"));
    if (startsCamelToken) {
      tokens.push(token);
      token = "";
    }
    token += character.toLowerCase();
  }

  if (token !== "") tokens.push(token);
  return tokens;
}

function isSecretName(name: string): boolean {
  const tokens = tokenizeName(name);
  return (
    tokens.some(
      (token) =>
        token === "secret" || token === "token" || token === "password" || token === "privatekey"
    ) ||
    tokens.some((token, index) => token === "private" && tokens[index + 1] === "key") ||
    ((tokens[tokens.length - 2] === "api" || tokens[tokens.length - 2] === "access") &&
      tokens[tokens.length - 1] === "key") ||
    tokens[tokens.length - 1] === "credential"
  );
}

function findStructuredAssignment(content: string, start: number): number {
  let index = start;
  while (isInlineWhitespace(content[index])) index += 1;
  if (!isAsciiLetter(content[index]) && content[index] !== "_") return -1;
  while (isNameCharacter(content[index])) index += 1;
  while (isInlineWhitespace(content[index])) index += 1;
  return content[index] === "=" || content[index] === ":" ? start : -1;
}

function redactSecretAssignments(content: string): string {
  const output: string[] = [];
  let cursor = 0;
  let index = 0;

  while (index < content.length) {
    if (!isAsciiLetter(content[index]) && content[index] !== "_") {
      index += 1;
      continue;
    }

    const nameStart = index;
    while (isNameCharacter(content[index])) index += 1;
    const name = content.slice(nameStart, index);
    if (!isSecretName(name)) continue;

    const keyQuote =
      content[nameStart - 1] === '"' || content[nameStart - 1] === "'"
        ? content[nameStart - 1]
        : undefined;
    const quotedKey = keyQuote !== undefined && content[index] === keyQuote;
    let separator = quotedKey ? index + 1 : index;
    while (isInlineWhitespace(content[separator])) separator += 1;
    if (content[separator] !== "=" && content[separator] !== ":") continue;
    const assignmentSeparator = content[separator];
    separator += 1;
    while (isInlineWhitespace(content[separator])) separator += 1;

    const quote =
      content[separator] === '"' || content[separator] === "'" ? content[separator] : undefined;
    const preserveValueQuotes = quotedKey && quote !== undefined;
    output.push(content.slice(cursor, preserveValueQuotes ? separator + 1 : separator), REDACTED);
    if (quote !== undefined) {
      const closingQuote = findClosingQuote(content, separator + 1, quote);
      if (closingQuote === -1) return output.join("");
      cursor = closingQuote + (preserveValueQuotes ? 0 : 1);
    } else {
      cursor = separator;
      const consumeLineScalar =
        assignmentSeparator === ":" || tokenizeName(name).includes("password");
      while (
        cursor < content.length &&
        content[cursor] !== "\r" &&
        content[cursor] !== "\n" &&
        content[cursor] !== "," &&
        content[cursor] !== ";" &&
        content[cursor] !== "}" &&
        content[cursor] !== "]" &&
        (consumeLineScalar || !isInlineWhitespace(content[cursor]))
      ) {
        if (
          consumeLineScalar &&
          isInlineWhitespace(content[cursor]) &&
          findStructuredAssignment(content, cursor) !== -1
        ) {
          break;
        }
        cursor += 1;
      }
      if (content[cursor] === "\r" || content[cursor] === "\n") {
        cursor = consumeIndentedContinuations(content, cursor, lineIndentAt(content, nameStart));
      }
    }
    index = cursor;
  }

  output.push(content.slice(cursor));
  return output.join("");
}

function redactSecrets(content: string): string {
  // The last rule catches a secret said in prose, which has no `=` or `:` for
  // the assignment rule to find: "my password is X", "mi contraseña es X" (APP-033).
  return redactSecretAssignments(redactAuthorization(redactUrlUserInfo(redactPemBlocks(content))))
    .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(
      /\b(?:mns_(?:live|test)|mk_(?:live|test|admin|sess|fed))_[A-Za-z0-9_-]{16,}\b/gi,
      REDACTED
    )
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/gi, REDACTED)
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{10,})\b/gi, REDACTED)
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTED)
    .replace(
      /\b((?:password|passphrase|passwd|secret|token|api[ _-]?key|access[ _-]?key|contrase[ñn]a|clave|secreto)\s+(?:is|was|es|era)\s+)("[^"\n]*"|[^\s,;]+)/giu,
      `$1${REDACTED}`
    );
}

function utf8Prefix(value: string, maxBytes: number): string {
  let bytes = 0;
  const characters: string[] = [];
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    bytes += characterBytes;
    characters.push(character);
  }
  return characters.join("");
}

export interface SanitizeMessageOptions {
  truncate?: boolean;
}

export function splitUtf8Chunks(
  value: string,
  maxBytes: number = HARNESS_MAX_MESSAGE_BYTES
): string[] {
  if (maxBytes <= 0) {
    throw new RangeError("maxBytes must be positive");
  }
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return [value];
  }
  const chunks: string[] = [];
  let currentChars: string[] = [];
  let currentBytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (currentBytes + characterBytes > maxBytes && currentChars.length > 0) {
      chunks.push(currentChars.join(""));
      currentChars = [];
      currentBytes = 0;
    }
    currentChars.push(character);
    currentBytes += characterBytes;
  }
  if (currentChars.length > 0) {
    chunks.push(currentChars.join(""));
  }
  return chunks;
}

export function sanitizeMessage(content: string, options: SanitizeMessageOptions = {}): string {
  const originalBytes = Buffer.byteLength(content, "utf8");
  const sanitized = redactSecrets(content);
  if (options.truncate === false) return sanitized;
  if (Buffer.byteLength(sanitized, "utf8") <= HARNESS_MAX_MESSAGE_BYTES) return sanitized;

  const marker = `\n[TRUNCATED: original UTF-8 bytes=${originalBytes}]`;
  const contentBudget = HARNESS_MAX_MESSAGE_BYTES - Buffer.byteLength(marker, "utf8");
  return `${utf8Prefix(sanitized, contentBudget)}${marker}`;
}

export function normalizeVisibleMessage(
  message: VisibleMessage,
  options: SanitizeMessageOptions = {}
): NormalizedVisibleMessage {
  if (!VISIBLE_ROLES.has(message.role)) {
    throw new TypeError(`Unsupported visible message role: ${message.role}`);
  }

  const content = sanitizeMessage(message.content, options);
  return {
    role: message.role,
    content,
    contentHash: sha256Hex(content),
    normalizationVersion: 1,
  };
}

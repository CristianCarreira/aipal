const fs = require('node:fs');
const path = require('path');

function chunkText(text, size) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtmlAttr(value) {
  return escapeHtml(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function sanitizeUrl(value) {
  const url = String(value || '').trim();
  if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('tg://')) {
    return url;
  }
  return '';
}

function chunkMarkdown(text, size) {
  const chunks = [];
  if (!text) return chunks;
  const lines = String(text).split(/\r?\n/);
  let current = '';
  let inCodeFence = false;
  for (const line of lines) {
    const isFence = line.trim().startsWith('```');
    const closingFence = isFence && inCodeFence;
    const next = current ? `${current}\n${line}` : line;
    if (current && next.length > size && !inCodeFence) {
      chunks.push(current);
      current = line;
    } else if (current && next.length > size && closingFence) {
      current = next;
    } else if (current && next.length > size) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
    if (isFence) inCodeFence = !inCodeFence;
  }
  if (current) chunks.push(current);
  return chunks;
}

function markdownToTelegramHtml(value) {
  if (!value) return '';
  let text = String(value);
  const codeBlocks = [];
  const inlineCodes = [];
  const links = [];

  text = text.replace(/```[^\n]*\n([\s\S]*?)```/g, (_match, code) => {
    const token = `@@CODEBLOCK${codeBlocks.length}@@`;
    codeBlocks.push(code);
    return token;
  });

  text = text.replace(/`([^`\n]+)`/g, (_match, code) => {
    const token = `@@INLINECODE${inlineCodes.length}@@`;
    inlineCodes.push(code);
    return token;
  });

  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label, url) => {
    const safeUrl = sanitizeUrl(url);
    if (!safeUrl) return match;
    const token = `@@LINK${links.length}@@`;
    links.push({ label, url: safeUrl });
    return token;
  });

  text = escapeHtml(text);

  text = text.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');
  text = text.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  text = text.replace(/__([^_]+)__/g, '<b>$1</b>');
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>');
  text = text.replace(/(^|[^_])_([^_\n]+)_/g, '$1<i>$2</i>');
  text = text.replace(/~~([^~]+)~~/g, '<s>$1</s>');
  text = text.replace(/^\s*[-*]\s+/gm, '• ');

  text = text.replace(/@@LINK(\d+)@@/g, (_match, index) => {
    const entry = links[Number(index)];
    if (!entry) return '';
    const label = escapeHtml(entry.label);
    const href = escapeHtmlAttr(entry.url);
    return `<a href="${href}">${label}</a>`;
  });

  text = text.replace(/@@INLINECODE(\d+)@@/g, (_match, index) => {
    const code = inlineCodes[Number(index)] || '';
    return `<code>${escapeHtml(code)}</code>`;
  });

  text = text.replace(/@@CODEBLOCK(\d+)@@/g, (_match, index) => {
    const code = codeBlocks[Number(index)] || '';
    return `<pre><code>${escapeHtml(code)}</code></pre>`;
  });

  return balanceTelegramHtml(text);
}

// Telegram requires strictly nested entities. Our markdown regexes convert
// emphasis independently, so overlapping/stray markers (e.g. `_a **b_ c**`,
// file globs, a chunk split mid-tag) can yield malformed HTML like
// `<i>..<b>..</i></b>`, which Telegram rejects with
// "can't parse entities: Unmatched end tag". This re-nests the supported
// inline tags: closers are matched LIFO, premature closes re-open the tags
// they cut across, orphan closers are dropped, and unclosed tags are closed
// at the end.
const TELEGRAM_TAGS = new Set(['b', 'i', 's', 'u', 'code', 'pre', 'a']);

function balanceTelegramHtml(html) {
  if (!html) return html;
  const tagRegex = /<(\/?)([a-z]+)(\s[^>]*)?>/gi;
  const stack = [];
  let out = '';
  let lastIndex = 0;
  let match = tagRegex.exec(html);
  while (match !== null) {
    const [full, slash, rawName] = match;
    const name = rawName.toLowerCase();
    out += html.slice(lastIndex, match.index);
    lastIndex = match.index + full.length;
    if (!TELEGRAM_TAGS.has(name)) {
      out += full;
    } else if (!slash) {
      stack.push({ name, openTag: full });
      out += full;
    } else {
      const depth = stack.map((entry) => entry.name).lastIndexOf(name);
      if (depth === -1) {
        // Orphan closing tag — drop it.
      } else {
        const reopen = [];
        for (let i = stack.length - 1; i > depth; i -= 1) {
          out += `</${stack[i].name}>`;
          reopen.unshift(stack[i]);
        }
        out += `</${name}>`;
        stack.splice(depth);
        for (const entry of reopen) {
          out += entry.openTag;
          stack.push(entry);
        }
      }
    }
    match = tagRegex.exec(html);
  }
  out += html.slice(lastIndex);
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    out += `</${stack[i].name}>`;
  }
  return out;
}

function formatError(err) {
  if (!err) return 'Unknown error';
  const parts = [];
  if (err.message) parts.push(err.message);
  if (err.code) parts.push(`code: ${err.code}`);
  if (err.stderr) parts.push(`stderr: ${String(err.stderr).trim()}`);
  const message = parts.filter(Boolean).join('\n');
  return message || String(err);
}

function parseSlashCommand(text) {
  if (!text) return null;
  const match = text.match(/^\/([A-Za-z0-9_-]+)(?:@[\w_]+)?(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return {
    name: match[1],
    args: (match[2] || '').trim(),
  };
}

function extractCommandValue(text) {
  if (!text) return '';
  return text.replace(/^\/\w+(?:@\w+)?\s*/i, '').trim();
}

function extensionFromMime(mimeType) {
  if (!mimeType) return '';
  const normalized = mimeType.toLowerCase();
  if (normalized === 'audio/ogg') return '.ogg';
  if (normalized === 'audio/mpeg') return '.mp3';
  if (normalized === 'audio/mp4') return '.m4a';
  if (normalized === 'audio/x-m4a') return '.m4a';
  if (normalized === 'image/jpeg') return '.jpg';
  if (normalized === 'image/jpg') return '.jpg';
  if (normalized === 'image/png') return '.png';
  if (normalized === 'image/webp') return '.webp';
  if (normalized === 'image/gif') return '.gif';
  return '';
}

function extensionFromUrl(url) {
  try {
    const ext = path.extname(new URL(url).pathname);
    return ext || '';
  } catch {
    return '';
  }
}

function getAudioPayload(message) {
  if (!message) return null;
  if (message.voice) {
    return {
      kind: 'voice',
      fileId: message.voice.file_id,
      mimeType: message.voice.mime_type || '',
      fileName: '',
    };
  }
  if (message.audio) {
    return {
      kind: 'audio',
      fileId: message.audio.file_id,
      mimeType: message.audio.mime_type || '',
      fileName: message.audio.file_name || '',
    };
  }
  if (message.document && String(message.document.mime_type || '').startsWith('audio/')) {
    return {
      kind: 'document',
      fileId: message.document.file_id,
      mimeType: message.document.mime_type || '',
      fileName: message.document.file_name || '',
    };
  }
  return null;
}

function getImagePayload(message) {
  if (!message) return null;
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const best = message.photo[message.photo.length - 1];
    return {
      kind: 'photo',
      fileId: best.file_id,
      mimeType: 'image/jpeg',
      fileName: '',
    };
  }
  if (message.document && String(message.document.mime_type || '').startsWith('image/')) {
    return {
      kind: 'document',
      fileId: message.document.file_id,
      mimeType: message.document.mime_type || '',
      fileName: message.document.file_name || '',
    };
  }
  return null;
}

function getDocumentPayload(message) {
  if (!message || !message.document) return null;
  return {
    kind: 'document',
    fileId: message.document.file_id,
    mimeType: message.document.mime_type || '',
    fileName: message.document.file_name || '',
  };
}

function resolvePathSafely(targetPath) {
  if (!targetPath) return '';
  try {
    return fs.realpathSync.native(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

function isPathInside(baseDir, candidatePath) {
  if (!baseDir || !candidatePath) return false;
  const base = resolvePathSafely(baseDir);
  const target = resolvePathSafely(candidatePath);
  if (!base || !target) return false;
  if (base === target) return true;
  return target.startsWith(base + path.sep);
}

function extractImageTokens(text, imageDir) {
  const imagePaths = [];
  const tokenRegex = /\[\[image:([^\]]+)\]\]/g;
  let match = tokenRegex.exec(text);
  while (match !== null) {
    const raw = (match[1] || '').trim();
    if (!raw) continue;
    const normalized = raw.replace(/^file:\/\//, '');
    const resolved = path.isAbsolute(normalized) ? normalized : path.join(imageDir, normalized);
    if (isPathInside(imageDir, resolved)) {
      imagePaths.push(resolved);
    } else {
      console.warn('Ignoring image path outside IMAGE_DIR:', resolved);
    }
    match = tokenRegex.exec(text);
  }
  const cleanedText = text.replace(tokenRegex, '').trim();
  return { cleanedText, imagePaths };
}

function extractDocumentTokens(text, documentDir) {
  const documentPaths = [];
  const tokenRegex = /\[\[(document|file):([^\]]+)\]\]/g;
  let match = tokenRegex.exec(text);
  while (match !== null) {
    const raw = (match[2] || '').trim();
    if (!raw) continue;
    const normalized = raw.replace(/^file:\/\//, '');
    const resolved = path.isAbsolute(normalized)
      ? normalized
      : path.join(documentDir, normalized);
    if (isPathInside(documentDir, resolved)) {
      documentPaths.push(resolved);
    } else {
      console.warn('Ignoring document path outside DOCUMENT_DIR:', resolved);
    }
    match = tokenRegex.exec(text);
  }
  const cleanedText = text.replace(tokenRegex, '').trim();
  return { cleanedText, documentPaths };
}

function buildPrompt(
  prompt,
  imagePaths = [],
  imageDir,
  scriptContext,
  documentPaths = [],
  documentDir,
  options = {}
) {
  const includeFileInstructions = options.includeFileInstructions !== false;
  const includeStyleInstructions = options.includeStyleInstructions !== false;
  const lines = [];
  if (includeStyleInstructions) {
    lines.push(
      'Reply with only the final answer. No reasoning or planning steps.'
    );
  }
  const context = (scriptContext || '').trim();
  if (context) {
    lines.push('Context from last slash command output:');
    lines.push(context);
    lines.push('End of slash command output.');
  }
  const trimmed = (prompt || '').trim();
  if (trimmed) lines.push(trimmed);
  if (imagePaths.length > 0) {
    lines.push('User sent image file(s):');
    for (const imagePath of imagePaths) {
      lines.push(`- ${imagePath}`);
    }
    lines.push('Read images from those paths if needed.');
  }
  if (documentPaths.length > 0) {
    lines.push('User sent document file(s):');
    for (const documentPath of documentPaths) {
      lines.push(`- ${documentPath}`);
    }
    lines.push('Read documents from those paths if needed.');
  }
  if (includeFileInstructions) {
    lines.push(
      `Images: save under ${imageDir}, reply [[image:/path]]. Documents: save under ${documentDir || imageDir}, reply [[document:/path]].`
    );
  }
  return lines.join('\n');
}

module.exports = {
  chunkText,
  chunkMarkdown,
  markdownToTelegramHtml,
  balanceTelegramHtml,
  formatError,
  parseSlashCommand,
  extractCommandValue,
  extensionFromMime,
  extensionFromUrl,
  getAudioPayload,
  getImagePayload,
  getDocumentPayload,
  isPathInside,
  extractImageTokens,
  extractDocumentTokens,
  buildPrompt,
};

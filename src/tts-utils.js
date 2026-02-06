function normalizeTextForTts(text) {
  return String(text || '')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/_([^_\n]+)_/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTtsBackend(value) {
  const raw = String(value || 'say').trim().toLowerCase();
  if (raw === 'auto' || raw === 'chatterbox' || raw === 'say') {
    return raw;
  }
  return 'say';
}

function preferredTtsBackends(value) {
  const backend = normalizeTtsBackend(value);
  if (backend === 'auto') return ['chatterbox', 'say'];
  if (backend === 'chatterbox') return ['chatterbox', 'say'];
  return ['say'];
}

module.exports = {
  normalizeTextForTts,
  normalizeTtsBackend,
  preferredTtsBackends,
};

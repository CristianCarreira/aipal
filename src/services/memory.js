const COMPACT_BOOTSTRAP_MAX_CHARS = 500;

function truncateForCompact(text, maxChars) {
  const trimmed = String(text || '').trim();
  if (!trimmed || trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars - 1)}\u2026`;
}

function createMemoryService(options) {
  const {
    appendMemoryEvent,
    buildThreadBootstrap,
    configPath,
    curateMemory,
    documentDir,
    extractDocumentTokens,
    extractImageTokens,
    imageDir,
    memoryCaptureMaxChars,
    memoryCurateEvery,
    memoryPath,
    persistMemory,
    readMemory,
    readSoul,
    readTools,
    soulPath,
    toolsPath,
    getMemoryEventsSinceCurate,
    setMemoryEventsSinceCurate,
  } = options;

  function extractMemoryText(response) {
    const { cleanedText: withoutImages } = extractImageTokens(response || '', imageDir);
    const { cleanedText } = extractDocumentTokens(withoutImages, documentDir);
    let text = String(cleanedText || '').trim();
    if (memoryCaptureMaxChars > 0 && text.length > memoryCaptureMaxChars) {
      text = `${text.slice(0, memoryCaptureMaxChars - 1)}\u2026`;
    }
    return text;
  }

  function maybeAutoCurateMemory() {
    const nextCount = getMemoryEventsSinceCurate() + 1;
    setMemoryEventsSinceCurate(nextCount);
    if (nextCount < memoryCurateEvery) return;
    setMemoryEventsSinceCurate(0);

    persistMemory(async () => {
      try {
        const result = await curateMemory();
        console.info(
          `Auto-curated memory events=${result.eventsProcessed} bytes=${result.bytes}`
        );
      } catch (err) {
        console.warn('Auto memory curation failed:', err);
      }
    }).catch((err) => {
      console.warn('Failed to schedule auto memory curation:', err);
    });
  }

  async function captureMemoryEvent(event) {
    try {
      await appendMemoryEvent(event);
      maybeAutoCurateMemory();
    } catch (err) {
      console.warn('Failed to append memory event:', err);
    }
  }

  async function buildBootstrapContext(contextOptions = {}) {
    const { threadKey, compact } = contextOptions;
    const soul = await readSoul();
    const tools = await readTools();
    const memory = await readMemory();
    const lines = [];
    if (soul.exists && soul.content) {
      const content = compact
        ? truncateForCompact(soul.content, COMPACT_BOOTSTRAP_MAX_CHARS)
        : soul.content;
      lines.push('[SOUL]');
      lines.push(content);
      lines.push('[/SOUL]');
    }
    if (tools.exists && tools.content) {
      const content = compact
        ? truncateForCompact(tools.content, COMPACT_BOOTSTRAP_MAX_CHARS)
        : tools.content;
      lines.push('[TOOLS]');
      lines.push(content);
      lines.push('[/TOOLS]');
    }
    if (memory.exists && memory.content) {
      lines.push('[MEMORY]');
      lines.push(memory.content);
      lines.push('[/MEMORY]');
    }
    if (threadKey) {
      const threadBootstrap = await buildThreadBootstrap(threadKey);
      if (threadBootstrap) {
        lines.push(threadBootstrap);
      }
    }
    return lines.join('\n');
  }

  return {
    buildBootstrapContext,
    captureMemoryEvent,
    extractMemoryText,
  };
}

module.exports = {
  createMemoryService,
};

const RETRIEVAL_CACHE_TTL_MS = 60000;

function createAgentRunner(options) {
  const {
    agentMaxBuffer,
    agentTimeoutMs,
    buildBootstrapContext,
    buildMemoryRetrievalContext,
    buildPrompt,
    documentDir,
    execLocal,
    fileInstructionsEvery,
    getAgent,
    getAgentLabel,
    getGlobalAgent,
    getGlobalModels,
    getGlobalThinking,
    getThreads,
    imageDir,
    memoryRetrievalLimit,
    persistThreads,
    prefixTextWithTimestamp,
    resolveEffectiveAgentId,
    resolveThreadId,
    threadRotationTurns,
    threadTurns,
    wrapCommandWithPty,
    defaultTimeZone,
    onTokenUsage,
  } = options;

  const retrievalCache = new Map();
  const threadContextChars = new Map();

  function getCachedRetrieval(key) {
    const entry = retrievalCache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.ts > RETRIEVAL_CACHE_TTL_MS) {
      retrievalCache.delete(key);
      return undefined;
    }
    return entry.value;
  }

  function setCachedRetrieval(key, value) {
    retrievalCache.set(key, { ts: Date.now(), value });
    // Evict stale entries periodically (keep map bounded)
    if (retrievalCache.size > 100) {
      const now = Date.now();
      for (const [k, v] of retrievalCache) {
        if (now - v.ts > RETRIEVAL_CACHE_TTL_MS) retrievalCache.delete(k);
      }
    }
  }

  async function runAgentOneShot(prompt) {
    const globalAgent = getGlobalAgent();
    const agent = getAgent(globalAgent);
    const thinking = getGlobalThinking();
    let promptText = String(prompt || '');
    if (agent.id === 'claude') {
      promptText = prefixTextWithTimestamp(promptText, {
        timeZone: defaultTimeZone,
      });
    }
    const promptExpression = '"$AIPAL_PROMPT"';
    const agentCmd = agent.buildCommand({
      prompt: promptText,
      promptExpression,
      threadId: undefined,
      thinking,
    });

    let commandToRun = agentCmd;
    const execEnv = { ...process.env, AIPAL_PROMPT: promptText };
    if (agent.needsPty) {
      execEnv.AIPAL_CMD = commandToRun;
      commandToRun = wrapCommandWithPty(commandToRun, 'AIPAL_CMD');
    }
    if (agent.mergeStderr) {
      commandToRun = `${commandToRun} 2>&1`;
    }

    if (onTokenUsage) {
      const inputTokens = Math.ceil(promptText.length / 4);
      onTokenUsage({ chatId: 'oneshot', inputTokens, outputTokens: 0, source: 'oneshot' });
    }

    const startedAt = Date.now();
    console.info(`Agent one-shot start agent=${getAgentLabel(globalAgent)}`);
    let output;
    let execError;
    try {
      output = await execLocal('bash', ['-lc', commandToRun], {
        timeout: agentTimeoutMs,
        maxBuffer: agentMaxBuffer,
        env: execEnv,
      });
    } catch (err) {
      execError = err;
      if (err && typeof err.stdout === 'string' && err.stdout.trim()) {
        output = err.stdout;
      } else {
        throw err;
      }
    } finally {
      const elapsedMs = Date.now() - startedAt;
      console.info(`Agent one-shot finished durationMs=${elapsedMs}`);
    }

    const parsed = agent.parseOutput(output);
    if (execError && !parsed.sawJson && !String(parsed.text || '').trim()) {
      throw execError;
    }
    if (execError) {
      console.warn(
        `Agent one-shot exited non-zero; returning stdout (code=${execError.code || 'unknown'})`
      );
    }
    if (onTokenUsage) {
      const outputTokens = Math.ceil((parsed.text || output || '').length / 4);
      onTokenUsage({ chatId: 'oneshot', inputTokens: 0, outputTokens, source: 'oneshot' });
    }
    return parsed.text || output;
  }

  async function runAgentForChat(chatId, prompt, runOptions = {}) {
    const { topicId, agentId: overrideAgentId, imagePaths, scriptContext, documentPaths, source: runSource } =
      runOptions;
    const source = runSource || 'chat';
    const effectiveAgentId = resolveEffectiveAgentId(
      chatId,
      topicId,
      overrideAgentId
    );
    const agent = getAgent(effectiveAgentId);

    const threads = getThreads();
    let { threadKey, threadId, migrated } = resolveThreadId(
      threads,
      chatId,
      topicId,
      effectiveAgentId
    );
    const turnCount = (threadTurns.get(threadKey) || 0) + 1;
    threadTurns.set(threadKey, turnCount);

    let isRotation = false;
    if (threadRotationTurns > 0 && threadId && turnCount >= threadRotationTurns) {
      console.info(
        `Thread rotation: resetting thread chat=${chatId} topic=${topicId || 'root'} turns=${turnCount}`
      );
      threads.delete(threadKey);
      threadTurns.set(threadKey, 1);
      threadContextChars.delete(threadKey);
      threadId = undefined;
      isRotation = true;
      persistThreads().catch((err) =>
        console.warn('Failed to persist threads after rotation:', err)
      );
    }

    const shouldIncludeFileInstructions =
      !threadId || turnCount % fileInstructionsEvery === 0;
    if (migrated) {
      persistThreads().catch((err) =>
        console.warn('Failed to persist migrated threads:', err)
      );
    }

    let promptWithContext = prompt;
    if (agent.id === 'claude') {
      promptWithContext = prefixTextWithTimestamp(promptWithContext, {
        timeZone: defaultTimeZone,
      });
    }
    if (!threadId) {
      const bootstrap = await buildBootstrapContext({ threadKey, compact: isRotation });
      promptWithContext = promptWithContext
        ? `${bootstrap}\n\n${promptWithContext}`
        : bootstrap;
    }
    if (prompt.trim().length >= 6) {
      const cacheKey = `${chatId}:${topicId || ''}:${prompt.trim().slice(0, 200)}`;
      let retrievalContext = getCachedRetrieval(cacheKey);
      if (retrievalContext === undefined) {
        retrievalContext = await buildMemoryRetrievalContext({
          query: prompt,
          chatId,
          topicId,
          agentId: effectiveAgentId,
          limit: memoryRetrievalLimit,
        });
        setCachedRetrieval(cacheKey, retrievalContext || '');
      }
      if (retrievalContext) {
        promptWithContext = promptWithContext
          ? `${promptWithContext}\n\n${retrievalContext}`
          : retrievalContext;
      }
    }

    const thinking = getGlobalThinking();
    const finalPrompt = buildPrompt(
      promptWithContext,
      imagePaths || [],
      imageDir,
      scriptContext,
      documentPaths || [],
      documentDir,
      { includeFileInstructions: shouldIncludeFileInstructions }
    );
    const promptExpression = '"$AIPAL_PROMPT"';
    const threadIdExpression = threadId ? '"$AIPAL_THREAD_ID"' : undefined;
    const agentCmd = agent.buildCommand({
      prompt: finalPrompt,
      promptExpression,
      threadId,
      threadIdExpression,
      thinking,
      model: getGlobalModels()[effectiveAgentId],
    });
    let commandToRun = agentCmd;
    const execEnv = {
      ...process.env,
      AIPAL_PROMPT: finalPrompt,
      ...(threadId ? { AIPAL_THREAD_ID: threadId } : {}),
    };
    if (agent.needsPty) {
      execEnv.AIPAL_CMD = commandToRun;
      commandToRun = wrapCommandWithPty(commandToRun, 'AIPAL_CMD');
    }
    if (agent.mergeStderr) {
      commandToRun = `${commandToRun} 2>&1`;
    }

    if (onTokenUsage) {
      const accumulated = threadId ? (threadContextChars.get(threadKey) || 0) : 0;
      const inputTokens = Math.ceil((accumulated + finalPrompt.length) / 4);
      onTokenUsage({ chatId, topicId, inputTokens, outputTokens: 0, source });
    }

    const startedAt = Date.now();
    console.info(
      `Agent start chat=${chatId} topic=${topicId || 'root'} agent=${agent.id} thread=${threadId || 'new'}`
    );
    let output;
    let execError;
    try {
      output = await execLocal('bash', ['-lc', commandToRun], {
        timeout: agentTimeoutMs,
        maxBuffer: agentMaxBuffer,
        env: execEnv,
      });
    } catch (err) {
      execError = err;
      if (err && typeof err.stdout === 'string' && err.stdout.trim()) {
        output = err.stdout;
      } else {
        throw err;
      }
    } finally {
      const elapsedMs = Date.now() - startedAt;
      console.info(
        `Agent finished chat=${chatId} topic=${topicId || 'root'} durationMs=${elapsedMs}`
      );
    }
    const parsed = agent.parseOutput(output);
    if (execError && !parsed.sawJson && !String(parsed.text || '').trim()) {
      throw execError;
    }
    if (execError) {
      console.warn(
        `Agent exited non-zero; returning stdout chat=${chatId} topic=${topicId || 'root'} code=${execError.code || 'unknown'}`
      );
    }
    if (!parsed.threadId && typeof agent.listSessionsCommand === 'function') {
      try {
        const listCommand = agent.listSessionsCommand();
        let listCommandToRun = listCommand;
        if (agent.needsPty) {
          listCommandToRun = wrapCommandWithPty(listCommandToRun);
        }
        if (agent.mergeStderr) {
          listCommandToRun = `${listCommandToRun} 2>&1`;
        }
        const listOutput = await execLocal('bash', ['-lc', listCommandToRun], {
          timeout: agentTimeoutMs,
          maxBuffer: agentMaxBuffer,
        });
        if (typeof agent.parseSessionList === 'function') {
          const resolved = agent.parseSessionList(listOutput);
          if (resolved) {
            parsed.threadId = resolved;
          }
        }
      } catch (err) {
        console.warn('Failed to resolve agent session id:', err?.message || err);
      }
    }
    if (parsed.threadId) {
      threads.set(threadKey, parsed.threadId);
      persistThreads().catch((err) =>
        console.warn('Failed to persist threads:', err)
      );
    }
    const responseText = parsed.text || output || '';
    if (onTokenUsage) {
      const outputTokens = Math.ceil(responseText.length / 4);
      onTokenUsage({ chatId, topicId, inputTokens: 0, outputTokens, source });
    }
    threadContextChars.set(
      threadKey,
      (threadContextChars.get(threadKey) || 0) + finalPrompt.length + responseText.length
    );
    return parsed.text || output;
  }

  return {
    runAgentForChat,
    runAgentOneShot,
  };
}

module.exports = {
  createAgentRunner,
};

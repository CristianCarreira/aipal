const RETRIEVAL_CACHE_TTL_MS = 60000;

const STALE_SESSION_PATTERNS = [
  /no conversation found with session id/i,
  /session [\w-]+ not found/i,
  /invalid session/i,
  /conversation not found/i,
  /session has expired/i,
  /could not find session/i,
  /unknown session/i,
];

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
    threadMaxContextChars,
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

    let estimatedOneShotInput = 0;
    if (onTokenUsage) {
      estimatedOneShotInput = Math.ceil(promptText.length / 4);
      onTokenUsage({ chatId: 'oneshot', inputTokens: estimatedOneShotInput, outputTokens: 0, source: 'oneshot', agentId: agent.id });
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
      if (parsed.usage) {
        const inputCorrection = parsed.usage.inputTokens - estimatedOneShotInput;
        onTokenUsage({ chatId: 'oneshot', inputTokens: inputCorrection, outputTokens: parsed.usage.outputTokens, source: 'oneshot', costUsd: parsed.costUsd, agentId: agent.id });
      } else {
        const outputTokens = Math.ceil((parsed.text || output || '').length / 4);
        onTokenUsage({ chatId: 'oneshot', inputTokens: 0, outputTokens, source: 'oneshot', agentId: agent.id });
      }
    }
    return parsed.text || output;
  }

  async function runAgentForChat(chatId, prompt, runOptions = {}) {
    const { topicId, agentId: overrideAgentId, model: overrideModel, imagePaths, scriptContext, documentPaths, source: runSource, cwd, onOutput } =
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
    const contextSize = threadContextChars.get(threadKey) || 0;
    const turnLimitHit = threadRotationTurns > 0 && threadId && turnCount >= threadRotationTurns;
    const contextLimitHit = threadMaxContextChars > 0 && threadId && contextSize >= threadMaxContextChars;
    const unknownContext = threadMaxContextChars > 0 && threadId && !threadContextChars.has(threadKey);
    if (turnLimitHit || contextLimitHit || unknownContext) {
      const reason = unknownContext
        ? 'unknown context size (post-restart safety)'
        : contextLimitHit
          ? `context=${contextSize} chars (limit ${threadMaxContextChars})`
          : `turns=${turnCount}`;
      console.info(
        `Thread rotation: resetting thread chat=${chatId} topic=${topicId || 'root'} ${reason}`
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

    const shouldIncludeInstructions =
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
    if (prompt.trim().length >= 15) {
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
      { includeFileInstructions: shouldIncludeInstructions, includeStyleInstructions: shouldIncludeInstructions }
    );
    const promptExpression = '"$AIPAL_PROMPT"';
    const threadIdExpression = threadId ? '"$AIPAL_THREAD_ID"' : undefined;
    const agentCmd = agent.buildCommand({
      prompt: finalPrompt,
      promptExpression,
      threadId,
      threadIdExpression,
      thinking,
      model: overrideModel || getGlobalModels()[effectiveAgentId],
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

    let estimatedInputTokens = 0;
    if (onTokenUsage) {
      const accumulated = threadId ? (threadContextChars.get(threadKey) || 0) : 0;
      estimatedInputTokens = Math.ceil((accumulated + finalPrompt.length) / 4);
      onTokenUsage({ chatId, topicId, inputTokens: estimatedInputTokens, outputTokens: 0, source, agentId: agent.id });
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
        cwd,
        onData: onOutput,
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
    let parsed = agent.parseOutput(output);

    // Detect stale session and retry without --resume
    // Check both raw output (for exec errors) and parsed text (for PTY-wrapped runs where exit code is masked)
    const staleCheckText = String(parsed.text || '') + '\n' + String(output || '') + '\n' + String(execError?.stderr || '');
    const isStaleSession = threadId && !parsed.sawJson && STALE_SESSION_PATTERNS.some((re) => re.test(staleCheckText));
    if (isStaleSession) {
        console.warn(
          `Stale session detected chat=${chatId} topic=${topicId || 'root'} threadId=${threadId}; retrying without resume`
        );
        threads.delete(threadKey);
        threadTurns.set(threadKey, 1);
        threadContextChars.delete(threadKey);
        persistThreads().catch((err) =>
          console.warn('Failed to persist threads after stale session cleanup:', err)
        );

        // Rebuild prompt with bootstrap context (since we're starting fresh)
        let retryPrompt = prompt;
        if (agent.id === 'claude') {
          retryPrompt = prefixTextWithTimestamp(retryPrompt, {
            timeZone: defaultTimeZone,
          });
        }
        const bootstrap = await buildBootstrapContext({ threadKey, compact: true });
        retryPrompt = retryPrompt
          ? `${bootstrap}\n\n${retryPrompt}`
          : bootstrap;

        if (prompt.trim().length >= 15) {
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
            retryPrompt = `${retryPrompt}\n\n${retrievalContext}`;
          }
        }

        const retryFinalPrompt = buildPrompt(
          retryPrompt,
          [],
          imageDir,
          undefined,
          [],
          documentDir,
          { includeFileInstructions: true, includeStyleInstructions: true }
        );
        const retryPromptExpression = '"$AIPAL_PROMPT"';
        const retryAgentCmd = agent.buildCommand({
          prompt: retryFinalPrompt,
          promptExpression: retryPromptExpression,
          threadId: undefined,
          thinking,
          model: overrideModel || getGlobalModels()[effectiveAgentId],
        });
        let retryCommandToRun = retryAgentCmd;
        const retryExecEnv = { ...process.env, AIPAL_PROMPT: retryFinalPrompt };
        if (agent.needsPty) {
          retryExecEnv.AIPAL_CMD = retryCommandToRun;
          retryCommandToRun = wrapCommandWithPty(retryCommandToRun, 'AIPAL_CMD');
        }
        if (agent.mergeStderr) {
          retryCommandToRun = `${retryCommandToRun} 2>&1`;
        }

        console.info(
          `Agent retry start chat=${chatId} topic=${topicId || 'root'} agent=${agent.id} thread=new`
        );
        const retryStartedAt = Date.now();
        execError = undefined;
        try {
          output = await execLocal('bash', ['-lc', retryCommandToRun], {
            timeout: agentTimeoutMs,
            maxBuffer: agentMaxBuffer,
            env: retryExecEnv,
            cwd,
            onData: onOutput,
          });
        } catch (retryErr) {
          execError = retryErr;
          if (retryErr && typeof retryErr.stdout === 'string' && retryErr.stdout.trim()) {
            output = retryErr.stdout;
          } else {
            throw retryErr;
          }
        } finally {
          const elapsedMs = Date.now() - retryStartedAt;
          console.info(
            `Agent retry finished chat=${chatId} topic=${topicId || 'root'} durationMs=${elapsedMs}`
          );
        }
        parsed = agent.parseOutput(output);
        threadId = undefined;
    }

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
          cwd,
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
      if (parsed.usage) {
        // Real token data from CLI — correct the phase-1 estimate
        const inputCorrection = parsed.usage.inputTokens - estimatedInputTokens;
        onTokenUsage({ chatId, topicId, inputTokens: inputCorrection, outputTokens: parsed.usage.outputTokens, source, costUsd: parsed.costUsd, agentId: agent.id });
      } else {
        // Fallback to estimation
        const outputTokens = Math.ceil(responseText.length / 4);
        onTokenUsage({ chatId, topicId, inputTokens: 0, outputTokens, source, agentId: agent.id });
      }
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

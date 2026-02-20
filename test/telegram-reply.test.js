const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createTelegramReplyService } = require('../src/services/telegram-reply');

test('replyWithResponse sends formatted text chunk', async () => {
  const replies = [];
  const ctx = {
    reply: async (text, options) => {
      replies.push({ text, options });
    },
    replyWithPhoto: async () => {},
    replyWithDocument: async () => {},
  };

  const service = createTelegramReplyService({
    bot: { telegram: {} },
    chunkMarkdown: () => ['Hello'],
    chunkText: () => [],
    documentDir: '/tmp/docs',
    extractDocumentTokens: () => ({ cleanedText: 'Hello', documentPaths: [] }),
    extractImageTokens: () => ({ cleanedText: 'Hello', imagePaths: [] }),
    formatError: () => '',
    imageDir: '/tmp/images',
    isPathInside: () => true,
    markdownToTelegramHtml: () => '<b>Hello</b>',
  });

  await service.replyWithResponse(ctx, 'ignored');

  assert.equal(replies.length, 1);
  assert.equal(replies[0].text, '<b>Hello</b>');
  assert.equal(replies[0].options.parse_mode, 'HTML');
});

test('replyWithResponse sends only in-scope attachments', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aipal-reply-'));
  const imageDir = path.join(tmp, 'images');
  const documentDir = path.join(tmp, 'documents');
  await fs.mkdir(imageDir, { recursive: true });
  await fs.mkdir(documentDir, { recursive: true });

  const insideImage = path.join(imageDir, 'in.png');
  const insideDoc = path.join(documentDir, 'in.pdf');
  const outsideImage = path.join(tmp, 'out.png');
  const outsideDoc = path.join(tmp, 'out.pdf');
  await fs.writeFile(insideImage, 'img');
  await fs.writeFile(insideDoc, 'doc');

  const sentPhotos = [];
  const sentDocs = [];
  const fallbackReplies = [];

  const ctx = {
    reply: async (text) => {
      fallbackReplies.push(text);
    },
    replyWithPhoto: async (payload) => {
      sentPhotos.push(payload.source);
    },
    replyWithDocument: async (payload) => {
      sentDocs.push(payload.source);
    },
  };

  const service = createTelegramReplyService({
    bot: { telegram: {} },
    chunkMarkdown: () => [],
    chunkText: () => [],
    documentDir,
    extractDocumentTokens: () => ({
      cleanedText: '',
      documentPaths: [insideDoc, outsideDoc],
    }),
    extractImageTokens: () => ({
      cleanedText: '',
      imagePaths: [insideImage, outsideImage],
    }),
    formatError: () => '',
    imageDir,
    isPathInside: (base, target) => target.startsWith(base + path.sep),
    markdownToTelegramHtml: () => '',
  });

  await service.replyWithResponse(ctx, 'ignored');

  assert.deepEqual(sentPhotos, [insideImage]);
  assert.deepEqual(sentDocs, [insideDoc]);
  assert.equal(fallbackReplies.length, 0);
});

test('sendResponseToChat preserves topicId in telegram sendMessage', async () => {
  const sentMessages = [];

  const service = createTelegramReplyService({
    bot: {
      telegram: {
        sendDocument: async () => {},
        sendMessage: async (chatId, text, options) => {
          sentMessages.push({ chatId, text, options });
        },
        sendPhoto: async () => {},
      },
    },
    chunkMarkdown: () => ['part-1', 'part-2'],
    chunkText: () => [],
    documentDir: '/tmp/docs',
    extractDocumentTokens: () => ({ cleanedText: 'content', documentPaths: [] }),
    extractImageTokens: () => ({ cleanedText: 'content', imagePaths: [] }),
    formatError: () => '',
    imageDir: '/tmp/images',
    isPathInside: () => true,
    markdownToTelegramHtml: (value) => value,
  });

  await service.sendResponseToChat(123, 'ignored', { topicId: 99 });

  assert.equal(sentMessages.length, 2);
  assert.equal(sentMessages[0].options.message_thread_id, 99);
  assert.equal(sentMessages[1].options.message_thread_id, 99);
});

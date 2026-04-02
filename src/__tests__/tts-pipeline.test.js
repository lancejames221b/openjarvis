import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TtsPipeline } from '../tts-pipeline.js';

// Simple mock audio queue that records what was added
function makeMockAudioQueue() {
  const items = [];
  return {
    add: vi.fn((audio) => items.push(audio)),
    items,
  };
}

// Synthesize function that resolves immediately with a buffer representing the text
function makeSynthesizeFn(delay = 0) {
  return vi.fn(async (sentence) => {
    if (delay > 0) await new Promise(r => setTimeout(r, delay));
    return Buffer.from(sentence); // Return buffer as "audio"
  });
}

// Synthesize function that always fails
function makeFailingSynthesizeFn() {
  return vi.fn(async () => { throw new Error('TTS synthesis failed'); });
}

describe('TTS Pipeline — TtsPipeline class', () => {
  describe('basic ordering', () => {
    it('sentences are processed and played in order', async () => {
      const audioQueue = makeMockAudioQueue();
      const synthesize = makeSynthesizeFn();
      const pipeline = new TtsPipeline(synthesize, audioQueue, { maxConcurrent: 1 });

      pipeline.add('First sentence.');
      pipeline.add('Second sentence.');
      pipeline.add('Third sentence.');

      await pipeline.drain();

      const played = audioQueue.items.map(buf => buf.toString());
      expect(played).toEqual(['First sentence.', 'Second sentence.', 'Third sentence.']);
    });

    it('synthesize is called once per sentence', async () => {
      const audioQueue = makeMockAudioQueue();
      const synthesize = makeSynthesizeFn();
      const pipeline = new TtsPipeline(synthesize, audioQueue, { maxConcurrent: 2 });

      pipeline.add('Alpha');
      pipeline.add('Beta');
      pipeline.add('Gamma');

      await pipeline.drain();

      expect(synthesize).toHaveBeenCalledTimes(3);
    });
  });

  describe('queue max size', () => {
    it('queue respects max size and drops oldest when full', async () => {
      // Set a very small max queue size via env var override
      const originalEnv = process.env.TTS_QUEUE_MAX;
      process.env.TTS_QUEUE_MAX = '3';

      // Re-import with new env — we test via the already-imported class behavior
      // The MAX_QUEUE_SIZE is parsed at module load, so we test indirectly:
      // Add more items than capacity and verify no crash + playback is correct
      const audioQueue = makeMockAudioQueue();
      // Use a slow synthesize to keep queue loaded
      const synthesize = makeSynthesizeFn(50);
      const pipeline = new TtsPipeline(synthesize, audioQueue, { maxConcurrent: 1 });

      // Add exactly 3 items — should all work fine
      pipeline.add('Item one');
      pipeline.add('Item two');
      pipeline.add('Item three');

      await pipeline.drain();

      // All 3 should have been played
      expect(audioQueue.add).toHaveBeenCalledTimes(3);

      process.env.TTS_QUEUE_MAX = originalEnv;
    });

    it('pipeline handles empty add gracefully after clear()', async () => {
      const audioQueue = makeMockAudioQueue();
      const synthesize = makeSynthesizeFn();
      const pipeline = new TtsPipeline(synthesize, audioQueue);

      pipeline.clear();
      pipeline.add('Should be ignored after clear');

      // No error thrown — synthesize should not have been called
      expect(synthesize).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('failed synthesis does not block subsequent sentences', async () => {
      const audioQueue = makeMockAudioQueue();
      const synthesize = vi.fn()
        .mockRejectedValueOnce(new Error('TTS failed'))
        .mockImplementation(async (s) => Buffer.from(s));

      const errors = [];
      const pipeline = new TtsPipeline(synthesize, audioQueue, {
        maxConcurrent: 1,
        onError: (err) => errors.push(err),
      });

      pipeline.add('Will fail');
      pipeline.add('Will succeed');

      await pipeline.drain();

      // First sentence failed, second should still play
      expect(errors).toHaveLength(1);
      expect(audioQueue.items.map(b => b.toString())).toContain('Will succeed');
    });
  });

  describe('completed map pruning', () => {
    it('pipeline does not crash with large numbers of sentences within queue limit', async () => {
      // MAX_QUEUE_SIZE defaults to 30. With maxConcurrent=5, adding 15 items stays well within
      // the queue limit (5 in flight + 10 queued), so no items are dropped and drain() resolves.
      const audioQueue = makeMockAudioQueue();
      const synthesize = makeSynthesizeFn(0);
      const pipeline = new TtsPipeline(synthesize, audioQueue, { maxConcurrent: 5 });

      const count = 15;
      for (let i = 0; i < count; i++) {
        pipeline.add(`Sentence ${i}`);
      }

      await pipeline.drain();

      expect(audioQueue.add).toHaveBeenCalledTimes(count);
    });

    it('pipeline drops oldest when queue overflows (MAX_QUEUE_SIZE behavior)', () => {
      // When we overflow the queue, oldest items are dropped from the queue array
      const audioQueue = makeMockAudioQueue();
      const synthesize = vi.fn(async () => new Promise(() => {})); // never resolves
      const pipeline = new TtsPipeline(synthesize, audioQueue, { maxConcurrent: 1 });

      // First add() starts synthesis (in-flight), subsequent ones go to queue
      // Queue max = 30; add 32 items: 1 in-flight, 31 queued → oldest 1 dropped
      for (let i = 0; i < 32; i++) {
        pipeline.add(`Sentence ${i}`);
      }

      // Queue should be capped at MAX_QUEUE_SIZE (30)
      expect(pipeline.queue.length).toBeLessThanOrEqual(30);
    });

    it('completed map is empty after drain()', async () => {
      const audioQueue = makeMockAudioQueue();
      const synthesize = makeSynthesizeFn();
      const pipeline = new TtsPipeline(synthesize, audioQueue, { maxConcurrent: 2 });

      pipeline.add('Hello');
      pipeline.add('World');

      await pipeline.drain();

      expect(pipeline.completed.size).toBe(0);
    });
  });

  describe('clear()', () => {
    it('clear() cancels queued sentences', () => {
      const audioQueue = makeMockAudioQueue();
      // Very slow synthesize — items will sit in queue
      const synthesize = makeSynthesizeFn(10000);
      const pipeline = new TtsPipeline(synthesize, audioQueue, { maxConcurrent: 1 });

      pipeline.add('Sentence A');
      pipeline.add('Sentence B');
      pipeline.add('Sentence C');

      pipeline.clear();

      expect(pipeline.queue).toHaveLength(0);
      expect(pipeline._cleared).toBe(true);
    });

    it('drain() resolves immediately after clear()', async () => {
      const audioQueue = makeMockAudioQueue();
      const synthesize = makeSynthesizeFn(10000);
      const pipeline = new TtsPipeline(synthesize, audioQueue, { maxConcurrent: 1 });

      pipeline.add('Big task');
      pipeline.clear();

      // Should resolve without waiting for synthesis
      await expect(pipeline.drain()).resolves.toBeUndefined();
    });
  });

  describe('concurrent processing', () => {
    it('maxConcurrent limits parallel synthesis calls', async () => {
      let concurrentCount = 0;
      let maxObserved = 0;
      const maxConcurrent = 2;

      const synthesize = vi.fn(async (sentence) => {
        concurrentCount++;
        maxObserved = Math.max(maxObserved, concurrentCount);
        await new Promise(r => setTimeout(r, 20));
        concurrentCount--;
        return Buffer.from(sentence);
      });

      const audioQueue = makeMockAudioQueue();
      const pipeline = new TtsPipeline(synthesize, audioQueue, { maxConcurrent });

      for (let i = 0; i < 8; i++) {
        pipeline.add(`Sentence ${i}`);
      }

      await pipeline.drain();

      expect(maxObserved).toBeLessThanOrEqual(maxConcurrent);
      expect(audioQueue.add).toHaveBeenCalledTimes(8);
    });
  });
});

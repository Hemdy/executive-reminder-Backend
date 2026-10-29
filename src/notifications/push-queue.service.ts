import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis as UpstashRedis } from '@upstash/redis';
import Redis from 'ioredis';

export interface PushJob {
  id: string;
  notificationId: string;
  attempt: number;
  maxAttempts: number;
  createdAt: number;
  scheduledFor?: number;
  lastError?: string;
}

export interface QueueStats {
  pending: number;
  retry: number;
  dlq: number;
  provider: 'upstash' | 'redis' | 'memory';
}

@Injectable()
export class PushQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(PushQueueService.name);
  private readonly upstash?: UpstashRedis;
  private readonly ioredis?: Redis;
  private readonly memoryQueue: PushJob[] = [];
  private readonly memoryRetry: PushJob[] = [];
  private readonly memoryDlq: PushJob[] = [];
  private readonly memoryLocks = new Map<string, number>();
  private readonly provider: 'upstash' | 'redis' | 'memory';

  private readonly QUEUE_KEY = 'push:queue:pending';
  private readonly RETRY_KEY = 'push:queue:retry';
  private readonly DLQ_KEY = 'push:queue:dlq';
  private readonly LOCK_PREFIX = 'push:lock:';

  constructor(private readonly config: ConfigService) {
    const upstashUrl = this.config.get<string>('UPSTASH_REDIS_REST_URL');
    const upstashToken = this.config.get<string>('UPSTASH_REDIS_REST_TOKEN');
    const redisUrl = this.config.get<string>('REDIS_URL');

    if (upstashUrl && upstashToken) {
      try {
        this.upstash = new UpstashRedis({ url: upstashUrl, token: upstashToken });
        this.provider = 'upstash';
        this.logger.log('PushQueueService initialized with Upstash Redis (REST mode)');
      } catch (err) {
        this.logger.error('Failed to initialize Upstash Redis, falling back to memory queue', err);
        this.provider = 'memory';
      }
    } else if (redisUrl) {
      try {
        this.ioredis = new Redis(redisUrl, {
          lazyConnect: true,
          maxRetriesPerRequest: 2,
          retryStrategy: times => (times > 3 ? null : Math.min(times * 100, 1000)),
        });
        this.ioredis.connect().catch(err => {
          this.logger.warn(`Could not connect to Redis at ${redisUrl}, falling back to memory queue: ${err.message}`);
        });
        this.provider = 'redis';
        this.logger.log('PushQueueService initialized with standard Redis (ioredis)');
      } catch (err) {
        this.logger.error('Failed to initialize ioredis, falling back to memory queue', err);
        this.provider = 'memory';
      }
    } else {
      this.provider = 'memory';
      this.logger.warn(
        'Neither UPSTASH_REDIS_REST_URL nor REDIS_URL is configured. PushQueueService is running in in-memory fallback mode.',
      );
    }
  }

  onModuleDestroy() {
    if (this.ioredis) {
      this.ioredis.disconnect();
    }
  }

  getProvider(): 'upstash' | 'redis' | 'memory' {
    return this.provider;
  }

  async enqueue(notificationId: string): Promise<PushJob> {
    const job: PushJob = {
      id: `job_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      notificationId,
      attempt: 0,
      maxAttempts: 3,
      createdAt: Date.now(),
    };

    if (this.provider === 'upstash' && this.upstash) {
      try {
        await this.upstash.rpush(this.QUEUE_KEY, JSON.stringify(job));
        return job;
      } catch (err) {
        this.logger.error('Upstash rpush failed, enqueuing to memory fallback', err);
      }
    } else if (this.provider === 'redis' && this.ioredis && this.ioredis.status === 'ready') {
      try {
        await this.ioredis.rpush(this.QUEUE_KEY, JSON.stringify(job));
        return job;
      } catch (err) {
        this.logger.error('ioredis rpush failed, enqueuing to memory fallback', err);
      }
    }

    this.memoryQueue.push(job);
    return job;
  }

  async popJob(): Promise<PushJob | null> {
    // 1. First check if any scheduled retry jobs are now due
    await this.moveDueRetriesToQueue();

    if (this.provider === 'upstash' && this.upstash) {
      try {
        const raw = await this.upstash.lpop<string>(this.QUEUE_KEY);
        if (raw) {
          return typeof raw === 'string' ? JSON.parse(raw) : (raw as PushJob);
        }
      } catch (err) {
        this.logger.error('Upstash lpop failed', err);
      }
    } else if (this.provider === 'redis' && this.ioredis && this.ioredis.status === 'ready') {
      try {
        const raw = await this.ioredis.lpop(this.QUEUE_KEY);
        if (raw) {
          return JSON.parse(raw) as PushJob;
        }
      } catch (err) {
        this.logger.error('ioredis lpop failed', err);
      }
    }

    return this.memoryQueue.shift() ?? null;
  }

  async scheduleRetry(job: PushJob, delaySeconds: number, reason: string): Promise<void> {
    const nextJob: PushJob = {
      ...job,
      attempt: job.attempt + 1,
      scheduledFor: Date.now() + delaySeconds * 1000,
      lastError: reason,
    };

    this.logger.log(
      `Scheduling retry #${nextJob.attempt} for notification ${job.notificationId} in ${delaySeconds}s (reason: ${reason})`,
    );

    if (this.provider === 'upstash' && this.upstash) {
      try {
        await this.upstash.zadd(this.RETRY_KEY, {
          score: nextJob.scheduledFor!,
          member: JSON.stringify(nextJob),
        });
        return;
      } catch (err) {
        this.logger.error('Upstash zadd failed for retry scheduling', err);
      }
    } else if (this.provider === 'redis' && this.ioredis && this.ioredis.status === 'ready') {
      try {
        await this.ioredis.zadd(this.RETRY_KEY, nextJob.scheduledFor!, JSON.stringify(nextJob));
        return;
      } catch (err) {
        this.logger.error('ioredis zadd failed for retry scheduling', err);
      }
    }

    this.memoryRetry.push(nextJob);
  }

  async sendToDlq(job: PushJob, reason: string): Promise<void> {
    const dlqJob: PushJob = {
      ...job,
      lastError: reason,
      scheduledFor: undefined,
    };

    this.logger.warn(`Moving notification ${job.notificationId} to DLQ. Reason: ${reason}`);

    if (this.provider === 'upstash' && this.upstash) {
      try {
        await this.upstash.rpush(this.DLQ_KEY, JSON.stringify(dlqJob));
        return;
      } catch (err) {
        this.logger.error('Upstash rpush failed for DLQ', err);
      }
    } else if (this.provider === 'redis' && this.ioredis && this.ioredis.status === 'ready') {
      try {
        await this.ioredis.rpush(this.DLQ_KEY, JSON.stringify(dlqJob));
        return;
      } catch (err) {
        this.logger.error('ioredis rpush failed for DLQ', err);
      }
    }

    this.memoryDlq.push(dlqJob);
  }

  async acquireLock(key: string, ttlSeconds = 86400): Promise<boolean> {
    const fullKey = `${this.LOCK_PREFIX}${key}`;

    if (this.provider === 'upstash' && this.upstash) {
      try {
        const result = await this.upstash.set(fullKey, '1', {
          nx: true,
          ex: ttlSeconds,
        });
        return result === 'OK';
      } catch (err) {
        this.logger.error('Upstash lock acquisition failed', err);
      }
    } else if (this.provider === 'redis' && this.ioredis && this.ioredis.status === 'ready') {
      try {
        const result = await this.ioredis.set(fullKey, '1', 'EX', ttlSeconds, 'NX');
        return result === 'OK';
      } catch (err) {
        this.logger.error('ioredis lock acquisition failed', err);
      }
    }

    const now = Date.now();
    const existing = this.memoryLocks.get(fullKey);
    if (existing && existing > now) {
      return false;
    }
    this.memoryLocks.set(fullKey, now + ttlSeconds * 1000);
    return true;
  }

  async releaseLock(key: string): Promise<void> {
    const fullKey = `${this.LOCK_PREFIX}${key}`;

    if (this.provider === 'upstash' && this.upstash) {
      try {
        await this.upstash.del(fullKey);
      } catch (err) {
        this.logger.error('Upstash lock release failed', err);
      }
    } else if (this.provider === 'redis' && this.ioredis && this.ioredis.status === 'ready') {
      try {
        await this.ioredis.del(fullKey);
      } catch (err) {
        this.logger.error('ioredis lock release failed', err);
      }
    }

    this.memoryLocks.delete(fullKey);
  }

  async getDlqJobs(limit = 50): Promise<PushJob[]> {
    if (this.provider === 'upstash' && this.upstash) {
      try {
        const items = await this.upstash.lrange<string>(this.DLQ_KEY, 0, limit - 1);
        return items.map(item => (typeof item === 'string' ? JSON.parse(item) : item));
      } catch (err) {
        this.logger.error('Upstash getDlqJobs failed', err);
      }
    } else if (this.provider === 'redis' && this.ioredis && this.ioredis.status === 'ready') {
      try {
        const items = await this.ioredis.lrange(this.DLQ_KEY, 0, limit - 1);
        return items.map(item => JSON.parse(item));
      } catch (err) {
        this.logger.error('ioredis getDlqJobs failed', err);
      }
    }

    return this.memoryDlq.slice(0, limit);
  }

  async getQueueStats(): Promise<QueueStats> {
    let pending = 0;
    let retry = 0;
    let dlq = 0;

    if (this.provider === 'upstash' && this.upstash) {
      try {
        [pending, retry, dlq] = await Promise.all([
          this.upstash.llen(this.QUEUE_KEY),
          this.upstash.zcard(this.RETRY_KEY),
          this.upstash.llen(this.DLQ_KEY),
        ]);
        return { pending, retry, dlq, provider: 'upstash' };
      } catch (err) {
        this.logger.error('Failed to get Upstash stats', err);
      }
    } else if (this.provider === 'redis' && this.ioredis && this.ioredis.status === 'ready') {
      try {
        [pending, retry, dlq] = await Promise.all([
          this.ioredis.llen(this.QUEUE_KEY),
          this.ioredis.zcard(this.RETRY_KEY),
          this.ioredis.llen(this.DLQ_KEY),
        ]);
        return { pending, retry, dlq, provider: 'redis' };
      } catch (err) {
        this.logger.error('Failed to get ioredis stats', err);
      }
    }

    return {
      pending: this.memoryQueue.length,
      retry: this.memoryRetry.length,
      dlq: this.memoryDlq.length,
      provider: 'memory',
    };
  }

  private async moveDueRetriesToQueue(): Promise<void> {
    const now = Date.now();

    if (this.provider === 'upstash' && this.upstash) {
      try {
        const dueMembers = await this.upstash.zrange<string[]>(
          this.RETRY_KEY,
          0,
          now,
          { byScore: true, offset: 0, count: 50 },
        );
        if (dueMembers && dueMembers.length > 0) {
          for (const member of dueMembers) {
            await this.upstash.zrem(this.RETRY_KEY, member);
            await this.upstash.rpush(this.QUEUE_KEY, member);
          }
        }
      } catch (err) {
        this.logger.error('Failed to move Upstash due retries to pending queue', err);
      }
    } else if (this.provider === 'redis' && this.ioredis && this.ioredis.status === 'ready') {
      try {
        const dueMembers = await this.ioredis.zrangebyscore(this.RETRY_KEY, 0, now, 'LIMIT', 0, 50);
        if (dueMembers && dueMembers.length > 0) {
          const pipeline = this.ioredis.pipeline();
          for (const member of dueMembers) {
            pipeline.zrem(this.RETRY_KEY, member);
            pipeline.rpush(this.QUEUE_KEY, member);
          }
          await pipeline.exec();
        }
      } catch (err) {
        this.logger.error('Failed to move ioredis due retries to pending queue', err);
      }
    }

    const dueMemory = this.memoryRetry.filter(j => (j.scheduledFor ?? 0) <= now);
    for (const job of dueMemory) {
      const idx = this.memoryRetry.indexOf(job);
      if (idx !== -1) {
        this.memoryRetry.splice(idx, 1);
        this.memoryQueue.push(job);
      }
    }
  }
}
